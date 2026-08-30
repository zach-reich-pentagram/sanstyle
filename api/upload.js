/* POST → stores a photo in the Drive inbox folder.
 * Body: raw image bytes. Headers: content-type (image mime),
 * x-file-name (URI-encoded name). Returns {id, name}.
 */
'use strict';
const L = require('./_lib.js');

module.exports = async function handler(req, res) {
  try {
    if (!L.configured()) return L.send(res, 503, { error: 'not configured' });
    if (!L.requirePass(req, res)) return;
    if (req.method !== 'POST') return L.send(res, 405, { error: 'method not allowed' });
    const mime = String(req.headers['content-type'] || 'image/jpeg').split(';')[0];
    if (!mime.startsWith('image/')) return L.send(res, 400, { error: 'not an image' });
    let name = 'photo.jpg';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || name)); } catch (e) { /* keep default */ }
    name = name.replace(/[/\\]/g, '_').slice(0, 120) || 'photo.jpg';
    const bytes = await L.readBody(req, 4.4 * 1024 * 1024);
    if (!bytes.length) return L.send(res, 400, { error: 'empty body' });
    const { inboxId } = L.env();
    const file = await L.driveCreate(inboxId, name, mime, bytes);
    return L.send(res, 200, { id: file.id, name: file.name });
  } catch (e) {
    return L.send(res, 500, { error: String(e.message || e) });
  }
};
