/* Sanstyle — extract.js
 * Click-to-trace: seeded letterform extraction. From one click on the paint
 * it (1) samples the paint color, (2) grows the connected region in a
 * blurred color-distance field with an auto-calibrated tolerance — stepping
 * the tolerance up until the region suddenly floods into the wall, and
 * stopping just before — (3) cleans it with stroke-width-capped morphology,
 * (4) if the region seems to include a touching neighbor, offers a separated
 * version (open to break the contact, keep the clicked piece, reconstruct
 * its stroke width), and (5) traces it. Used by the review queue and the
 * studio's Click tool.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const R = ST.raster;
  const ex = (ST.extract = {});

  const TOLERANCES = [18, 26, 36, 48, 62, 80, 100, 125, 155];

  function seedColorAt(data, w, h, x, y) {
    let r = 0, gg = 0, b = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const p = (py * w + px) * 4;
        r += data[p]; gg += data[p + 1]; b += data[p + 2]; n++;
      }
    }
    return { r: r / n, g: gg / n, b: b / n };
  }

  // Paint/wall split from the field statistics in a window around the click
  // (Otsu on the quantized color-distance), in field units.
  function localOtsuTolerance(field, w, h, x, y) {
    const win = Math.round(Math.max(w, h) * 0.35);
    const x0 = Math.max(0, x - win), x1 = Math.min(w, x + win);
    const y0 = Math.max(0, y - win), y1 = Math.min(h, y + win);
    const q = new Uint8Array((x1 - x0) * (y1 - y0));
    let k = 0;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        q[k++] = Math.min(255, Math.round(field[yy * w + xx] * 0.5));
      }
    }
    return R.otsu(q, null) / 0.5;
  }

  function leaks(mask, count, w, h, maxFrac) {
    if (count > w * h * maxFrac) return true;
    const bb = R.maskBounds(mask, w, h);
    if (!bb) return true;
    if (bb.w * bb.h > w * h * 0.85) return true;
    const touch = (bb.x0 <= 0) + (bb.y0 <= 0) + (bb.x1 >= w - 1) + (bb.y1 >= h - 1);
    return touch >= 3;
  }

  // Grow at increasing tolerances up to (a bit past) the local Otsu split,
  // keeping the loosest region that doesn't leak into the wall. Uneven paint
  // density (dry-brush, chalk) makes the region grow in jumps as strokes
  // connect — those jumps are the letter, not a leak, so leak detection is
  // spatial (share of the image, frame coverage, borders touched), never
  // growth-based.
  function autoRegion(field, excl, w, h, x, y, opts) {
    const maxFrac = opts.maxFrac || 0.35;
    const minCount = opts.minCount || 150;
    const tOtsu = localOtsuTolerance(field, w, h, x, y);
    const cands = TOLERANCES.filter((t) => t <= tOtsu * 1.25).concat([tOtsu]).sort((a, b) => a - b);
    if (!cands.length) cands.push(tOtsu);
    // If the click landed on a cut (or a hole), start from the nearest
    // usable pixel instead of failing.
    if (excl && excl[y * w + x]) {
      const near = nearestWhere(w, h, x, y, 80, (i) => !excl[i] && field[i] <= cands[cands.length - 1]);
      if (near < 0) return null;
      x = near % w; y = (near / w) | 0;
    }
    const steps = [];
    for (const t of cands) {
      const res = R.floodFrom(w, h, x, y, (i) => field[i] <= t && !(excl && excl[i]));
      if (!res.count) continue;
      if (leaks(res.mask, res.count, w, h, maxFrac)) break;
      steps.push({ t, ...res });
    }
    if (!steps.length) return null;
    // Once the region plateaus, take the earliest tolerance that already
    // captured it — tighter to the paint, less haze at the edges.
    const final = steps[steps.length - 1];
    for (const s of steps) {
      if (s.count >= minCount && s.count >= final.count * 0.85) return s;
    }
    return final;
  }

  function nearestWhere(w, h, x, y, radius, pred) {
    let best = -1, bd = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const d = dx * dx + dy * dy;
        if (d >= bd) continue;
        const i = py * w + px;
        if (pred(i)) { bd = d; best = i; }
      }
    }
    return best;
  }

  // Rasterize cut strokes (canvas coords) into an exclusion mask.
  ex.cutMask = function (w, h, cuts) {
    if (!cuts || !cuts.length) return null;
    const excl = new Uint8Array(w * h);
    for (const c of cuts) {
      const half = Math.max(2, c.width / 2);
      const x0 = Math.max(0, Math.floor(Math.min(c.x0, c.x1) - half));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(c.x0, c.x1) + half));
      const y0 = Math.max(0, Math.floor(Math.min(c.y0, c.y1) - half));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(c.y0, c.y1) + half));
      const a = { x: c.x0, y: c.y0 }, b = { x: c.x1, y: c.y1 };
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (ST.geom.segDist({ x, y }, a, b) <= half) excl[y * w + x] = 1;
        }
      }
    }
    return excl;
  };

  function bboxOf(mask, w, h, pad) {
    const bb = R.maskBounds(mask, w, h);
    if (!bb) return null;
    const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
    const x1 = Math.min(w, bb.x1 + 1 + pad), y1 = Math.min(h, bb.y1 + 1 + pad);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function cropMask(mask, w, crop) {
    const out = new Uint8Array(crop.w * crop.h);
    for (let y = 0; y < crop.h; y++) {
      for (let x = 0; x < crop.w; x++) out[y * crop.w + x] = mask[(y + crop.y) * w + (x + crop.x)];
    }
    return out;
  }

  // Scale-aware clean-up shared with the studio: shave fingers, heal gaps,
  // never thinner than a third of the stroke.
  ex.cleanMask = function (mask, w, h, smoothing) {
    const sm = smoothing == null ? 4 : smoothing;
    let m = R.despeckle(mask, w, h, 0.04, 24);
    if (sm > 0) {
      const sw = R.strokeWidth(m, w, h);
      const rBase = sm * 1.2 * (Math.max(w, h) / 700);
      const r = Math.max(0, Math.min(Math.round(rBase), Math.floor(sw * 0.33)));
      if (r > 0) {
        m = R.close(m, w, h, r);
        m = R.open(m, w, h, r);
      }
    }
    m = R.fillHoles(m, w, h, 0.06);
    return m;
  };

  // Nearest ink pixel to (x,y) within radius, or -1.
  function nearestInk(mask, w, h, x, y, radius) {
    if (mask[y * w + x]) return y * w + x;
    let best = -1, bd = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const i = py * w + px;
        if (mask[i]) {
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    return best;
  }

  // Break weak contacts with touching neighbors: open, keep the piece under
  // the click, reconstruct stroke width inside the original region.
  ex.separateTouching = function (mask, w, h, x, y) {
    const sw = R.strokeWidth(mask, w, h);
    const r = Math.max(2, Math.round(sw * 0.45));
    const opened = R.open(mask, w, h, r);
    const seedIdx = nearestInk(opened, w, h, x, y, r * 2 + 2);
    if (seedIdx < 0) return null;
    const piece = R.floodFrom(w, h, seedIdx % w, (seedIdx / w) | 0, (i) => opened[i] === 1);
    if (!piece.count) return null;
    const rebuilt = R.reconstruct(piece.mask, mask, w, h, r + 1);
    const total = R.count(mask), got = R.count(rebuilt);
    if (got < total * 0.72 && got > 80) return rebuilt;
    return null;
  };

  /**
   * Seeded extraction from a click at canvas pixel (x, y).
   * Returns { seed, tolerance, region: {x,y,w,h}, candidates: [{crop, mask,
   *   w, h, paths, kind}] } or null when nothing paint-like is under the
   *   click. candidates[0] is the best guess (separated piece when a
   *   touching neighbor was detected, else the whole region).
   */
  ex.seeded = function (canvas, x, y, opts) {
    const o = Object.assign({ smoothing: 4, blur: 2, cuts: null }, opts || {});
    const w = canvas.width, h = canvas.height;
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const seed = seedColorAt(data, w, h, x, y);
    let field = R.colorDistMap(data, w, h, [seed]);
    if (o.blur > 0) field = R.blur(field, w, h, o.blur);
    const excl = ex.cutMask(w, h, o.cuts);
    const grown = autoRegion(field, excl, w, h, x, y, {});
    if (!grown || grown.count < 40) return null;

    const crop = bboxOf(grown.mask, w, h, 12);
    if (!crop) return null;
    const sub = cropMask(grown.mask, w, crop);
    const lx = x - crop.x, ly = y - crop.y;
    const whole = ex.cleanMask(sub, crop.w, crop.h, o.smoothing);

    const candidates = [];
    const push = (mask, kind) => {
      const paths = ST.trace.vectorize(mask, crop.w, crop.h, {});
      if (paths.length) candidates.push({ crop, mask, w: crop.w, h: crop.h, paths, kind });
    };
    const separated = ex.separateTouching(whole, crop.w, crop.h, lx, ly);
    if (separated) push(separated, 'separated');
    push(whole, 'whole');
    if (!candidates.length) return null;
    return { seed, tolerance: grown.t, region: crop, candidates };
  };
})(typeof window !== 'undefined' ? window : globalThis);
