/* SANSTYLE — app.js
 * Boot, tab routing, and the test-drive hooks used by the e2e suite.
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

  function boot() {
    ST.store.load();
    ST.capture.init();
    ST.glyphsUI.init();
    ST.fontlive.init();

    ST.$$('.tab-btn').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    ST.store.on('change', () => {
      $('#navCount').textContent = ST.store.count() || '';
    });
    $('#navCount').textContent = ST.store.count() || '';

    // --- deterministic test hooks (used by test/e2e.mjs; harmless in prod) ---
    g.__st = {
      ST,
      switchTab,
      loadDemo: (ch) => ST.capture.loadDemo(ch),
      lassoDemoLetter() {
        // rectangle lasso around the demo wall's letter box
        const wall = ST.capture.lastDemo;
        if (!wall) throw new Error('no demo loaded');
        const b = wall.letterBox;
        ST.capture.lasso = [
          { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
          { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
        ];
        ST.capture.runExtraction(true);
        const ex = ST.capture.extract;
        return { paths: ex ? ex.paths.length : 0, ink: ex ? ex.inkCount : 0 };
      },
      tagAndSubmit(ch) {
        $('#charInput').value = ch;
        ST.capture.updatePreview();
        return ST.capture.submit();
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
        glyphsMapped: ST.fontlive.glyphMap ? ST.fontlive.glyphMap.size : 0,
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
