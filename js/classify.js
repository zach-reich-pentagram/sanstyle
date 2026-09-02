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

  // ---------- template-guided localization ("isolate the 2") ----------
  function integralImage(mask, w, h) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 1; y <= h; y++) {
      let row = 0;
      for (let x = 1; x <= w; x++) {
        row += mask[(y - 1) * w + (x - 1)];
        I[y * (w + 1) + x] = I[(y - 1) * (w + 1) + x] + row;
      }
    }
    return (x0, y0, x1, y1) => // sum over [x0,x1) × [y0,y1)
      I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
  }

  // Coverage grid of the mask inside box b (GRID×GRID, aspect preserved
  // exactly like gridFromMask so it's comparable with the templates).
  function gridInBox(sum, b) {
    const s = Math.min(GRID / b.w, GRID / b.h);
    const gw = Math.max(1, Math.round(b.w * s)), gh = Math.max(1, Math.round(b.h * s));
    const ox = Math.floor((GRID - gw) / 2), oy = Math.floor((GRID - gh) / 2);
    const grid = new Float32Array(GRID * GRID);
    for (let gy = 0; gy < gh; gy++) {
      const y0 = Math.floor(b.y + (gy / gh) * b.h), y1 = Math.max(y0 + 1, Math.floor(b.y + ((gy + 1) / gh) * b.h));
      for (let gx = 0; gx < gw; gx++) {
        const x0 = Math.floor(b.x + (gx / gw) * b.w), x1 = Math.max(x0 + 1, Math.floor(b.x + ((gx + 1) / gw) * b.w));
        grid[(oy + gy) * GRID + (ox + gx)] = sum(x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
      }
    }
    return grid;
  }

  // Chamfer distance transform on a GRID×GRID binary grid (two-pass, 1/√2
  // weights): each cell's distance to the nearest ink cell.
  function distanceTransform(bin) {
    const INF = 1e6, D = 1.41421;
    const d = new Float32Array(GRID * GRID);
    for (let i = 0; i < d.length; i++) d[i] = bin[i] ? 0 : INF;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const i = y * GRID + x;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) {
          v = Math.min(v, d[i - GRID] + 1);
          if (x > 0) v = Math.min(v, d[i - GRID - 1] + D);
          if (x < GRID - 1) v = Math.min(v, d[i - GRID + 1] + D);
        }
        d[i] = v;
      }
    }
    for (let y = GRID - 1; y >= 0; y--) {
      for (let x = GRID - 1; x >= 0; x--) {
        const i = y * GRID + x;
        let v = d[i];
        if (x < GRID - 1) v = Math.min(v, d[i + 1] + 1);
        if (y < GRID - 1) {
          v = Math.min(v, d[i + GRID] + 1);
          if (x < GRID - 1) v = Math.min(v, d[i + GRID + 1] + D);
          if (x > 0) v = Math.min(v, d[i + GRID - 1] + D);
        }
        d[i] = v;
      }
    }
    return d;
  }

  function binarize(grid, t) {
    const b = new Uint8Array(grid.length);
    for (let i = 0; i < grid.length; i++) b[i] = grid[i] > t ? 1 : 0;
    return b;
  }

  // Shape match that doesn't care about stroke weight: how close the probe's
  // ink lies to the template's (precision) and how much of the template's
  // ink the probe reaches (recall), combined as their harmonic mean. Unlike
  // plain IoU it doesn't reward a small box where a lone stroke looks fat —
  // a box must cover the whole letter to score.
  const SIGMA2 = 2 * 1.6 * 1.6;
  function chamferScore(probeGrid, tpl) {
    if (!tpl.bin) { tpl.bin = binarize(tpl.grid, 0.3); tpl.dt = distanceTransform(tpl.bin); }
    const pb = binarize(probeGrid, 0.2);
    let pn = 0;
    for (let i = 0; i < pb.length; i++) pn += pb[i];
    if (!pn) return 0;
    const pd = distanceTransform(pb);
    let prec = 0, rec = 0, tn = 0;
    for (let i = 0; i < pb.length; i++) {
      if (pb[i]) prec += Math.exp(-(tpl.dt[i] * tpl.dt[i]) / SIGMA2);
      if (tpl.bin[i]) { rec += Math.exp(-(pd[i] * pd[i]) / SIGMA2); tn++; }
    }
    prec /= pn; rec /= tn || 1;
    return prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
  }
  cls.chamferScore = chamferScore;

  function boxIoU(a, b) {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const inter = ix * iy;
    return inter / (a.w * a.h + b.w * b.h - inter);
  }

  // The ink inside box `b` that is connected (within the box) to the click:
  // a letter is one connected stroke system, so a box that scores well only
  // thanks to a neighbor's disconnected piece loses that piece here.
  // Nearest ink pixel to (cx, cy) in the whole mask, as [x, y] or null.
  function nearestInkTo(mask, w, h, cx, cy) {
    let bd = Infinity, bi = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bd) { bd = d; bi = y * w + x; }
      }
    }
    return bi < 0 ? null : [bi % w, (bi / w) | 0];
  }

  function componentInBox(mask, w, h, b, cx, cy, start) {
    const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
    const x1 = Math.min(w, b.x + b.w), y1 = Math.min(h, b.y + b.h);
    const boxed = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) boxed[y * w + x] = mask[y * w + x];
    let sx = Math.round(cx), sy = Math.round(cy);
    if (sx < x0 || sy < y0 || sx >= x1 || sy >= y1) return null;
    if (!boxed[sy * w + sx]) {
      // the click (or a fallback at the shape's center, which for a "#" or
      // an "O" is empty space) → the nearest ink, precomputed once
      if (!start || !boxed[start[1] * w + start[0]]) return null;
      sx = start[0]; sy = start[1];
    }
    const comp = ST.raster.floodFrom(w, h, sx, sy, (i) => boxed[i] === 1);
    if (!comp.count) return null;
    return { mask: comp.mask, count: comp.count, sum: integralImage(comp.mask, w, h) };
  }

  /**
   * Where inside this (possibly fused) mask is the character `ch`?
   * Searches boxes over positions, heights, and aspect multipliers, scoring
   * the mask coverage inside each box against every template of `ch` with
   * the stroke-weight-agnostic chamfer match. With opts.cx/cy (the click
   * that traced the shape) only boxes around the click count, and the best
   * few are re-scored on the ink connected to the click inside the box.
   * Returns { box: {x,y,w,h}, score, ch, coarse } or null.
   */
  cls.locate = function (mask, w, h, ch, opts) {
    const o = opts || {};
    const bb = ST.raster.maskBounds(mask, w, h);
    if (!bb) return null;
    const tpls = cls.buildTemplates().filter((t) => t.ch === ch.toUpperCase() || t.ch === ch);
    if (!tpls.length) return null;
    const sum = integralImage(mask, w, h);
    const hasClick = Number.isFinite(o.cx) && Number.isFinite(o.cy);
    const holds = (b) => {
      if (!hasClick) return true;
      const mx = b.w * 0.05, my = b.h * 0.05;
      return o.cx >= b.x - mx && o.cx < b.x + b.w + mx && o.cy >= b.y - my && o.cy < b.y + b.h + my;
    };
    // a short list of distinct candidates (non-max suppression on overlap)
    const cands = [];
    const consider = (box, score, tpl) => {
      for (let i = 0; i < cands.length; i++) {
        if (boxIoU(cands[i].box, box) >= 0.5) {
          if (score > cands[i].score) cands[i] = { box, score, tpl };
          return;
        }
      }
      if (cands.length < 12) { cands.push({ box, score, tpl }); return; }
      let worst = 0;
      for (let i = 1; i < cands.length; i++) if (cands[i].score < cands[worst].score) worst = i;
      if (score > cands[worst].score) cands[worst] = { box, score, tpl };
    };
    const hSteps = [1.0, 0.92, 0.85, 0.78, 0.72, 0.66, 0.6, 0.55, 0.5, 0.46, 0.42];
    const aMul = [0.75, 1.0, 1.3, 1.65];
    for (const t of tpls) {
      for (const hs of hSteps) {
        const bh = Math.max(8, Math.round(bb.h * hs));
        for (const am of aMul) {
          const bw = Math.max(8, Math.min(Math.round(bh * t.aspect * am), bb.w));
          const stepX = Math.max(2, Math.round((bb.w - bw) / 9));
          const stepY = Math.max(2, Math.round((bb.h - bh) / 9));
          for (let y = bb.y0; y + bh <= bb.y1 + 1; y += stepY) {
            for (let x = bb.x0; x + bw <= bb.x1 + 1; x += stepX) {
              const box = { x, y, w: bw, h: bh };
              if (holds(box)) {
                const fill = sum(x, y, x + bw, y + bh) / (bw * bh);
                if (fill >= 0.04) consider(box, chamferScore(gridInBox(sum, box), t), t);
              }
              if (bw >= bb.w) break;
            }
            if (bh >= bb.h) break;
          }
        }
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    const coarse = { box: cands[0].box, score: cands[0].score };
    let scoreOf = (b, tpl) => chamferScore(gridInBox(sum, b), tpl);
    if (hasClick) {
      const start = nearestInkTo(mask, w, h, o.cx, o.cy);
      scoreOf = (b, tpl) => {
        const comp = componentInBox(mask, w, h, b, o.cx, o.cy, start);
        return comp ? chamferScore(gridInBox(comp.sum, b), tpl) : 0;
      };
      for (const c of cands) c.score = scoreOf(c.box, c.tpl);
      cands.sort((a, b) => b.score - a.score);
    }
    let best = { box: cands[0].box, score: cands[0].score, ch: cands[0].tpl.ch, tpl: cands[0].tpl };
    if (o.refine === false) return { box: best.box, score: best.score, ch: best.ch, coarse };
    // tighten: hill-climb each box edge until the match stops improving,
    // so the box hugs the letter rather than the coarse search grid
    const moves = [[1, 0, 0, 0], [-1, 0, 0, 0], [0, 1, 0, 0], [0, -1, 0, 0], [0, 0, 1, 0], [0, 0, -1, 0],
      [0, 0, 0, 1], [0, 0, 0, -1], [-1, 0, 1, 0], [0, -1, 0, 1]];
    let step = Math.max(2, Math.round(Math.max(best.box.w, best.box.h) * 0.04));
    while (step >= 1) {
      let improved = false;
      for (const [mx, my, mw, mh] of moves) {
        const b = { x: best.box.x + mx * step, y: best.box.y + my * step, w: best.box.w + mw * step, h: best.box.h + mh * step };
        if (b.w < 8 || b.h < 8 || b.x < 0 || b.y < 0 || b.x + b.w > w || b.y + b.h > h || !holds(b)) continue;
        const score = scoreOf(b, best.tpl);
        if (score > best.score + 1e-4) { best = { box: b, score, ch: best.ch, tpl: best.tpl }; improved = true; break; }
      }
      if (!improved) step = Math.floor(step / 2);
    }
    return { box: best.box, score: best.score, ch: best.ch, coarse };
  };

  /**
   * Trim a mask to the located character: keep ink inside the box (with a
   * small margin) that is connected to the click. Returns {mask, score,
   * box, margin: {x0,y0,x1,y1} (the box actually cut along)} or null when
   * no confident match.
   */
  cls.isolate = function (mask, w, h, ch, cx, cy, minScore) {
    const found = cls.locate(mask, w, h, ch, { cx, cy });
    if (!found || found.score < (minScore == null ? 0.45 : minScore)) return null;
    const b = found.box;
    const mx = Math.round(b.w * 0.07), my = Math.round(b.h * 0.07);
    const x0 = Math.max(0, b.x - mx), x1 = Math.min(w, b.x + b.w + mx);
    const y0 = Math.max(0, b.y - my), y1 = Math.min(h, b.y + b.h + my);
    const boxed = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) boxed[y * w + x] = mask[y * w + x];
    // component under (or nearest to) the click, else the largest
    let sx = Math.round(cx), sy = Math.round(cy);
    if (!boxed[sy * w + sx]) {
      let bd = Infinity;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (boxed[y * w + x]) {
          const d = (x - cx) ** 2 + (y - cy) ** 2;
          if (d < bd) { bd = d; sx = x; sy = y; }
        }
      }
    }
    const comp = ST.raster.floodFrom(w, h, sx, sy, (i) => boxed[i] === 1);
    if (comp.count < 30) return null;
    return { mask: comp.mask, score: found.score, box: found.box, margin: { x0, y0, x1, y1 } };
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
