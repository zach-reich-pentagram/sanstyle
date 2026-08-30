/* SANSTYLE — classify.js
 * Which character is this? A template classifier that runs entirely in the
 * browser: candidate letterforms are normalized onto a small grid and scored
 * (soft IoU + counter-count + aspect) against A–Z/0–9 rendered in several
 * system font families. It's a guess engine, not an oracle — predictions are
 * always surfaced for human confirmation in the review flow.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const cls = (ST.classify = {});

  const GRID = 24;
  cls.GRID = GRID;
  cls.charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$&@!?'.split('');

  // ---------- pure scoring (Node-testable) ----------
  // Soft IoU between two continuous occupancy grids.
  cls.gridIoU = function (a, b) {
    let inter = 0, uni = 0;
    for (let i = 0; i < a.length; i++) {
      inter += Math.min(a[i], b[i]);
      uni += Math.max(a[i], b[i]);
    }
    return uni > 0 ? inter / uni : 0;
  };

  // Downsample a binary mask's ink bbox onto GRID×GRID, aspect preserved and
  // centered; each cell holds mean coverage 0..1. Returns {grid, aspect}.
  cls.gridFromMask = function (mask, w, h) {
    const bb = ST.raster.maskBounds(mask, w, h);
    if (!bb) return null;
    const s = Math.min(GRID / bb.w, GRID / bb.h);
    const gw = Math.max(1, Math.round(bb.w * s));
    const gh = Math.max(1, Math.round(bb.h * s));
    const ox = Math.floor((GRID - gw) / 2), oy = Math.floor((GRID - gh) / 2);
    const grid = new Float32Array(GRID * GRID);
    for (let gy = 0; gy < gh; gy++) {
      const y0 = bb.y0 + (gy / gh) * bb.h, y1 = bb.y0 + ((gy + 1) / gh) * bb.h;
      for (let gx = 0; gx < gw; gx++) {
        const x0 = bb.x0 + (gx / gw) * bb.w, x1 = bb.x0 + ((gx + 1) / gw) * bb.w;
        let sum = 0, n = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            if (x >= 0 && y >= 0 && x < w && y < h) { sum += mask[y * w + x]; n++; }
          }
        }
        grid[(oy + gy) * GRID + (ox + gx)] = n ? sum / n : 0;
      }
    }
    return { grid, aspect: bb.w / bb.h };
  };

  cls.compare = function (probe, tmpl) {
    let score = cls.gridIoU(probe.grid, tmpl.grid);
    const holeDiff = Math.abs((probe.holes || 0) - (tmpl.holes || 0));
    score *= holeDiff === 0 ? 1.06 : holeDiff === 1 ? 0.9 : 0.72;
    const aspectRatio = Math.abs(Math.log((probe.aspect || 1) / (tmpl.aspect || 1)));
    score *= Math.max(0.55, 1 - aspectRatio * 0.35);
    return score;
  };

  // ---------- browser-side template building ----------
  const FONT_STACKS = [
    '400 76px sans-serif', '700 76px sans-serif',
    '400 76px serif', '700 76px serif',
    '400 76px monospace', '400 76px cursive',
  ];
  let templates = null;

  function countHoles(mask, w, h) {
    // enclosed background components = counters
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
    const { labels, sizes } = ST.raster.components(inv, w, h);
    const touches = new Uint8Array(sizes.length);
    for (let x = 0; x < w; x++) { touches[labels[x]] = 1; touches[labels[(h - 1) * w + x]] = 1; }
    for (let y = 0; y < h; y++) { touches[labels[y * w]] = 1; touches[labels[y * w + w - 1]] = 1; }
    let holes = 0;
    for (let i = 1; i < sizes.length; i++) if (!touches[i] && sizes[i] > 8) holes++;
    return holes;
  }

  function maskFromCanvas(cnv) {
    const c = cnv.getContext('2d');
    const d = c.getImageData(0, 0, cnv.width, cnv.height);
    const mask = new Uint8Array(cnv.width * cnv.height);
    for (let i = 0; i < mask.length; i++) mask[i] = d.data[i * 4 + 3] > 96 ? 1 : 0;
    return mask;
  }

  cls.buildTemplates = function () {
    if (templates) return templates;
    templates = [];
    const size = 110;
    const cnv = g.document.createElement('canvas');
    cnv.width = size; cnv.height = size;
    const c = cnv.getContext('2d');
    for (const ch of cls.charset) {
      for (const font of FONT_STACKS) {
        c.clearRect(0, 0, size, size);
        c.font = font;
        c.textBaseline = 'middle';
        c.textAlign = 'center';
        c.fillStyle = '#000';
        c.fillText(ch, size / 2, size / 2);
        const mask = maskFromCanvas(cnv);
        const gridded = cls.gridFromMask(mask, size, size);
        if (!gridded) continue;
        templates.push({
          ch,
          grid: gridded.grid,
          aspect: gridded.aspect,
          holes: countHoles(mask, size, size),
        });
      }
    }
    return templates;
  };

  // Rasterize traced contours (crop-pixel space) to a probe descriptor.
  cls.probeFromPaths = function (paths) {
    const bb = ST.trace.boundsOf(paths);
    if (!bb || bb.w < 2 || bb.h < 2) return null;
    const size = 110;
    const s = Math.min((size - 8) / bb.w, (size - 8) / bb.h);
    const cnv = g.document.createElement('canvas');
    cnv.width = size; cnv.height = size;
    const c = cnv.getContext('2d');
    const path = new Path2D();
    for (const p of paths) {
      const cs = p.cubics;
      path.moveTo((cs[0][0].x - bb.x0) * s + 4, (cs[0][0].y - bb.y0) * s + 4);
      for (const cu of cs) {
        path.bezierCurveTo(
          (cu[1].x - bb.x0) * s + 4, (cu[1].y - bb.y0) * s + 4,
          (cu[2].x - bb.x0) * s + 4, (cu[2].y - bb.y0) * s + 4,
          (cu[3].x - bb.x0) * s + 4, (cu[3].y - bb.y0) * s + 4
        );
      }
      path.closePath();
    }
    c.fillStyle = '#000';
    c.fill(path, 'nonzero');
    const mask = maskFromCanvas(cnv);
    const gridded = cls.gridFromMask(mask, size, size);
    if (!gridded) return null;
    let holes = 0;
    for (const p of paths) if (p.area < 0) holes++;
    return { grid: gridded.grid, aspect: gridded.aspect, holes };
  };

  /**
   * How well do these traced contours match one specific character?
   * Returns the best template score (0..1-ish) — used by the letter-first
   * review flow to pick which detected blob is the letter the user typed.
   */
  cls.scoreFor = function (paths, ch) {
    const probe = cls.probeFromPaths(paths);
    if (!probe) return 0;
    const upper = (ch || '').toUpperCase();
    let best = 0;
    for (const t of cls.buildTemplates()) {
      if (t.ch !== upper && t.ch !== ch) continue;
      const s = cls.compare(probe, t);
      if (s > best) best = s;
    }
    return best;
  };

  /**
   * Rank character guesses for traced contours.
   * Returns [{ch, score}] best-first, plus .confidence (0..1) on the array.
   */
  cls.classifyPaths = function (paths) {
    const probe = cls.probeFromPaths(paths);
    if (!probe) return null;
    const tpl = cls.buildTemplates();
    const best = {};
    for (const t of tpl) {
      const s = cls.compare(probe, t);
      if (!(t.ch in best) || s > best[t.ch]) best[t.ch] = s;
    }
    const ranked = Object.keys(best)
      .map((ch) => ({ ch, score: best[ch] }))
      .sort((a, b) => b.score - a.score);
    const top = ranked[0], second = ranked[1];
    const margin = top && second ? top.score - second.score : 0;
    ranked.confidence = top ? Math.max(0, Math.min(1, top.score * 0.75 + margin * 2.2)) : 0;
    return ranked;
  };
})(typeof window !== 'undefined' ? window : globalThis);
