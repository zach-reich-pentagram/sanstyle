/* Sanstyle — sync.js
 * Cross-device persistence through the site's own /api (Vercel serverless →
 * Google Drive). When the API is configured: a passcode gate unlocks the app,
 * the library pulls/merges from Drive on open, every change pushes back
 * (library.json + per-letterform SVG mirrors), and new photos in the Drive
 * inbox are offered for extraction through the review queue.
 * When the API is absent (local dev, file://), everything stays local-only.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$;
  const PASS_KEY = 'sanstyle.pass';

  const sync = (ST.sync = {
    enabled: false,     // API reachable + configured
    unlocked: false,
    pass: null,
    status: 'local',    // local | locked | syncing | synced | error
    lastPushedHash: {}, // variantId → serialized record at last successful push
    serverSvgIds: new Set(),
    lastError: null,
  });

  // ---------- tiny api helper ----------
  sync.api = function (method, path, body, headers, pass) {
    return fetch(path, {
      method,
      headers: Object.assign(
        { 'x-sanstyle-pass': pass || sync.pass || '' },
        body && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {},
        headers || {}
      ),
      body: body ? (body instanceof Blob ? body : JSON.stringify(body)) : undefined,
    });
  };

  // ---------- status pill ----------
  function setStatus(status, detail) {
    sync.status = status;
    const pill = $('#syncPill');
    if (!pill) return;
    if (status === 'local') { pill.style.display = 'none'; return; }
    pill.style.display = '';
    pill.classList.toggle('warn', status === 'error');
    pill.textContent = {
      locked: 'Locked',
      syncing: 'Syncing…',
      synced: 'Synced',
      error: 'Sync error — retry',
    }[status] || status;
    if (detail) pill.title = detail; else pill.removeAttribute('title');
  }

  // ---------- passcode gate ----------
  function showGate(msg) {
    $('#gateModal').classList.add('open');
    $('#gateError').textContent = msg || '';
    setTimeout(() => $('#gateInput').focus(), 50);
  }
  function hideGate() { $('#gateModal').classList.remove('open'); }

  sync.tryUnlock = async function (pass, silent) {
    try {
      const res = await sync.api('GET', 'api/library', null, null, pass);
      if (res.status === 401) {
        try { localStorage.removeItem(PASS_KEY); } catch (e) { /* private mode */ }
        if (!silent) showGate('Wrong passcode.');
        else showGate();
        return false;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      sync.pass = pass;
      sync.unlocked = true;
      try { localStorage.setItem(PASS_KEY, pass); } catch (e) { /* private mode */ }
      hideGate();
      const row = $('#driveStoreRow');
      if (row) row.style.display = '';
      sync.serverSvgIds = new Set(data.svgIds || []);
      if (data.library) {
        ST.store.mergeLibrary(data.library, { preferIncoming: true });
      }
      snapshotHashes();
      setStatus('synced');
      ST.store.on('change', schedulePush);
      sync.checkInbox(false);
      // anything local the server doesn't have yet
      schedulePush();
      return true;
    } catch (e) {
      sync.lastError = String(e);
      if (!silent) showGate('Could not reach sync — try again.');
      else showGate();
      setStatus('error', String(e));
      return false;
    }
  };

  // ---------- push ----------
  function variantHash(v) {
    // thumbs stay local; hash the synced shape of the record
    const { thumb, ...rest } = v;
    return JSON.stringify(rest);
  }

  function strippedLibrary() {
    const lib = ST.store.exportObject();
    const glyphs = {};
    for (const ch in lib.glyphs) {
      glyphs[ch] = {
        active: lib.glyphs[ch].active,
        variants: lib.glyphs[ch].variants.map((v) => {
          const { thumb, ...rest } = v;
          return rest;
        }),
      };
    }
    return Object.assign({}, lib, { glyphs });
  }

  function snapshotHashes() {
    sync.lastPushedHash = {};
    for (const ch of ST.store.filledChars()) {
      for (const v of ST.store.state.glyphs[ch].variants) {
        sync.lastPushedHash[v.id] = variantHash(v);
      }
    }
  }

  let pushing = false, pushQueued = false;
  sync.pushNow = async function () {
    if (!sync.unlocked) return;
    if (pushing) { pushQueued = true; return; }
    pushing = true;
    setStatus('syncing');
    try {
      const library = strippedLibrary();
      const svgs = [];
      for (const ch in library.glyphs) {
        for (const v of ST.store.state.glyphs[ch].variants) {
          const h = variantHash(v);
          if (sync.lastPushedHash[v.id] !== h || !sync.serverSvgIds.has(v.id)) {
            svgs.push({ id: v.id, name: ST.exporter.svgFileName(v), content: ST.exporter.variantSVG(v) });
          }
        }
      }
      const res = await sync.api('PUT', 'api/library', { library, svgs });
      if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
      const data = await res.json();
      sync.serverSvgIds = new Set(data.svgIds || []);
      snapshotHashes();
      setStatus('synced');
    } catch (e) {
      sync.lastError = String(e);
      setStatus('error', String(e));
    }
    pushing = false;
    if (pushQueued) { pushQueued = false; sync.pushNow(); }
  };
  const schedulePush = ST.debounce(() => sync.pushNow(), 2000);
  sync.schedulePush = schedulePush;

  // ---------- inbox ----------
  sync.checkInbox = async function (manual, rescanAll) {
    if (!sync.unlocked) return;
    try {
      const res = await sync.api('GET', 'api/inbox');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const { photos } = await res.json();
      const processed = new Set(ST.store.state.processedPhotos);
      const fresh = rescanAll ? photos : photos.filter((p) => !processed.has(p.id));
      if (!fresh.length) {
        if (manual) ST.toast('Drive inbox is clear — nothing new to extract.');
        return;
      }
      $('#inboxCount').textContent =
        `${fresh.length} ${rescanAll ? '' : 'new '}photo${fresh.length === 1 ? '' : 's'} in the Drive inbox.`;
      $('#inboxModal').classList.add('open');
      sync._pendingInbox = fresh;
    } catch (e) {
      sync.lastError = String(e);
      if (manual) ST.toast('Could not check the Drive inbox.', 'warn');
    }
  };

  sync.extractPending = function () {
    const list = sync._pendingInbox || [];
    $('#inboxModal').classList.remove('open');
    sync._pendingInbox = null;
    if (list.length) ST.batch.addRemotePhotos(list);
  };

  sync.markProcessed = function (id) {
    ST.store.markPhotoProcessed(id);
  };

  // Fetch one Drive photo → canvas (HEIC-aware).
  sync.fetchPhotoCanvas = async function (photo) {
    const res = await sync.api('GET', 'api/photo?id=' + encodeURIComponent(photo.id));
    if (!res.ok) throw new Error('photo fetch HTTP ' + res.status);
    const blob = await res.blob();
    const meta = { name: photo.name || '', type: blob.type || photo.mimeType || '' };
    const toCanvas = (src, w, h) => {
      const c = g.document.createElement('canvas');
      const s = Math.min(1, 1800 / Math.max(w, h));
      c.width = Math.round(w * s);
      c.height = Math.round(h * s);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      return c;
    };
    try {
      const bmp = await g.createImageBitmap(blob);
      return toCanvas(bmp, bmp.width, bmp.height);
    } catch (e) {
      if (ST.heic && ST.heic.looksHeic(meta)) {
        const cnv = await ST.heic.decode(blob);
        return toCanvas(cnv, cnv.width, cnv.height);
      }
      throw e;
    }
  };

  // ---------- site → Drive photo upload ----------
  sync.storeUploadsEnabled = function () {
    const t = $('#driveStoreToggle');
    return sync.unlocked && t && t.checked;
  };

  sync.uploadCanvas = async function (canvas, name) {
    if (!sync.unlocked) return null;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (!blob) return null;
    const jpgName = (name || 'photo').replace(/\.[a-z0-9]+$/i, '') + '.jpg';
    const res = await sync.api('POST', 'api/upload', blob, {
      'content-type': 'image/jpeg',
      'x-file-name': encodeURIComponent(jpgName),
    });
    if (!res.ok) throw new Error('upload HTTP ' + res.status);
    const data = await res.json();
    return data.id;
  };

  sync.manualSync = async function () {
    if (!sync.unlocked) return;
    await sync.pushNow();
    await sync.checkInbox(true);
  };

  // ---------- boot ----------
  sync.init = async function () {
    $('#gateForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const pass = $('#gateInput').value.trim();
      if (pass) sync.tryUnlock(pass, false);
    });
    $('#syncPill').addEventListener('click', () => {
      if (sync.status === 'error') sync.pushNow();
      else sync.manualSync();
    });
    $('#inboxExtract').addEventListener('click', sync.extractPending);
    $('#inboxLater').addEventListener('click', () => {
      $('#inboxModal').classList.remove('open');
      sync._pendingInbox = null;
    });
    $('#inboxRescan').addEventListener('click', () => {
      $('#inboxModal').classList.remove('open');
      sync.checkInbox(true, true);
    });

    let health = null;
    try {
      const res = await fetch('api/health');
      if (res.ok) health = await res.json();
    } catch (e) { /* static hosting without the api */ }
    if (!health || !health.configured) {
      setStatus('local');
      return;
    }
    sync.enabled = true;
    setStatus('locked');
    let saved = null;
    try { saved = localStorage.getItem(PASS_KEY); } catch (e) { /* private mode */ }
    if (saved) {
      const ok = await sync.tryUnlock(saved, true);
      if (!ok) showGate();
    } else {
      showGate();
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
