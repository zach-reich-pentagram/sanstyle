#!/usr/bin/env node
// One-time helper: sign the Sanstyle site in as YOUR Google account.
//
//   node tools/get_refresh_token.mjs <OAUTH_CLIENT_ID> <OAUTH_CLIENT_SECRET>
//
// Prints a Google consent URL. Open it in the browser, signed in as the
// Google account that owns the two Drive folders, and approve. The browser
// comes back to this script, which prints GOOGLE_OAUTH_REFRESH_TOKEN for
// Vercel. Nothing is stored anywhere else. See SETUP-SYNC.md.
import http from 'node:http';

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('usage: node tools/get_refresh_token.mjs <OAUTH_CLIENT_ID> <OAUTH_CLIENT_SECRET>');
  process.exit(1);
}

const PORT = 53682;
const redirect = `http://localhost:${PORT}/`;
const consent = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive',
  access_type: 'offline',
  prompt: 'consent',
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirect);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('No code in the callback — start over.');
    return;
  }
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirect, grant_type: 'authorization_code',
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.refresh_token) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Token exchange failed: ' + JSON.stringify(data));
      console.error('Token exchange failed:', data);
      process.exitCode = 1;
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p style="font: 16px Helvetica, Arial">Sanstyle is signed in. You can close this tab and go back to the terminal.</p>');
      console.log('\nAdd these three environment variables in Vercel (all environments), then redeploy:\n');
      console.log('  GOOGLE_OAUTH_CLIENT_ID      = ' + clientId);
      console.log('  GOOGLE_OAUTH_CLIENT_SECRET  = ' + clientSecret);
      console.log('  GOOGLE_OAUTH_REFRESH_TOKEN  = ' + data.refresh_token + '\n');
    }
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Token exchange failed: ' + e.message);
    console.error(e);
    process.exitCode = 1;
  }
  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\nOpen this in a browser signed in as the Google account that owns the Drive folders:\n');
  console.log(consent + '\n');
  console.log('Waiting for Google to send the browser back here…');
});
