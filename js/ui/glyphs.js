/* SANSTYLE — ui/glyphs.js
 * The glyph library: full character grid, per-slot variants, activation,
 * nudge controls, delete. Everything redraws off store 'change' events.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$, el = ST.el;

  const ui = (ST.glyphsUI = { openChar: null });

  function drawGlyphInto(canvas, variant, withMetrics) {
    const c = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    const fin = ST.metrics.finalizeVariant(variant);

    const top = ST.metrics.ASC + 70, bottom = ST.metrics.DESC - 60;
    const span = top - bottom;
    let s = (H - 8) / span;
    if (fin.advance * s > W - 8) s = (W - 8) / fin.advance;
    const ox = (W - fin.advance * s) / 2;
    const yOf = (fu) => 4 + (top - fu) * s;

    if (withMetrics) {
      c.strokeStyle = '#000';
      c.lineWidth = 1;
      for (const fu of [ST.metrics.CAP, ST.metrics.XH, 0, ST.metrics.DESC]) {
        const y = Math.round(yOf(fu)) + 0.5;
        c.beginPath(); c.moveTo(2, y); c.lineTo(W - 2, y); c.stroke();
      }
    }

    const path = new Path2D();
    for (const cont of fin.contours) {
      const cs = cont.cubics;
      path.moveTo(ox + (cs[0][0].x + fin.lsb) * s, yOf(cs[0][0].y));
      for (const cu of cs) {
        path.bezierCurveTo(
          ox + (cu[1].x + fin.lsb) * s, yOf(cu[1].y),
          ox + (cu[2].x + fin.lsb) * s, yOf(cu[2].y),
          ox + (cu[3].x + fin.lsb) * s, yOf(cu[3].y)
        );
      }
      path.closePath();
    }
    c.fillStyle = '#000';
    c.fill(path, 'nonzero');
    return { fin, s, ox, yOf };
  }

  function renderGrid() {
    const sections = [
      ['Caps', ST.CHARSET.caps], ['Lowercase', ST.CHARSET.lower],
      ['Numerals', ST.CHARSET.digits], ['Marks', ST.CHARSET.marks],
    ];
    // captured ligatures ("ar", "bl") — the font swaps them in for the sequence
    const ligKeys = ST.store.filledChars().filter((k) => k.length > 1);
    if (ligKeys.length) sections.push(['Ligatures', ligKeys]);
    const root = $('#glyphGrid');
    root.innerHTML = '';
    for (const [label, chars] of sections) {
      root.appendChild(el('div', { class: 'grid-label' }, label));
      const grid = el('div', { class: 'char-grid' });
      for (const ch of chars) {
        const slot = ST.store.slot(ch);
        const cell = el('button', {
          class: 'char-cell' + (slot ? ' filled' : ''),
          'data-char': ch,
          onclick: () => openDrawer(ch),
        });
        if (slot) {
          const cnv = el('canvas', { width: 56, height: 56, class: 'cell-canvas' });
          drawGlyphInto(cnv, ST.store.activeVariant(ch), false);
          cell.appendChild(cnv);
          if (slot.variants.length > 1) {
            cell.appendChild(el('span', { class: 'cell-count' }, String(slot.variants.length)));
          }
          cell.appendChild(el('span', { class: 'cell-char' }, ch));
        } else {
          cell.appendChild(el('span', { class: 'cell-empty' }, ch));
        }
        grid.appendChild(cell);
      }
      root.appendChild(grid);
    }
    $('#glyphCount').textContent =
      `${ST.store.count()} characters · ${ST.store.variantCount()} letterforms captured`;
  }

  // ---------- drawer ----------
  function openDrawer(ch) {
    ui.openChar = ch;
    renderDrawer();
    $('#glyphDrawer').classList.add('open');
  }

  function closeDrawer() {
    ui.openChar = null;
    $('#glyphDrawer').classList.remove('open');
  }

  function renderDrawer() {
    const ch = ui.openChar;
    const body = $('#drawerBody');
    if (!ch) return;
    const slot = ST.store.slot(ch);
    body.innerHTML = '';
    $('#drawerChar').textContent = ch;

    if (!slot) {
      body.appendChild(el('p', { class: 'dim drawer-empty' },
        'Nothing captured for this character yet.'));
      return;
    }

    const active = slot.active;
    const v = slot.variants[active];

    const big = el('canvas', { width: 300, height: 260, class: 'drawer-canvas' });
    drawGlyphInto(big, v, true);
    body.appendChild(big);

    // variant strip
    const strip = el('div', { class: 'variant-strip' });
    slot.variants.forEach((variant, i) => {
      const b = el('button', {
        class: 'variant-thumb' + (i === active ? ' active' : ''),
        title: `variant ${i + 1}`,
        onclick: () => ST.store.setActive(ch, i),
      });
      if (variant.thumb) {
        b.appendChild(el('img', { src: variant.thumb, alt: '' }));
      } else {
        const c = el('canvas', { width: 48, height: 48 });
        drawGlyphInto(c, variant, false);
        b.appendChild(c);
      }
      strip.appendChild(b);
    });
    body.appendChild(strip);

    // nudges
    const mkNudge = (label, key, step) => {
      const row = el('div', { class: 'nudge-row' },
        el('span', { class: 'nudge-label' }, label),
        el('button', { class: 'nudge-btn', onclick: () => nudge(key, -step) }, '−'),
        el('span', { class: 'nudge-val' }, String((v.nudge && v.nudge[key]) || 0)),
        el('button', { class: 'nudge-btn', onclick: () => nudge(key, step) }, '+'),
      );
      return row;
    };
    const nudge = (key, delta) => {
      const cur = (v.nudge && v.nudge[key]) || 0;
      ST.store.updateNudge(ch, active, { [key]: cur + delta });
    };
    body.appendChild(el('div', { class: 'nudge-box' },
      el('div', { class: 'panel-label' }, 'Optical nudges'),
      mkNudge('Size %', 'scale', 2),
      mkNudge('Baseline', 'dy', 10),
      mkNudge('Left side', 'dl', 8),
      mkNudge('Right side', 'dr', 8),
      el('div', { class: 'drawer-actions' },
        el('button', { class: 'ghost sm', onclick: () => ST.store.resetNudge(ch, active) }, 'Reset fit'),
        el('button', {
          class: 'ghost sm danger',
          onclick: () => { ST.store.deleteVariant(ch, active); },
        }, 'Delete this letterform'),
      ),
    ));
  }

  // ---------- photos in Drive ----------
  // Every photo in the inbox folder, thumbnails through the api. Photos that
  // already gave a letterform are grayed; click any of them to extract
  // again — the photo lands on the capture stage like a fresh upload.
  let photos = null, photosAt = 0, photosLoading = false;

  ui.refreshPhotos = async function (force) {
    if (!ST.sync || !ST.sync.unlocked) { renderPhotos(); return; }
    if (!force && photos && Date.now() - photosAt < 60000) { renderPhotos(); return; }
    if (photosLoading) return;
    photosLoading = true;
    renderPhotos();
    try {
      photos = await ST.sync.listPhotos();
      photosAt = Date.now();
    } catch (e) {
      photos = photos || [];
    }
    photosLoading = false;
    renderPhotos();
  };

  function renderPhotos() {
    const root = $('#photoGallery');
    if (!root) return;
    const on = !!(ST.sync && ST.sync.unlocked);
    root.style.display = on ? '' : 'none';
    root.innerHTML = '';
    if (!on) return;
    const done = new Set(ST.store.state.processedPhotos || []);
    const list = photos || [];
    root.appendChild(el('div', { class: 'glyphs-head' },
      el('div', { class: 'grid-label' }, `Photos in Drive${list.length ? ` (${list.length})` : ''}`),
      el('button', { class: 'pill sm', onclick: () => ui.refreshPhotos(true) }, photosLoading ? 'Loading…' : 'Refresh'),
    ));
    root.appendChild(el('p', { class: 'dim' },
      'Click a photo to extract letterforms from it again. Grayed photos have already given letterforms.'));
    const grid = el('div', { class: 'photo-grid' });
    for (const p of list) {
      const used = done.has(p.id);
      const card = el('button', {
        class: 'photo-card' + (used ? ' done' : ''),
        'data-photo': p.id,
        title: (p.name || 'photo') + (used ? ' — already extracted; click to extract again' : ' — new'),
        onclick: () => ST.sync.extractPhoto(p),
      });
      const img = el('img', { alt: p.name || '' });
      card.appendChild(img);
      card.appendChild(el('span', { class: 'photo-name' }, p.name || ''));
      grid.appendChild(card);
      ST.sync.photoThumb(p.id).then((url) => { img.src = url; }).catch(() => card.classList.add('broken'));
    }
    if (!list.length && !photosLoading) grid.appendChild(el('div', { class: 'dim' }, 'No photos in the Drive inbox yet.'));
    root.appendChild(grid);
  }
  ui.renderPhotos = renderPhotos;

  ui.init = function () {
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#glyphDrawer').addEventListener('click', (e) => {
      if (e.target === $('#glyphDrawer')) closeDrawer();
    });

    $('#exportBtn').addEventListener('click', () => {
      const blob = new Blob([ST.store.exportJSON()], { type: 'application/json' });
      const a = el('a', {
        href: URL.createObjectURL(blob),
        download: `${ST.store.state.fontName.toLowerCase().replace(/\s+/g, '-')}-library.json`,
      });
      g.document.body.appendChild(a); a.click(); a.remove();
      ST.toast('Library exported — share the JSON, merge it anywhere.');
    });
    $('#importInput').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      f.text().then((text) => {
        try {
          const added = ST.store.importJSON(text, true);
          ST.toast(`Merged ${added} letterform${added === 1 ? '' : 's'} into the library.`);
        } catch (err) {
          ST.toast('Import failed: ' + err.message, 'warn');
        }
      });
      e.target.value = '';
    });
    $('#importBtn').addEventListener('click', () => $('#importInput').click());
    $('#clearBtn').addEventListener('click', () => {
      if (g.confirm('Delete every captured letterform? Export first if you want to keep them.')) {
        ST.store.clearAll();
      }
    });

    ST.store.on('change', () => {
      renderGrid();
      if (ui.openChar) renderDrawer();
      renderPhotos();
    });
    renderGrid();
    renderPhotos();
  };
})(typeof window !== 'undefined' ? window : globalThis);
