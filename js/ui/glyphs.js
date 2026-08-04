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
      c.strokeStyle = 'rgba(255,255,255,0.14)';
      c.lineWidth = 1;
      for (const fu of [ST.metrics.CAP, ST.metrics.XH, ST.metrics.DESC]) {
        c.beginPath(); c.moveTo(2, yOf(fu)); c.lineTo(W - 2, yOf(fu)); c.stroke();
      }
      c.strokeStyle = 'rgba(255,92,31,0.6)';
      c.beginPath(); c.moveTo(2, yOf(0)); c.lineTo(W - 2, yOf(0)); c.stroke();
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
    c.fillStyle = '#f4f2ec';
    c.fill(path, 'nonzero');
    return { fin, s, ox, yOf };
  }

  function renderGrid() {
    const sections = [
      ['CAPS', ST.CHARSET.caps], ['LOWERCASE', ST.CHARSET.lower],
      ['NUMERALS', ST.CHARSET.digits], ['MARKS', ST.CHARSET.marks],
    ];
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
        'Nothing captured for this character yet. Find it on a wall.'));
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
      el('div', { class: 'panel-label' }, 'OPTICAL NUDGES'),
      mkNudge('SIZE %', 'scale', 2),
      mkNudge('BASELINE', 'dy', 10),
      mkNudge('LEFT SB', 'dl', 8),
      mkNudge('RIGHT SB', 'dr', 8),
      el('div', { class: 'drawer-actions' },
        el('button', { class: 'ghost sm', onclick: () => ST.store.resetNudge(ch, active) }, 'RESET FIT'),
        el('button', {
          class: 'ghost sm danger',
          onclick: () => { ST.store.deleteVariant(ch, active); },
        }, 'DELETE THIS LETTERFORM'),
      ),
    ));
  }

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
    });
    renderGrid();
  };
})(typeof window !== 'undefined' ? window : globalThis);
