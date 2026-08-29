'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Readable } = require('stream');

// service-account env with a throwaway RSA key
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'robot@test.iam.gserviceaccount.com';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.SANSTYLE_PASSCODE = '3754';
process.env.DRIVE_INBOX_FOLDER_ID = 'INBOX123456';
process.env.DRIVE_LIBRARY_FOLDER_ID = 'LIB123456789';

const L = require('../api/_lib.js');
const libraryHandler = require('../api/library.js');
const inboxHandler = require('../api/inbox.js');
const photoHandler = require('../api/photo.js');
const uploadHandler = require('../api/upload.js');

function mockReq(method, url, headers, body) {
  const r = Readable.from(body ? [Buffer.isBuffer(body) ? body : Buffer.from(body)] : []);
  r.method = method;
  r.url = url;
  r.headers = Object.assign({ 'x-sanstyle-pass': '3754' }, headers || {});
  return r;
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(d) { if (d) this.chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)); this.done = true; },
    get body() { return Buffer.concat(this.chunks); },
    get json() { return JSON.parse(this.body.toString('utf8') || 'null'); },
  };
  return res;
}

// fetch stub: routes → handler(url, opts). Records calls.
let calls;
function stubFetch(routes) {
  calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
    for (const [pattern, fn] of routes) {
      if (u.includes(pattern)) {
        const out = await fn(u, opts || {});
        const buf = out.buffer || Buffer.alloc(0);
        return {
          ok: out.status ? out.status < 400 : true,
          status: out.status || 200,
          json: async () => out.json,
          text: async () => JSON.stringify(out.json || {}),
          // slice out of Buffer's shared pool slab
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      }
    }
    throw new Error('unstubbed fetch: ' + u);
  };
}

// URLSearchParams encodes spaces as '+'; undo both layers for readable matching.
function decodeQuery(u) {
  return decodeURIComponent(u.replace(/\+/g, ' '));
}

const tokenRoute = ['oauth2.googleapis.com/token', async (u, opts) => {
  const assertion = new URLSearchParams(opts.body.toString()).get('assertion');
  const [h, c, s] = assertion.split('.');
  const ok = crypto.createVerify('RSA-SHA256')
    .update(h + '.' + c)
    .verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.ok(ok, 'JWT assertion signature must verify against the public key');
  const claims = JSON.parse(Buffer.from(c, 'base64').toString());
  assert.strictEqual(claims.iss, 'robot@test.iam.gserviceaccount.com');
  assert.ok(claims.scope.includes('auth/drive'));
  return { json: { access_token: 'tok123', expires_in: 3600 } };
}];

beforeEach(() => L.resetTokenCache());

test('passcode is enforced (constant-time compare path)', async () => {
  const res = mockRes();
  await inboxHandler(mockReq('GET', '/api/inbox', { 'x-sanstyle-pass': 'wrong' }), res);
  assert.strictEqual(res.statusCode, 401);
});

