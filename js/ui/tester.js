/* SANSTYLE — ui/tester.js
 * Types with the real compiled TTF via FontFace. Text is wrapped into
 * one-character spans so repeated letters can cycle through captured
 * variants (extra "cycle fonts" are compiled per variant slot) and so
 * individual letterforms can be clicked and kerned with the arrow keys.
 * Exports (SVG/PNG/JPG) come from the same outlines via export.js.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$;

  const MAX_CYCLE_FONTS = 3; // base + up to 3 alternates

  const live = (ST.fontlive = {
    lastBytes: null,
    faces: [],
    glyphMaps: [],   // [base, alt1, ...] Map(cp → finalized outline)
    kerns: {},       // char-index → em offset (session only)
    kernSel: null,   // selected span
    kernMode: false,
  });

  // ---------- font compilation ----------
  live.rebuild = function () {
    const t0 = performance.now();
    const st = ST.store.state;
    const maps = [ST.metrics.buildFontGlyphs(st.glyphs, { mirrorCase: st.mirrorCase })];
    let maxVariants = 1;
    for (const ch in st.glyphs) {
      maxVariants = Math.max(maxVariants, st.glyphs[ch].variants.length);
    }
    const nMaps = Math.min(maxVariants, 1 + MAX_CYCLE_FONTS);
    for (let k = 1; k < nMaps; k++) {
      maps.push(ST.metrics.buildFontGlyphs(st.glyphs, { mirrorCase: st.mirrorCase, variantOffset: k }));
    }
    live.glyphMaps = maps;

    const bytesList = maps.map((m, k) => ST.ttf.compile({
      fontName: k === 0 ? st.fontName : st.fontName + ' Alt' + k,
      glyphMap: m,
    }));
    live.lastBytes = bytesList[0];

    const loads = bytesList.map((bytes, k) => {
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const face = new FontFace(k === 0 ? 'SanstyleLive' : 'SanstyleCyc' + k, buf);
      return face.load();
    });
    return Promise.all(loads).then((faces) => {
      for (const f of live.faces) g.document.fonts.delete(f);
      for (const f of faces) g.document.fonts.add(f);
      live.faces = faces;
      updateMeta(performance.now() - t0);
      rewrap();
    }).catch((e) => {
      console.error('FontFace load failed', e);
      updateMeta(-1);
    });
  };

  const rebuildSoon = ST.debounce(() => live.rebuild(), 250);

  function psName() {
    return (ST.store.state.fontName || 'Sanstyle').replace(/[^A-Za-z0-9-]/g, '') || 'Sanstyle';
  }

  function updateMeta(ms) {
    const n = ST.store.count();
    $('#testerEmpty').style.display = n ? 'none' : '';
    $('#tester').style.display = n ? '' : 'none';
    $('#testerFoot').style.display = n ? '' : 'none';
    $('#downloadBtn').disabled = !n;
    $('#dlName').textContent = `${psName()}.ttf`;
    if (ms >= 0) {
      const alts = live.glyphMaps.length - 1;
      $('#compileMeta').textContent =
        `${n} character${n === 1 ? '' : 's'}${alts ? ` · ${alts} alternate set${alts === 1 ? '' : 's'}` : ''}`;
    }
    updateCoverage();
  }

  function updateCoverage() {
    const box = $('#coverage');
    const map = live.glyphMaps[0];
    if (!map) { box.textContent = ''; return; }
    const text = $('#tester').textContent || '';
    const missing = new Set();
    for (const ch of text) {
      if (ch === '\n' || ch === ' ') continue;
      if (!map.has(ch.codePointAt(0))) missing.add(ch);
    }
    box.textContent = missing.size
      ? 'Missing: ' + Array.from(missing).slice(0, 24).join(' ')
      : '';
  }

  // ---------- span wrapping with caret preservation ----------
  const tester = () => $('#tester');

  function getCaretOffset(root) {
    const sel = g.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return null;
    const pre = range.cloneRange();
    pre.selectNodeContents(root);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  function setCaretOffset(root, offset) {
    if (offset === null) return;
    const sel = g.getSelection();
    const range = g.document.createRange();
    let remaining = offset;
    const walker = g.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent.length;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
      node = walker.nextNode();
    }
    range.selectNodeContents(root);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function rewrap(preserveCaret) {
    const el = tester();
    if (!el) return;
    const text = el.textContent;
    const caret = preserveCaret ? getCaretOffset(el) : null;
    const st = ST.store.state.tester;
    const nMaps = live.glyphMaps.length;
    const cycling = st.cycle && nMaps > 1;
    const occurrence = {};
    el.textContent = '';
    const frag = g.document.createDocumentFragment();
    let idx = 0;
    for (const ch of text) {
      if (ch === '\n') {
        frag.appendChild(g.document.createTextNode('\n'));
        idx++;
        continue;
      }
      const span = g.document.createElement('span');
      span.className = 'tl';
      span.dataset.i = idx;
      span.textContent = ch;
      if (cycling && ch !== ' ') {
        const occ = occurrence[ch] || 0;
        occurrence[ch] = occ + 1;
        const k = occ % nMaps;
        if (k > 0) span.classList.add('cyc' + k);
      }
      const kern = live.kerns[idx];
      if (kern) span.style.marginLeft = kern + 'em';
      frag.appendChild(span);
      idx++;
    }
    el.appendChild(frag);
    if (preserveCaret) setCaretOffset(el, caret);
    updateCoverage();
  }
  live.rewrap = rewrap;

  // ---------- kern mode ----------
  function setKernMode(on) {
    live.kernMode = on;
    const el = tester();
    el.contentEditable = on ? 'false' : 'true';
    el.classList.toggle('kerning', on);
    $('#kernToggle').classList.toggle('on', on);
    selectKernSpan(null);
    $('#kernHint').style.display = on ? '' : 'none';
  }

  function selectKernSpan(span) {
    if (live.kernSel) live.kernSel.classList.remove('kern-sel');
    live.kernSel = span;
    if (span) span.classList.add('kern-sel');
  }

  function nudgeKern(delta) {
    if (!live.kernSel) return;
    const idx = +live.kernSel.dataset.i;
    const cur = live.kerns[idx] || 0;
    const next = Math.round((cur + delta) * 1000) / 1000;
    if (next === 0) delete live.kerns[idx];
    else live.kerns[idx] = next;
    live.kernSel.style.marginLeft = next ? next + 'em' : '';
    $('#kernReadout').textContent = `${next >= 0 ? '+' : ''}${next.toFixed(3)}em`;
  }

  // ---------- visual state ----------
  function applyVisual() {
    const st = ST.store.state.tester;
    const el = tester();
    const sheet = $('#testerSheet');
    el.style.fontSize = st.size + 'px';
    el.style.letterSpacing = st.tracking + 'em';
    el.style.lineHeight = st.leading;
    el.style.textAlign = st.align;
    el.style.color = st.fg;
    sheet.style.background = st.bg;
    $('#bgColor').value = st.bg;
    $('#fgColor').value = st.fg;
    $('#sizeRange').value = st.size;
    $('#trackRange').value = st.tracking;
    $('#leadRange').value = st.leading;
    $('#cycleToggle').checked = !!st.cycle;
    ST.$$('.align-btn').forEach((b) => b.classList.toggle('on', b.dataset.align === st.align));
    ST.$$('.aspect-btn').forEach((b) => b.classList.toggle('on', b.dataset.aspect === st.aspect));
    if (st.aspect === 'free') {
      sheet.style.aspectRatio = '';
      sheet.style.height = '100%';
      sheet.style.width = '100%';
      sheet.classList.remove('framed');
    } else {
      const [aw, ah] = st.aspect.split(':').map(Number);
      sheet.style.aspectRatio = `${aw} / ${ah}`;
      sheet.style.height = '100%';
      sheet.style.width = 'auto';
      sheet.classList.add('framed');
    }
  }

  // ---------- exports ----------
  function exportOpts() {
    const st = ST.store.state.tester;
    return {
      size: st.size,
      tracking: st.tracking,
      leading: st.leading,
      align: st.align,
      cycle: st.cycle && live.glyphMaps.length > 1,
      kerns: live.kerns,
      glyphMaps: live.glyphMaps,
    };
  }

  function doExport(kind) {
    const text = tester().textContent;
    if (!text.trim() || !live.glyphMaps.length) { ST.toast('Nothing to export yet.', 'warn'); return; }
    const st = ST.store.state.tester;
    const layout = ST.exporter.layout(text, exportOpts());
    const base = `${psName()}-specimen`;
    if (kind === 'svg') {
      const svg = ST.exporter.svg(layout, { bg: st.bg, fg: st.fg });
      ST.exporter.download(new Blob([svg], { type: 'image/svg+xml' }), base + '.svg');
    } else {
      const cnv = ST.exporter.raster(layout, { bg: st.bg, fg: st.fg, scaleUp: 2 });
      const mime = kind === 'png' ? 'image/png' : 'image/jpeg';
      cnv.toBlob((blob) => {
        if (blob) ST.exporter.download(blob, `${base}.${kind}`);
      }, mime, 0.92);
    }
  }
  live.doExport = doExport;

  live.download = function () {
    if (!live.lastBytes) return;
    const blob = new Blob([live.lastBytes], { type: 'font/ttf' });
    ST.exporter.download(blob, `${psName()}.ttf`);
    ST.toast('Font downloaded.');
  };

  // ---------- init ----------
  live.init = function () {
    const el = tester();

    // keep content as plain text nodes: Enter → literal newline, paste → text
    el.addEventListener('keydown', (e) => {
      if (live.kernMode) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        g.document.execCommand('insertText', false, '\n');
      }
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || g.clipboardData).getData('text/plain');
      g.document.execCommand('insertText', false, text);
    });
    el.addEventListener('input', ST.debounce(() => rewrap(true), 160));

    // kern interactions
    el.addEventListener('click', (e) => {
      if (!live.kernMode) return;
      const span = e.target.closest && e.target.closest('span.tl');
      selectKernSpan(span || null);
      if (span) {
        const idx = +span.dataset.i;
        const cur = live.kerns[idx] || 0;
        $('#kernReadout').textContent = `${cur >= 0 ? '+' : ''}${cur.toFixed(3)}em`;
      }
    });
    g.addEventListener('keydown', (e) => {
      if (!live.kernMode || !live.kernSel) return;
      const step = e.shiftKey ? 0.025 : 0.005;
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeKern(-step); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeKern(step); }
      else if (e.key === 'Escape') { setKernMode(false); }
    });
    $('#kernToggle').addEventListener('click', () => setKernMode(!live.kernMode));
    $('#kernClear').addEventListener('click', () => {
      live.kerns = {};
      $('#kernReadout').textContent = '';
      rewrap();
      ST.toast('Kern adjustments cleared.');
    });

    // typography controls
    const upd = (patch) => ST.store.updateTester(patch);
    $('#sizeRange').addEventListener('input', (e) => upd({ size: +e.target.value }));
    $('#trackRange').addEventListener('input', (e) => upd({ tracking: +e.target.value }));
    $('#leadRange').addEventListener('input', (e) => upd({ leading: +e.target.value }));
    $('#bgColor').addEventListener('input', (e) => upd({ bg: e.target.value }));
    $('#fgColor').addEventListener('input', (e) => upd({ fg: e.target.value }));
    ST.$$('.align-btn').forEach((b) => {
      b.addEventListener('click', () => upd({ align: b.dataset.align }));
    });
    ST.$$('.aspect-btn').forEach((b) => {
      b.addEventListener('click', () => upd({ aspect: b.dataset.aspect }));
    });
    $('#cycleToggle').addEventListener('change', (e) => {
      upd({ cycle: e.target.checked });
      rewrap();
    });

    $('#fontNameInput').value = ST.store.state.fontName;
    $('#fontNameInput').addEventListener('input', (e) => ST.store.setFontName(e.target.value));
    $('#mirrorCase').checked = ST.store.state.mirrorCase;
    $('#mirrorCase').addEventListener('change', (e) => ST.store.setMirrorCase(e.target.checked));

    ST.$$('.sample-btn').forEach((b) => {
      b.addEventListener('click', () => {
        el.textContent = b.dataset.text;
        rewrap();
      });
    });

    $('#downloadBtn').addEventListener('click', live.download);
    $('#expSvg').addEventListener('click', () => doExport('svg'));
    $('#expPng').addEventListener('click', () => doExport('png'));
    $('#expJpg').addEventListener('click', () => doExport('jpg'));

    ST.store.on('change', () => {
      $('#fontNameInput').value = ST.store.state.fontName;
      rebuildSoon();
    });
    ST.store.on('tester', applyVisual);

    applyVisual();
    rewrap();
    live.rebuild();
  };
})(typeof window !== 'undefined' ? window : globalThis);
