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
    const tst = st.tester || {};
    // weight mode shows, in every slot, the variant nearest the slider's
    // target; cycling alternates would undo that, so only the base set builds
    const wt = tst.weightOn ? (tst.weight == null ? 50 : tst.weight) / 100 : null;
    live.weight = wt;
    const maps = [ST.metrics.buildFontGlyphs(st.glyphs, { mirrorCase: st.mirrorCase, weight: wt })];
    let maxVariants = 1;
    for (const ch in st.glyphs) {
      maxVariants = Math.max(maxVariants, st.glyphs[ch].variants.length);
    }
    const nMaps = wt == null ? Math.min(maxVariants, 1 + MAX_CYCLE_FONTS) : 1;
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
      const ligs = live.glyphMaps[0] && live.glyphMaps[0].ligatures ? live.glyphMaps[0].ligatures.length : 0;
      const chars = n - ligs;
      const parts = [`${chars} character${chars === 1 ? '' : 's'}`];
      if (ligs) parts.push(`${ligs} ligature${ligs === 1 ? '' : 's'}`);
      if (alts) parts.push(`${alts} alternate set${alts === 1 ? '' : 's'}`);
      if (live.weight != null) parts.push(`weight ${Math.round(live.weight * 100)}%`);
      $('#compileMeta').textContent = parts.join(' · ');
    }
    updateCoverage();
  }

  function updateCoverage() {
    const box = $('#coverage');
    const map = live.glyphMaps[0];
    if (!map) { box.textContent = ''; return; }
    const chars = Array.from($('#tester').textContent || '');
    const ligKeys = ST.metrics.ligatureKeys(map);
    const missing = new Set();
    for (let i = 0; i < chars.length;) {
      const ch = chars[i];
      if (ch === '\n' || ch === ' ') { i++; continue; }
      const lig = ST.metrics.ligatureAt(chars, i, ligKeys);
      if (lig) { i += lig.length; continue; }
      if (!map.has(ch.codePointAt(0))) missing.add(ch);
      i++;
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

  // One span per glyph: a character, or a captured ligature's letters kept
  // together so the font's substitution can fire (ligatures never form
  // across element boundaries).
  function rewrap(preserveCaret) {
    const el = tester();
    if (!el) return;
    hideSource();
    const text = el.textContent;
    const caret = preserveCaret ? getCaretOffset(el) : null;
    const st = ST.store.state.tester;
    const nMaps = live.glyphMaps.length;
    const cycling = st.cycle && nMaps > 1;
    const ligKeys = ST.metrics.ligatureKeys(live.glyphMaps[0]);
    const occurrence = {};
    el.textContent = '';
    const frag = g.document.createDocumentFragment();
    const chars = Array.from(text);
    let idx = 0;
    for (let i = 0; i < chars.length;) {
      const ch = chars[i];
      if (ch === '\n') {
        frag.appendChild(g.document.createTextNode('\n'));
        idx++; i++;
        continue;
      }
      const lig = ST.metrics.ligatureAt(chars, i, ligKeys);
      const key = lig || ch;
      const span = g.document.createElement('span');
      span.className = 'tl';
      span.dataset.i = idx;
      if (lig) span.dataset.lig = lig;
      span.textContent = key;
      if (cycling && key !== ' ') {
        const occ = occurrence[key] || 0;
        occurrence[key] = occ + 1;
        const k = occ % nMaps;
        if (k > 0) span.classList.add('cyc' + k);
      }
      const kern = live.kerns[idx];
      if (kern) span.style.marginLeft = kern + 'em';
      frag.appendChild(span);
      idx += key.length; i += key.length;
    }
    el.appendChild(frag);
    if (preserveCaret) setCaretOffset(el, caret);
    updateCoverage();
  }
  live.rewrap = rewrap;

  // ---------- source popup: hover a letter, see the photo it came from ----------
  let pop = null, popToken = 0;
  function outlineForSpan(span) {
    const k = +((span.className.match(/cyc(\d)/) || [0, 0])[1]);
    const maps = [live.glyphMaps[k], live.glyphMaps[0]].filter(Boolean);
    const lig = span.dataset.lig;
    const cp = span.textContent.codePointAt(0);
    for (const m of maps) {
      const o = lig ? (m.liga && m.liga.get(lig)) : (m.has(cp) ? m.get(cp) : null);
      if (o) return o;
    }
    return null;
  }
  function showSource(span) {
    const outline = outlineForSpan(span);
    hideSource();
    if (!outline || !outline.id || !ST.sources) return;
    const token = ++popToken;
    ST.sources.get(outline.id).then((url) => {
      if (token !== popToken || !url) return;
      if (!pop) {
        pop = ST.el('div', { class: 'src-pop' });
        g.document.body.appendChild(pop);
      }
      pop.innerHTML = '';
      pop.appendChild(ST.el('img', { src: url, alt: '' }));
      pop.appendChild(ST.el('div', { class: 'src-pop-label' }, outline.char || ''));
      pop.classList.add('on');
      const r = span.getBoundingClientRect();
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      let x = r.left + r.width / 2 - pw / 2;
      let y = r.top - ph - 8;
      x = Math.max(6, Math.min(g.innerWidth - pw - 6, x));
      if (y < 6) y = r.bottom + 8;
      pop.style.left = x + 'px';
      pop.style.top = y + 'px';
    });
  }
  function hideSource() {
    popToken++;
    if (pop) pop.classList.remove('on');
  }
  live.showSource = showSource;
  live.hideSource = hideSource;

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
    $('#weightToggle').checked = !!st.weightOn;
    $('#weightRange').value = st.weight == null ? 50 : st.weight;
    $('#weightRange').disabled = !st.weightOn;
    $('#cycleToggle').disabled = !!st.weightOn;
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
    // weight: the font recompiles with each slot's nearest-weight variant
    const rebuildForWeight = ST.debounce(() => live.rebuild(), 120);
    $('#weightToggle').addEventListener('change', (e) => {
      upd({ weightOn: e.target.checked });
      live.rebuild();
    });
    $('#weightRange').addEventListener('input', (e) => {
      upd({ weight: +e.target.value });
      rebuildForWeight();
    });

    // hover a letterform → the photo it was cut from
    el.addEventListener('mouseover', (e) => {
      const span = e.target.closest && e.target.closest('span.tl');
      if (span) showSource(span); else hideSource();
    });
    el.addEventListener('mouseleave', hideSource);
    g.addEventListener('scroll', hideSource, true);

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
