/* SANSTYLE — app.js
 * Boot, tab routing, the design playground bindings, and the deterministic
 * test hooks used by the e2e suite.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$;

  function switchTab(name) {
    ST.$$('.tab-btn').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    ST.$$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
    if (name === 'capture' && ST.capture) ST.capture.requestDraw();
    if (name === 'glyphs' && ST.glyphsUI && ST.glyphsUI.refreshPhotos) ST.glyphsUI.refreshPhotos(true);
  }
  ST.switchTab = switchTab;

  // ---------- design playground ----------
  const DESIGN_VARS = [
    { id: 'dvFont', varName: '--fs', unit: 'px', def: 14 },
    { id: 'dvPad', varName: '--pad', unit: 'px', def: 16 },
    { id: 'dvGap', varName: '--gap', unit: 'px', def: 10 },
    { id: 'dvCtl', varName: '--ctl-h', unit: 'px', def: 34 },
    { id: 'dvRadius', varName: '--pill-r', unit: 'px', def: 999 },
    { id: 'dvBorder', varName: '--bw', unit: 'px', def: 1 },
    { id: 'dvCanvasPad', varName: '--canvas-pad', unit: 'px', def: 44 },
  ];

  function applyDesign() {
    const d = ST.store.state.design || {};
    for (const v of DESIGN_VARS) {
      const val = d[v.varName] != null ? d[v.varName] : v.def;
      g.document.documentElement.style.setProperty(v.varName, val + v.unit);
      const input = $('#' + v.id);
      const label = $('#' + v.id + 'Val');
      if (input) input.value = val;
      if (label) label.textContent = val + v.unit;
    }
  }

  function initDesign() {
    for (const v of DESIGN_VARS) {
      const input = $('#' + v.id);
      if (!input) continue;
      input.addEventListener('input', () => {
        ST.store.updateDesign({ [v.varName]: +input.value });
      });
    }
    $('#designReset').addEventListener('click', () => {
      const patch = {};
      for (const v of DESIGN_VARS) patch[v.varName] = null;
      ST.store.updateDesign(patch);
    });
    ST.store.on('design', applyDesign);
    applyDesign();
  }

  function boot() {
    ST.store.load();
    ST.capture.init();
    ST.glyphsUI.init();
    ST.fontlive.init();
    ST.batch.init();
    initDesign();
    ST.sync.init();

    ST.$$('.tab-btn').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    const syncCount = () => { $('#navCount').textContent = ST.store.count() || ''; };
    ST.store.on('change', syncCount);
    syncCount();

    // --- deterministic test hooks (used by test/e2e.mjs; harmless in prod) ---
    g.__st = {
      ST,
      switchTab,
      // a demo wall goes through the same queue as any photo
      loadDemo: (ch) => ST.capture.loadDemo(ch),
      tagAndSubmit(ch) {
        $('#reviewChar').value = ch;
        ST.capture.updatePreview();
        return ST.batch.accept();
      },
      autoFromDemo(ch) {
        const wall = ST.demo.makeWall(ch, 555 + ch.charCodeAt(0));
        const n = ST.batch.addCanvas(wall.canvas, 'demo-' + ch);
        return { candidates: n, queue: ST.batch.queue.length };
      },
      fontB64() {
        const b = ST.fontlive.lastBytes;
        if (!b) return null;
        let s = '';
        for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        return btoa(s);
      },
      state: () => ({
        chars: ST.store.filledChars(),
        current: ST.capture.item ? ST.capture.item.name : null,
        shapes: ST.capture.item ? ST.capture.item.candidates.length : 0,
        glyphsMapped: ST.fontlive.glyphMaps[0] ? ST.fontlive.glyphMaps[0].size : 0,
        cycleFonts: ST.fontlive.glyphMaps.length,
        queue: Math.max(0, ST.batch.queue.length - ST.batch.idx),
      }),
    };
  }

  if (g.document) {
    if (g.document.readyState === 'loading') {
      g.document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
