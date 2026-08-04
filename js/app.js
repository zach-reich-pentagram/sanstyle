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
  }

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
      loadDemo: (ch) => ST.capture.loadDemo(ch),
      lassoDemoLetter() {
        const wall = ST.capture.lastDemo;
        if (!wall) throw new Error('no demo loaded');
        const b = wall.letterBox;
        ST.capture.lasso = [
          { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
          { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
        ];
        ST.capture.runExtraction(true);
        const ex = ST.capture.extract;
        return {
          paths: ex ? ex.paths.length : 0,
          ink: ex ? ex.inkCount : 0,
          guess: ST.capture.guess && ST.capture.guess.length ? ST.capture.guess[0].ch : null,
        };
      },
      tagAndSubmit(ch) {
        $('#charInput').value = ch;
        ST.capture.updatePreview();
        return ST.capture.submit();
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
        step: ST.capture.step,
        glyphsMapped: ST.fontlive.glyphMaps[0] ? ST.fontlive.glyphMaps[0].size : 0,
        cycleFonts: ST.fontlive.glyphMaps.length,
        queue: ST.batch.queue.length,
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
