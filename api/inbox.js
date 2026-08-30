/* GET → { photos: [{id, name, mimeType, createdTime, size}] }
 * Every image currently in the Drive inbox folder, newest first. The client
 * filters out ids it has already processed.
 */
'use strict';
const L = require('./_lib.js');

module.exports = async function handler(req, res) {
  try {
    if (!L.configured()) return L.send(res, 503, { error: 'not configured' });
    if (!L.requirePass(req, res)) return;
    if (req.method !== 'GET') return L.send(res, 405, { error: 'method not allowed' });
    const { inboxId } = L.env();
    const files = await L.driveList(
      `'${inboxId}' in parents and trashed = false and ` +
      `(mimeType contains 'image/' or name contains '.heic' or name contains '.HEIC' or name contains '.heif')`,
      'id, name, mimeType, createdTime, size, thumbnailLink'
    );
    files.sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''));
    return L.send(res, 200, { photos: files });
  } catch (e) {
    return L.send(res, 500, { error: String(e.message || e) });
  }
};
