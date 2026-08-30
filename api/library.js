/* GET  → { library, svgIds }  — library.json from the letterforms folder,
 *         plus the variant ids that already have an SVG mirrored there.
 * PUT  → { library, svgs: [{id, name, content}] }
 *         Writes library.json, upserts the given SVGs, then trashes any
 *         mirrored SVG whose variant no longer exists in the library.
 */
'use strict';
const L = require('./_lib.js');

async function findLibraryFile(folderId) {
  const files = await L.driveList(
    `name = 'library.json' and '${folderId}' in parents and trashed = false`,
    'id, name, modifiedTime'
  );
  return files[0] || null;
}

function collectVariantIds(library) {
  const ids = new Set();
  const glyphs = (library && library.glyphs) || {};
  for (const ch in glyphs) {
    for (const v of glyphs[ch].variants || []) {
      if (v && v.id) ids.add(v.id);
    }
  }
  return ids;
}

module.exports = async function handler(req, res) {
  try {
    if (!L.configured()) return L.send(res, 503, { error: 'not configured' });
    if (!L.requirePass(req, res)) return;
    const { libraryId } = L.env();

    if (req.method === 'GET') {
      const file = await findLibraryFile(libraryId);
      let library = null;
      if (file) {
        library = await (await L.driveDownload(file.id)).json();
      }
      const svgs = await L.driveList(
        `'${libraryId}' in parents and mimeType = 'image/svg+xml' and trashed = false`,
        'id, name'
      );
      const svgIds = svgs.map((f) => L.svgIdFromName(f.name)).filter(Boolean);
      return L.send(res, 200, { library, svgIds, modified: file ? file.modifiedTime : null });
    }

    if (req.method === 'PUT') {
      const body = JSON.parse((await L.readBody(req)).toString('utf8'));
      if (!body || !body.library || body.library.app !== 'sanstyle') {
        return L.send(res, 400, { error: 'not a sanstyle library payload' });
      }
      await L.driveUpsert(libraryId, 'library.json', 'application/json',
        JSON.stringify(body.library, null, 1));

      for (const svg of body.svgs || []) {
        if (!svg || !svg.id || !svg.name || !svg.content) continue;
        if (!/\.svg$/.test(svg.name) || svg.content.length > 400000) continue;
        await L.driveUpsert(libraryId, svg.name, 'image/svg+xml', svg.content);
      }

      // reconcile: trash mirrored SVGs for deleted variants
      const keep = collectVariantIds(body.library);
      const svgFiles = await L.driveList(
        `'${libraryId}' in parents and mimeType = 'image/svg+xml' and trashed = false`,
        'id, name'
      );
      const svgIds = [];
      for (const f of svgFiles) {
        const vid = L.svgIdFromName(f.name);
        if (!vid) continue;
        if (keep.has(vid)) svgIds.push(vid);
        else await L.driveTrash(f.id);
      }
      return L.send(res, 200, { ok: true, svgIds });
    }

    return L.send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return L.send(res, 500, { error: String(e.message || e) });
  }
};
