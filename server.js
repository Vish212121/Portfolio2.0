const express = require('express');
require('dotenv').config();

const app = express();
const PORT = 3000;

app.use(express.static(__dirname));

// ---- Cached Spotify access token (avoid re-authenticating on every poll) ----
let cachedToken = null;
let tokenExpiresAt = 0;

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

  const tokenRes = await fetchWithTimeout(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Failed to get access token');

  cachedToken = tokenData.access_token;
  // Refresh 60s before actual expiry to be safe
  const expiresIn = tokenData.expires_in || 3600;
  tokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;

  return cachedToken;
}

// Helper to fetch spotify data
async function getSpotifyData() {
  const access_token = await getAccessToken();
  const NOW_PLAYING_ENDPOINT = 'https://api.spotify.com/v1/me/player/currently-playing';
  const RECENTLY_PLAYED_ENDPOINT = 'https://api.spotify.com/v1/me/player/recently-played?limit=1';

  // 1. Try currently playing
  const nowPlayingRes = await fetchWithTimeout(NOW_PLAYING_ENDPOINT, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (nowPlayingRes.status === 401) {
    // Token got invalidated mid-flight (e.g. revoked) - force a fresh one next call
    cachedToken = null;
  }

  if (nowPlayingRes.status === 200) {
    const trackText = await nowPlayingRes.text();
    if (trackText) {
      const track = JSON.parse(trackText);
      if (track && track.item) {
        return {
          isPlaying: track.is_playing,
          track: track.item.name,
          artist: track.item.artists.map(a => a.name).join(', '),
          album: track.item.album.name,
          progress_ms: track.progress_ms || 0,
          duration_ms: track.item.duration_ms,
          device: track.device ? track.device.name : 'Unknown Device',
        };
      }
    }
  }

  // 2. Fallback to recently played
  const recentRes = await fetchWithTimeout(RECENTLY_PLAYED_ENDPOINT, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (recentRes.status === 200) {
    const recentText = await recentRes.text();
    if (recentText) {
      const recent = JSON.parse(recentText);
      if (recent.items && recent.items.length > 0) {
        const item = recent.items[0];
        const playedAt = new Date(item.played_at);
        const diffMs = Date.now() - playedAt.getTime();
        const minsAgo = Math.floor(diffMs / 60000);

        return {
          isPlaying: false,
          track: item.track.name,
          artist: item.track.artists.map(a => a.name).join(', '),
          album: item.track.album.name,
          // FIX: this was missing before, so any lyrics lookup for a paused/stopped
          // track had no duration to disambiguate with - only the live "currently
          // playing" branch above had it.
          duration_ms: item.track.duration_ms,
          played_ago: minsAgo > 60 ? `${Math.floor(minsAgo / 60)}h ago` : `${minsAgo}m ago`,
        };
      }
    }
  }

  return { isPlaying: false, error: 'No recent tracks found' };
}

app.get('/api/spotify', async (req, res) => {
  try {
    const data = await getSpotifyData();
    res.status(200).json(data);
  } catch (e) {
    console.error('Spotify API Error:', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---- Lyrics lookup ----
// In-memory cache so repeat requests for the same track don't hit external APIs again
const lyricsCache = new Map(); // key: "artist|track|duration" -> { synced, plain }

// Strip the noise that commonly breaks exact-match lookups on lrclib/lyrist
function cleanString(s) {
  return s
    // (feat. X) / (with X) / [feat. X] / [with X]
    .replace(/\s*[([](?:feat|ft|with)\.?[^)\]]*[)\]]/gi, '')
    // "(From "Movie Name")" / "(from the film X)" - common soundtrack tagging,
    // especially on Bollywood/OST releases
    .replace(/\s*\(from\s+[^)]*\)/gi, '')
    // standalone parenthetical version tags: "(Live)", "(Remastered)", "(Acoustic)" etc.
    .replace(/\s*\((?:live|remaster(?:ed)?|acoustic|instrumental|demo|mono|stereo|explicit|clean)\)\s*$/gi, '')
    // trailing " - <anything containing a version/edit keyword>" - the keyword can
    // appear anywhere after the dash, not just immediately following it, so this
    // catches both "Song - Remastered 2015" AND "Song - 2015 Remaster"
    .replace(/\s*-\s*[^-]*\b(remaster(?:ed)?|radio edit|live|mono|stereo|version|mix|bonus track|deluxe|explicit|extended|acoustic|instrumental|demo)\b[^-]*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Loose normalization for comparing names ("Beyoncé" ~ "beyonce", ignore punctuation/case)
function normalizeForCompare(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]/g, '');
}

// Pick the best candidate from a lrclib /api/search result list, requiring the
// artist to actually match - the search endpoint ranks by text relevance only,
// so an unvalidated top hit can be a cover or an unrelated same-titled track.
//
// FIX: title is matched FIRST now, duration only breaks ties between entries
// that already share a title. The old version filtered by duration before
// checking titles at all - if the correct entry had missing/bad duration data
// (common on a crowd-sourced DB) while a *different* same-artist track
// happened to have a similar duration, that wrong track would win, or the
// real match would get excluded entirely and the lookup would 404 even
// though the right lyrics were sitting right there in the results.
function pickBestSearchMatch(results, wantArtist, wantTrack, wantDurationSec) {
  const nArtist = normalizeForCompare(wantArtist);
  const nTrack = normalizeForCompare(wantTrack);

  const candidates = results.filter(r => {
    if (!r.syncedLyrics && !r.plainLyrics) return false;
    const rArtist = normalizeForCompare(r.artistName);
    return rArtist === nArtist || rArtist.includes(nArtist) || nArtist.includes(rArtist);
  });
  if (candidates.length === 0) return null;

  const exactTitle = candidates.filter(r => normalizeForCompare(r.trackName) === nTrack);
  const looseTitle = candidates.filter(r => {
    const rTrack = normalizeForCompare(r.trackName);
    return rTrack.includes(nTrack) || nTrack.includes(rTrack);
  });

  // Among entries that already match on title, prefer the one closest to the
  // known duration (handles "album version" vs "radio edit" style duplicates).
  // Falls back to the first entry when duration is unknown or missing.
  const byBestDuration = (pool) => {
    if (pool.length <= 1) return pool[0] || null;
    if (!wantDurationSec) return pool[0];
    return pool.reduce((best, r) => {
      const bestDiff = typeof best.duration === 'number' ? Math.abs(best.duration - wantDurationSec) : Infinity;
      const rDiff = typeof r.duration === 'number' ? Math.abs(r.duration - wantDurationSec) : Infinity;
      return rDiff < bestDiff ? r : best;
    }, pool[0]);
  };

  if (exactTitle.length > 0) return byBestDuration(exactTitle);
  if (looseTitle.length > 0) return byBestDuration(looseTitle);
  return null;
}

// Secure route to fetch lyrics (bypasses CORS issues)
app.get('/api/lyrics', async (req, res) => {
  try {
    let { artist, track, album } = req.query;
    let durationMs = req.query.duration_ms ? parseInt(req.query.duration_ms, 10) : null;
    if (!artist || !track) return res.status(400).json({ error: 'Missing params' });

    artist = cleanString(artist);
    track = cleanString(track);

    // lrclib's "exact" /api/get endpoint actually does FUZZY text matching under
    // the hood - with no duration to pin it down, an ambiguous or common title
    // can silently resolve to the wrong track. If the caller didn't supply
    // duration/album, pull them from what's actually playing right now, but only
    // trust that data if it's clearly the same artist/track we were asked about.
    // (Best fix for this is having the frontend just send duration_ms/album
    // directly, since it already has them from the /api/spotify poll - see the
    // note below the code.)
    if (!durationMs || !album) {
      try {
        const spotifyData = await getSpotifyData();
        if (spotifyData && !spotifyData.error) {
          const spArtist = normalizeForCompare(spotifyData.artist);
          const spTrack = normalizeForCompare(spotifyData.track);
          const wArtist = normalizeForCompare(artist);
          const wTrack = normalizeForCompare(track);
          const sameTrack = spArtist && spTrack &&
            (spArtist.includes(wArtist) || wArtist.includes(spArtist)) &&
            (spTrack.includes(wTrack) || wTrack.includes(spTrack));
          if (sameTrack) {
            if (!durationMs && spotifyData.duration_ms) durationMs = spotifyData.duration_ms;
            if (!album && spotifyData.album) album = spotifyData.album;
          }
        }
      } catch (e) {
        console.error('Could not enrich lyrics lookup with Spotify data:', e.message);
      }
    }

    album = album ? cleanString(album) : null;
    const durationSec = durationMs ? Math.round(durationMs / 1000) : null;
    const cacheKey = `${artist.toLowerCase()}|${track.toLowerCase()}|${durationSec || ''}`;

    if (lyricsCache.has(cacheKey)) {
      return res.status(200).json(lyricsCache.get(cacheKey));
    }

    // 1. Try lrclib.net /api/get - best accuracy when duration/album are included
    try {
      let getUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}`;
      if (album) getUrl += `&album_name=${encodeURIComponent(album)}`;
      if (durationSec) getUrl += `&duration=${durationSec}`;
      const getRes = await fetchWithTimeout(getUrl, {}, 5000);
      if (getRes.ok) {
        const data = await getRes.json();
        if (data.syncedLyrics || data.plainLyrics) {
          const result = { synced: data.syncedLyrics || null, plain: data.plainLyrics || null };
          lyricsCache.set(cacheKey, result);
          return res.status(200).json(result);
        }
      } else {
        console.log(`[lyrics] /api/get miss (${getRes.status}) for "${track}" - ${artist}`);
      }
    } catch (e) {
      console.error('lrclib get failed, falling back:', e.message);
    }

    // 2. Fall back to lrclib.net search using dedicated fields (more accurate than
    // a combined free-text query per lrclib's own docs), validated against
    // artist + duration so an irrelevant top-ranked hit can't slip through.
    try {
      const searchUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`;
      const searchRes = await fetchWithTimeout(searchUrl, {}, 5000);
      if (searchRes.ok) {
        const results = await searchRes.json();
        if (Array.isArray(results) && results.length > 0) {
          const best = pickBestSearchMatch(results, artist, track, durationSec);
          if (best) {
            const result = { synced: best.syncedLyrics || null, plain: best.plainLyrics || null };
            lyricsCache.set(cacheKey, result);
            return res.status(200).json(result);
          }
          console.log(`[lyrics] search returned ${results.length} result(s) for "${track}" - ${artist} but none matched artist/title`);
        } else {
          console.log(`[lyrics] search returned nothing for "${track}" - ${artist}`);
        }
      }
    } catch (e) {
      console.error('lrclib search failed, falling back:', e.message);
    }

    // 3. Fallback to lyrist.osar.fr (plain only) - last resort, no metadata to
    // validate against, so it's only reached once the two lrclib checks above
    // have already failed to find a confident match.
    try {
      const fallbackUrl = `https://lyrist.osar.fr/api/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
      const fallbackRes = await fetchWithTimeout(fallbackUrl, {}, 5000);
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        if (fallbackData.lyrics) {
          const result = { synced: null, plain: fallbackData.lyrics };
          lyricsCache.set(cacheKey, result);
          return res.status(200).json(result);
        }
      }
    } catch (e) {
      console.error('lyrist fallback failed:', e.message);
    }

    console.log(`[lyrics] no source had "${track}" - ${artist} (duration: ${durationSec ?? 'unknown'}s) - likely a real coverage gap`);
    res.status(404).json({ error: 'Lyrics not found' });
  } catch (e) {
    console.error('Lyrics fetch error:', e);
    res.status(500).json({ error: 'Lyrics: currently on vacation.' });
  }
});

// Helper to find the active Spotify device
async function getActiveDeviceId(access_token) {
  try {
    const devRes = await fetchWithTimeout('https://api.spotify.com/v1/me/player/devices', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (devRes.ok) {
      const devData = await devRes.json();
      // Look for an active device, or just use the first one available
      const activeDev = devData.devices.find(d => d.is_active);
      if (activeDev) return activeDev.id;
      if (devData.devices.length > 0) return devData.devices[0].id;
    }
  } catch (e) { console.error('Device fetch error:', e.message); }
  return null;
}

// Route to Play music
app.put('/api/spotify/play', async (req, res) => {
  try {
    const access_token = await getAccessToken();
    const deviceId = await getActiveDeviceId(access_token);
    const url = deviceId ? `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}` : 'https://api.spotify.com/v1/me/player/play';
    const playRes = await fetchWithTimeout(url, { method: 'PUT', headers: { Authorization: `Bearer ${access_token}` } });
    if (playRes.status === 404) return res.status(404).json({ error: 'No active device. Open Spotify on a device first.' });
    res.status(playRes.status).send();
  } catch (e) { res.status(500).json({ error: 'Failed to play' }); }
});

// Route to Pause music
app.put('/api/spotify/pause', async (req, res) => {
  try {
    const access_token = await getAccessToken();
    const deviceId = await getActiveDeviceId(access_token);
    const url = deviceId ? `https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}` : 'https://api.spotify.com/v1/me/player/pause';
    const pauseRes = await fetchWithTimeout(url, { method: 'PUT', headers: { Authorization: `Bearer ${access_token}` } });
    if (pauseRes.status === 404) return res.status(404).json({ error: 'No active device.' });
    res.status(pauseRes.status).send();
  } catch (e) { res.status(500).json({ error: 'Failed to pause' }); }
});



module.exports = app;
