const https = require('https');

// We will pass the code as a command line argument
const code = process.argv[2];
const clientId = 'be1f01e889c741fd9427e4895205b8ea';
const clientSecret = 'c6dbf26d1a16421399ffe3341192058e';
const redirectUri = 'http://127.0.0.1:3000/callback';

if (!code) {
  console.log('\x1b[31m%s\x1b[0m', 'Error: You forgot to paste the code!');
  console.log('Usage: node get-token.js YOUR_CODE_HERE');
  process.exit(1);
}

const body = new URLSearchParams({
  grant_type: 'authorization_code',
  code: code,
  redirect_uri: redirectUri,
  client_id: clientId,
  client_secret: clientSecret
}).toString();

const options = {
  hostname: 'accounts.spotify.com',
  path: '/api/token',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (json.refresh_token) {
        console.log('\x1b[32m%s\x1b[0m', '\n✅ SUCCESS! HERE IS YOUR REFRESH TOKEN:\n');
        console.log('\x1b[33m%s\x1b[0m', json.refresh_token);
        console.log('\n\x1b[0mCopy the token above and put it in your .env file!\n');
      } else {
        console.log('\x1b[31m%s\x1b[0m', '\n❌ Error getting token:');
        console.log(json);
      }
    } catch(e) {
      console.log('Failed to parse response:', data);
    }
  });
});

req.on('error', (e) => console.error(e));
req.write(body);
req.end();