/* SANSTYLE — ui/tester.js
 * The proof: every library change recompiles the actual TTF, hot-swaps it in
 * via the FontFace API, and the tester types with the real font. Also owns
 * the .ttf download.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$;

  const live = (ST.fontlive = {
    lastBytes: null,
    face: null,
    familyName: 'SanstyleLive',
    glyphMap: null,
  });

  live.rebuild = function () {
    const t0 = performance.now();
    const glyphMap = ST.metrics.buildFontGlyphs(ST.store.state.glyphs, {
      mirrorCase: ST.store.state.mirrorCase,
    });
    live.glyphMap = glyphMap;
    const bytes = ST.ttf.compile({
      fontName: ST.store.state.fontName,
      glyphMap,
    });
    live.lastBytes = bytes;

    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const face = new FontFace(live.familyName, buf);
    return face.load().then(() => {
      if (live.face) g.document.fonts.delete(live.face);
      g.document.fonts.add(face);
      live.face = face;
      updateMeta(performance.now() - t0);
      return face;
    }).catch((e) => {
      console.error('FontFace load failed', e);
      updateMeta(-1);
    });
  };

  const rebuildSoon = ST.debounce(() => live.rebuild(), 250);

  function updateMeta(ms) {
    const n = ST.store.count();
    const testerEl = $('#tester');
    $('#testerEmpty').style.display = n ? 'none' : '';
    testerEl.style.display = n ? '' : 'none';
    $('#testerFoot').style.display = n ? '' : 'none';

    const dl = $('#downloadBtn');
    dl.disabled = !n;
    $('#dlName').textContent = `${psName()}.ttf`;

    if (ms >= 0) {
      $('#compileMeta').textContent =
        `${ST.store.state.fontName} · ${live.glyphMap ? live.glyphMap.size : 0} glyphs mapped · rebuilt in ${ms.toFixed(0)}ms`;
    }
    updateCoverage();
  }

  function psName() {
    return (ST.store.state.fontName || 'Sanstyle').replace(/[^A-Za-z0-9-]/g, '');
  }

  function updateCoverage() {
    const box = $('#coverage');
    if (!live.glyphMap) { box.innerHTML = ''; return; }
    const text = $('#tester').textContent || '';
    const missing = new Set();
    for (const ch of text) {
      if (ch === '\n' || ch === ' ' || ch === ' ') continue;
      if (!live.glyphMap.has(ch.codePointAt(0))) missing.add(ch);
    }
    if (!missing.size) {
      box.innerHTML = '<span class="ok-text">Every character in this sample is street-sourced.</span>';
    } else {
      box.innerHTML = 'Not captured yet: ' +
        Array.from(missing).slice(0, 24).map((c) => `<b class="miss">${c === '<' ? '&lt;' : c}</b>`).join(' ') +
        ' <span class="dim">— go find them.</span>';
    }
  }

  live.download = function () {
    if (!live.lastBytes) return;
    const blob = new Blob([live.lastBytes], { type: 'font/ttf' });
    const a = ST.el('a', { href: URL.createObjectURL(blob), download: `${psName()}.ttf` });
    g.document.body.appendChild(a); a.click(); a.remove();
    ST.toast('Font downloaded. Install it and type the streets.');
  };

  live.init = function () {
    const tester = $('#tester');

    const applyTypo = () => {
      tester.style.fontSize = $('#sizeRange').value + 'px';
      tester.style.letterSpacing = $('#trackRange').value + 'em';
      tester.style.lineHeight = $('#leadRange').value;
    };
    for (const id of ['#sizeRange', '#trackRange', '#leadRange']) {
      $(id).addEventListener('input', applyTypo);
    }
    applyTypo();

    $('#invertBtn').addEventListener('click', () => {
      $('#testerWrap').classList.toggle('inverted');
    });

    $('#fontNameInput').value = ST.store.state.fontName;
    $('#fontNameInput').addEventListener('input', (e) => {
      ST.store.setFontName(e.target.value);
    });

    $('#mirrorCase').checked = ST.store.state.mirrorCase;
    $('#mirrorCase').addEventListener('change', (e) => {
      ST.store.setMirrorCase(e.target.checked);
    });

    ST.$$('.sample-btn').forEach((b) => {
      b.addEventListener('click', () => {
        tester.textContent = b.dataset.text;
        updateCoverage();
      });
    });

    tester.addEventListener('input', ST.debounce(updateCoverage, 200));
    $('#downloadBtn').addEventListener('click', live.download);

    ST.store.on('change', () => {
      $('#fontNameInput').value = ST.store.state.fontName;
      rebuildSoon();
    });
    live.rebuild();
  };
})(typeof window !== 'undefined' ? window : globalThis);
