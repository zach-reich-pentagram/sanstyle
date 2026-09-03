/* Sanstyle — api/_lib.js
 * Shared helpers for the Vercel serverless routes: service-account JWT auth
 * against Google (no SDK — raw crypto + fetch), small Drive REST wrappers,
 * passcode enforcement, and request/response utilities that work both on
 * Vercel and under plain node:http (which is how the tests drive them).
 */
'use strict';
const crypto = require('crypto');

function env() {
  return {
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    key: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
    oauth: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
    },
    passcode: process.env.SANSTYLE_PASSCODE || '3754',
    inboxId: process.env.DRIVE_INBOX_FOLDER_ID || '1BNUkRRGWQsfPc5yoaia4rsuX8dUtli9s',
    libraryId: process.env.DRIVE_LIBRARY_FOLDER_ID || '1ckGGFq99lVayKplwzDKm3SQsY28o2_uU',
  };
}

// How the site talks to Drive:
//  'user'    — as your own Google account, through an OAuth refresh token.
//              Files it creates are yours. Works with a personal Gmail.
//  'service' — as a service account. Google no longer lets a service account
//              own files in a personal My Drive ("Service Accounts do not
//              have storage quota"), so with this mode the folders must live
//              in a Shared Drive (Google Workspace).
function authMode() {
  const e = env();
  if (e.oauth.clientId && e.oauth.clientSecret && e.oauth.refreshToken) return 'user';
  if (e.email && e.key) return 'service';
  return null;
}

function configured() {
  return !!authMode();
}

// ---------- responses ----------
function send(res, code, data, headers) {
  res.statusCode = code;
  if (headers) for (const k in headers) res.setHeader(k, headers[k]);
  if (data === null || data === undefined) return res.end();
  if (Buffer.isBuffer(data)) return res.end(data);
  if (typeof data === 'object') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(data));
  }
  return res.end(String(data));
}

async function readBody(req, limit) {
  const max = limit || 6 * 1024 * 1024;
  // Vercel's Node runtime may have already consumed the stream and exposed
  // the result as req.body (Buffer, string, or parsed JSON). Prefer that;
  // fall back to reading the stream (plain node:http, local dev, tests).
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body);
    if (typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body));
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > max) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requirePass(req, res) {
  const given = String(req.headers['x-sanstyle-pass'] || '');
  const want = env().passcode;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    send(res, 401, { error: 'bad passcode' });
    return false;
  }
  return true;
}

// ---------- Google service-account auth ----------
let tokenCache = { token: null, exp: 0 };

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildAssertion(e, nowSec) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: e.email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const unsigned = header + '.' + claims;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(e.key);
  return unsigned + '.' + b64url(sig);
}

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 120 > now) return tokenCache.token;
  const e = env();
  const params = authMode() === 'user'
    ? {
      grant_type: 'refresh_token',
      client_id: e.oauth.clientId,
      client_secret: e.oauth.clientSecret,
      refresh_token: e.oauth.refreshToken,
    }
    : {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildAssertion(e, now),
    };
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!resp.ok) throw new Error('google token exchange failed: ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.token;
}

function resetTokenCache() { tokenCache = { token: null, exp: 0 }; }

// ---------- Drive REST ----------
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

async function driveFetch(url, opts) {
  const token = await getToken();
  const resp = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ authorization: 'Bearer ' + token }, (opts && opts.headers) || {}),
  }));
  if (!resp.ok) {
    throw new Error(`drive ${(opts && opts.method) || 'GET'} ${url.slice(0, 90)} → ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return resp;
}

async function driveList(q, fields) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q,
      fields: `nextPageToken, files(${fields || 'id, name, mimeType, createdTime, size, md5Checksum'})`,
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await (await driveFetch(`${API}/files?${params}`)).json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function driveMeta(id, fields) {
  const params = new URLSearchParams({ fields: fields || 'id, name, mimeType, parents, size', supportsAllDrives: 'true' });
  return (await driveFetch(`${API}/files/${encodeURIComponent(id)}?${params}`)).json();
}

async function driveDownload(id) {
  return driveFetch(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
}

function multipartBody(metadata, mime, content) {
  const boundary = 'sanstyle' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(content), tail]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

async function driveCreate(folderId, name, mime, content) {
  const { body, contentType } = multipartBody({ name, parents: [folderId] }, mime, content);
  const resp = await driveFetch(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  return resp.json();
}

async function driveUpdate(fileId, mime, content) {
  const { body, contentType } = multipartBody({}, mime, content);
  const resp = await driveFetch(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&supportsAllDrives=true&fields=id,name`, {
    method: 'PATCH',
    headers: { 'content-type': contentType },
    body,
  });
  return resp.json();
}

// Create-or-update by exact name within a folder.
async function driveUpsert(folderId, name, mime, content) {
  const safe = name.replace(/'/g, "\\'");
  const existing = await driveList(`name = '${safe}' and '${folderId}' in parents and trashed = false`, 'id, name');
  if (existing.length) return driveUpdate(existing[0].id, mime, content);
  return driveCreate(folderId, name, mime, content);
}

async function driveTrash(fileId) {
  await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

// SVG mirror filenames: "<label>__<variantId>.svg"
function svgIdFromName(name) {
  const m = /__([a-z0-9]+)\.svg$/i.exec(name || '');
  return m ? m[1] : null;
}

module.exports = {
  env, configured, authMode, send, readBody, requirePass,
  getToken, resetTokenCache, buildAssertion,
  driveList, driveMeta, driveDownload, driveCreate, driveUpdate, driveUpsert, driveTrash,
  svgIdFromName,
};
