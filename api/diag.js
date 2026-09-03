/* GET → per-folder access diagnostics, so a red sync pill can explain
 * itself: which Google identity the site uses, can it see the inbox, see
 * the letterforms folder, and write into it? Each step reports ok/error,
 * and the one failure everybody hits — a service account that may not own
 * files in a personal My Drive — comes with its fix.
 */
'use strict';
const L = require('./_lib.js');

async function step(fn) {
  try { return { ok: true, detail: await fn() }; }
  catch (e) { return { ok: false, error: String(e.message || e).slice(0, 220) }; }
}

const QUOTA_HINT =
  'Google no longer lets a service account own files in a personal My Drive. ' +
  'Either sign the site in as yourself (set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and ' +
  'GOOGLE_OAUTH_REFRESH_TOKEN — see SETUP-SYNC.md, five minutes) or move both folders into a Shared Drive.';

module.exports = async function handler(req, res) {
  if (!L.configured()) return L.send(res, 503, { error: 'not configured' });
  if (!L.requirePass(req, res)) return;
  const { inboxId, libraryId, email } = L.env();
  const mode = L.authMode();
  const out = {
    mode,
    auth: mode === 'user' ? 'your Google account (OAuth refresh token)' : `service account ${email}`,
    serviceAccount: mode === 'service' ? email : null,
  };
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
  if (!out.write.ok && /storage quota|shared drive/i.test(out.write.error)) out.write.hint = QUOTA_HINT;
  return L.send(res, 200, out);
};
