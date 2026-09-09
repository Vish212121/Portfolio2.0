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

// Secure route to fetch lyrics (bypasses CORS issues)
app.get('/api/lyrics', async (req, res) => {
  try {
    const { artist, track } = req.query;
    if (!artist || !track) return res.status(400).json({ error: 'Missing params' });

    // 1. Try lrclib.net for synced lyrics
    const lrcUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}`;
    try {
      const lrcRes = await fetchWithTimeout(lrcUrl, {}, 5000);
      if (lrcRes.ok) {
        const lrcData = await lrcRes.json();
        // Only return early if we actually got usable lyrics - otherwise fall through
        if (lrcData && (lrcData.syncedLyrics || lrcData.plainLyrics)) {
          return res.status(200).json({
            synced: lrcData.syncedLyrics || null,
            plain: lrcData.plainLyrics || null,
          });
        }
      }
    } catch (e) {
      console.error('lrclib fetch failed, falling back:', e.message);
    }

    // 2. Fallback to lyrist.osar.fr (plain only)
    try {
      const fallbackUrl = `https://lyrist.osar.fr/api/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
      const fallbackRes = await fetchWithTimeout(fallbackUrl, {}, 5000);
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        if (fallbackData.lyrics) {
          return res.status(200).json({ synced: null, plain: fallbackData.lyrics });
        }
      }
    } catch (e) {
      console.error('lyrist fallback failed:', e.message);
    }

    res.status(404).json({ error: 'Lyrics not found' });
  } catch (e) {
    console.error('Lyrics fetch error:', e);
    res.status(500).json({ error: 'Failed to fetch lyrics' });
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



app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});