/* GET → per-folder access diagnostics for the service account, so a red
 * sync pill can explain itself: can the robot see the inbox, see the
 * letterforms folder, and write into it? Each step reports ok/error.
 */
'use strict';
const L = require('./_lib.js');

async function step(fn) {
  try { return { ok: true, detail: await fn() }; }
  catch (e) { return { ok: false, error: String(e.message || e).slice(0, 220) }; }
}

module.exports = async function handler(req, res) {
  if (!L.configured()) return L.send(res, 503, { error: 'not configured' });
  if (!L.requirePass(req, res)) return;
  const { inboxId, libraryId, email } = L.env();
  const out = { serviceAccount: email };
  out.token = await step(async () => { await L.getToken(); return 'ok'; });
  out.inbox = await step(async () => {
    const files = await L.driveList(`'${inboxId}' in parents and trashed = false`, 'id');
    return `${files.length} file(s) visible`;
  });
  out.library = await step(async () => {
    const files = await L.driveList(`'${libraryId}' in parents and trashed = false`, 'id');
    return `${files.length} file(s) visible`;
  });
  out.write = await step(async () => {
    const f = await L.driveCreate(libraryId, '.sanstyle-probe.txt', 'text/plain', 'probe');
    await L.driveTrash(f.id);
    return 'create + trash ok';
  });
  return L.send(res, 200, out);
};
