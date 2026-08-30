/* GET ?id=… → the photo bytes, only for files that live in the inbox folder. */
'use strict';
const L = require('./_lib.js');

module.exports = async function handler(req, res) {
  try {
    if (!L.configured()) return L.send(res, 503, { error: 'not configured' });
    if (!L.requirePass(req, res)) return;
    if (req.method !== 'GET') return L.send(res, 405, { error: 'method not allowed' });
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id') || '';
    if (!/^[\w-]{10,}$/.test(id)) return L.send(res, 400, { error: 'bad id' });

    const meta = await L.driveMeta(id, 'id, name, mimeType, parents, thumbnailLink');
    const { inboxId } = L.env();
    if (!meta.parents || !meta.parents.includes(inboxId)) {
      return L.send(res, 403, { error: 'not an inbox photo' });
    }

    // Drive's thumbnail service is far faster than alt=media for phone
    // photos: pre-scaled by Google and HEIC→JPEG converted. Use it unless
    // the caller asks for the original with ?full=1.
    const wantFull = url.searchParams.get('full') === '1';
    if (!wantFull && meta.thumbnailLink) {
      try {
        const sized = meta.thumbnailLink.replace(/=s\d+(-c)?$/, '=s1800');
        const thumb = await fetch(sized);
        if (thumb.ok) {
          const bytes = Buffer.from(await thumb.arrayBuffer());
          if (bytes.length > 400) {
            return L.send(res, 200, bytes, {
              'content-type': thumb.headers.get('content-type') || 'image/jpeg',
              'cache-control': 'private, max-age=3600',
            });
          }
        }
      } catch (e) { /* fall through to the original bytes */ }
    }

    const upstream = await L.driveDownload(id);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    return L.send(res, 200, bytes, {
      'content-type': meta.mimeType || 'application/octet-stream',
      'cache-control': 'private, max-age=3600',
    });
  } catch (e) {
    return L.send(res, 500, { error: String(e.message || e) });
  }
};