test('inbox lists image files via an authenticated Drive call', async () => {
  stubFetch([
    tokenRoute,
    ['googleapis.com/drive/v3/files?', async (u, opts) => {
      assert.strictEqual(opts.headers.authorization, 'Bearer tok123');
      assert.ok(decodeQuery(u).includes("'INBOX123456' in parents"));
      return {
        json: {
          files: [
            { id: 'ph_aaaaaaaaaa', name: 'wall1.jpg', mimeType: 'image/jpeg', createdTime: '2026-08-30T01:00:00Z' },
            { id: 'ph_bbbbbbbbbb', name: 'wall2.heic', mimeType: 'image/heic', createdTime: '2026-08-31T01:00:00Z' },
          ],
        },
      };
    }],
  ]);
  const res = mockRes();
  await inboxHandler(mockReq('GET', '/api/inbox'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json.photos.length, 2);
  assert.strictEqual(res.json.photos[0].name, 'wall2.heic', 'newest first');
});

test('photo endpoint refuses files outside the inbox folder', async () => {
  stubFetch([
    tokenRoute,
    ['/drive/v3/files/ph_outside123?', async () => ({
      json: { id: 'ph_outside123', name: 'x.jpg', mimeType: 'image/jpeg', parents: ['SOMEWHERE'] },
    })],
  ]);
  const res = mockRes();
  await photoHandler(mockReq('GET', '/api/photo?id=ph_outside123'), res);
  assert.strictEqual(res.statusCode, 403);
});

test('photo endpoint streams inbox files with their mime type', async () => {
  stubFetch([
    tokenRoute,
    ['alt=media', async () => ({ json: null, buffer: Buffer.from([1, 2, 3, 4]) })],
    ['/drive/v3/files/ph_inside1234?', async () => ({
      json: { id: 'ph_inside1234', name: 'x.jpg', mimeType: 'image/jpeg', parents: ['INBOX123456'] },
    })],
  ]);
  const res = mockRes();
  await photoHandler(mockReq('GET', '/api/photo?id=ph_inside1234'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-type'], 'image/jpeg');
  assert.strictEqual(res.body.length, 4);
});

test('upload creates a file in the inbox with multipart body', async () => {
  stubFetch([
    tokenRoute,
    ['upload/drive/v3/files?uploadType=multipart', async (u, opts) => {
      const body = opts.body.toString('latin1');
      assert.ok(body.includes('"parents":["INBOX123456"]'), 'targets inbox folder');
      assert.ok(body.includes('content-type: image/jpeg'));
      return { json: { id: 'newphoto123', name: 'tag.jpg' } };
    }],
  ]);
  const res = mockRes();
  await uploadHandler(
    mockReq('POST', '/api/upload', { 'content-type': 'image/jpeg', 'x-file-name': 'tag.jpg' }, Buffer.from('JPEGDATA')),
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json.id, 'newphoto123');
});

test('library PUT writes json + svgs and trashes orphaned svg mirrors', async () => {
  const trashed = [];
  const upserts = [];
  stubFetch([
    tokenRoute,
    ['upload/drive/v3/files/', async (u, opts) => {
      upserts.push({ kind: 'update', url: u });
      return { json: { id: 'upd', name: 'x' } };
    }],
    ['upload/drive/v3/files?', async (u, opts) => {
      upserts.push({ kind: 'create', body: opts.body.toString('latin1') });
      return { json: { id: 'crt', name: 'x' } };
    }],
    ['/drive/v3/files?', async (u) => {
      const q = decodeQuery(u);
      if (q.includes("name = 'library.json'")) return { json: { files: [] } }; // create it
      if (q.includes("name = 'A-caps__keep1.svg'")) return { json: { files: [] } };
      if (q.includes("mimeType = 'image/svg+xml'")) {
        return {
          json: {
            files: [
              { id: 'svgKeep', name: 'A-caps__keep1.svg' },
              { id: 'svgOrphan', name: 'B-caps__gone9.svg' },
            ],
          },
        };
      }
      return { json: { files: [] } };
    }],
    ['/drive/v3/files/svgOrphan', async (u, opts) => {
      assert.strictEqual(opts.method, 'PATCH');
      assert.ok(opts.body.includes('"trashed":true'));
      trashed.push('svgOrphan');
      return { json: {} };
    }],
  ]);
  const payload = {
    library: {
      app: 'sanstyle', version: 1,
      glyphs: { A: { variants: [{ id: 'keep1', char: 'A', contours: [] }], active: 0 } },
    },
    svgs: [{ id: 'keep1', name: 'A-caps__keep1.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }],
  };
  const res = mockRes();
  await libraryHandler(mockReq('PUT', '/api/library', {}, JSON.stringify(payload)), res);
  assert.strictEqual(res.statusCode, 200, res.body.toString());
  assert.deepStrictEqual(trashed, ['svgOrphan'], 'orphan svg trashed');
  assert.deepStrictEqual(res.json.svgIds, ['keep1']);
  assert.ok(upserts.some((c) => c.kind === 'create' && c.body.includes('library.json')), 'library.json written');
});

test('svgIdFromName parses mirror filenames', () => {
  assert.strictEqual(L.svgIdFromName('A-caps__abc123x.svg'), 'abc123x');
  assert.strictEqual(L.svgIdFromName('hash__9f2k1qz8.svg'), '9f2k1qz8');
  assert.strictEqual(L.svgIdFromName('library.json'), null);
});
