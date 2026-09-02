/* Sanstyle — extract.js
 * Click-to-trace: seeded letterform extraction. From one click near the
 * paint it (1) snaps the click onto the paint — the strongest contrast
 * against the background near the click, so a click that lands in a
 * marker's bleed halo or just off a thin stroke still seeds from the stroke
 * — (2) samples and refines the paint color, (3) grows the connected region
 * in a blurred color-distance field at the tolerance whose boundary is
 * sharpest, never past the midpoint between paint and background,
 * (4) cleans it with stroke-width-capped morphology, (5) if the region
 * seems to include a touching neighbor, offers a separated version (open to
 * break the contact, keep the clicked piece, reconstruct its stroke width),
 * and (6) traces it. Used by the review queue and the studio's Click tool.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const R = ST.raster;
  const ex = (ST.extract = {});

  // Paint color under a click: the mean of the 5×5 sample — restricted, when
  // the background is known, to its most paint-like pixels, so a click near
  // a stroke's edge samples the paint rather than a paint/paper blend.
  function seedColorAt(data, w, h, x, y, bg) {
    const px = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const qx = x + dx, qy = y + dy;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const p = (qy * w + qx) * 4;
        const c = { r: data[p], g: data[p + 1], b: data[p + 2], ink: 0 };
        if (bg) c.ink = R.colorDist(c.r, c.g, c.b, bg.r, bg.g, bg.b);
        px.push(c);
      }
    }
    let cut = 0;
    if (bg) {
      let max = 0;
      for (const c of px) if (c.ink > max) max = c.ink;
      cut = max * 0.8;
    }
    let r = 0, gg = 0, b = 0, n = 0;
    for (const c of px) {
      if (c.ink < cut) continue;
      r += c.r; gg += c.g; b += c.b; n++;
    }
    return { r: r / n, g: gg / n, b: b / n };
  }

  function leaks(mask, count, w, h, maxFrac) {
    if (count > w * h * maxFrac) return true;
    const bb = R.maskBounds(mask, w, h);
    if (!bb) return true;
    if (bb.w * bb.h > w * h * 0.85) return true;
    const touch = (bb.x0 <= 0) + (bb.y0 <= 0) + (bb.x1 >= w - 1) + (bb.y1 >= h - 1);
    return touch >= 3;
  }

  // Grow at increasing tolerances and keep the region whose BOUNDARY is the
  // sharpest: the paint→paper edge is a steep transition in the color-
  // distance field, while a marker's bleed halo fades gradually. Choosing by
  // edge strength (not by a color split, which lands inside the halo, and
  // not by growth jumps, which uneven paint density also produces) is what
  // keeps the region on the stroke instead of flooding the haze between
  // letters. Leak detection stays spatial, and opts.maxTol (the paint↔
  // background midpoint) bounds how far a textured boundary can tempt it.
  const GROW_TOLERANCES = [14, 20, 28, 38, 50, 65, 82, 100, 125, 155, 190, 230];
  function autoRegion(field, excl, w, h, x, y, opts) {
    const maxFrac = opts.maxFrac || 0.35;
    const minCount = opts.minCount || 150;
    const maxTol = opts.maxTol || Infinity;
    // If the click landed on a cut (or a hole), start from the nearest
    // usable pixel instead of failing.
    if (excl && excl[y * w + x]) {
      const near = nearestWhere(w, h, x, y, 80, (i) => !excl[i] && field[i] <= 100);
      if (near < 0) return null;
      x = near % w; y = (near / w) | 0;
    }
    const grad = R.gradientMag(field, w, h);
    let best = null, fallback = null;
    for (const t of GROW_TOLERANCES) {
      if (t > maxTol) break;
      const res = R.floodFrom(w, h, x, y, (i) => field[i] <= t && !(excl && excl[i]));
      if (!res.count) continue;
      if (leaks(res.mask, res.count, w, h, maxFrac)) break;
      const { mean } = R.boundaryMeanGradient(res.mask, grad, w, h);
      const step = { t, ...res, score: mean };
      if (!fallback) fallback = step;
      if (res.count < minCount) continue;
      if (!best || mean > best.score * 1.02) best = step;
    }
    return best || fallback;
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

  // Background reference: the dominant color of the frame's border ring.
  // Even in a tight crop the border is mostly wall or paper, whereas the
  // whole image's mode can be the paint itself. Falls back to the whole
  // image when the border is too varied to vote.
  ex.backgroundColor = function (data, w, h) {
    const m = Math.max(3, Math.round(Math.min(w, h) * 0.08));
    const ring = R.dominantColor(data, w, h, (x, y) => x < m || y < m || x >= w - m || y >= h - m);
    if (ring && ring.frac >= 0.25) return ring;
    return R.dominantColor(data, w, h, null) || ring;
  };

  // Move an imprecise click onto the paint. In the window around the click,
  // contrast against the background is the paint-likeness; a click that is
  // not already on strong contrast jumps to the nearest strongly contrasting
  // pixel, and either way climbs to the densest paint nearby, so the seed
  // is taken inside the stroke rather than on its blended edge. A click in
  // a bleed halo or on the paper beside a thin stroke thus lands on it.
  function snapToInk(data, w, h, x, y, radius, bg) {
    const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius);
    const x1 = Math.min(w - 1, x + radius), y1 = Math.min(h - 1, y + radius);
    const ww = x1 - x0 + 1, wh = y1 - y0 + 1;
    const ink = new Float32Array(ww * wh);
    for (let yy = 0; yy < wh; yy++) {
      for (let xx = 0; xx < ww; xx++) {
        const p = ((yy + y0) * w + (xx + x0)) * 4;
        ink[yy * ww + xx] = R.colorDist(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b);
      }
    }
    const sm = R.blur(ink, ww, wh, 2);
    let max = 0;
    for (let i = 0; i < sm.length; i++) if (sm[i] > max) max = sm[i];
    if (max < 40) return { x, y, snapped: false };
    let cur = (y - y0) * ww + (x - x0);
    let snapped = false;
    if (sm[cur] < max * 0.6) {
      let best = -1, bd = Infinity;
      for (let yy = 0; yy < wh; yy++) {
        for (let xx = 0; xx < ww; xx++) {
          if (sm[yy * ww + xx] < max * 0.7) continue;
          const d = (xx + x0 - x) ** 2 + (yy + y0 - y) ** 2;
          if (d < bd) { bd = d; best = yy * ww + xx; }
        }
      }
      if (best < 0) return { x, y, snapped: false };
      cur = best; snapped = true;
    }
    // climb to the local maximum of paint-likeness (the stroke's core)
    for (let step = 0; step < radius * 2; step++) {
      const cx = cur % ww, cy = (cur / ww) | 0;
      let next = cur;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
          const j = ny * ww + nx;
          if (sm[j] > sm[next]) next = j;
        }
      }
      if (next === cur || sm[next] - sm[cur] < max * 0.02) break; // on the plateau already
      cur = next; snapped = true;
    }
    return { x: x0 + (cur % ww), y: y0 + ((cur / ww) | 0), snapped };
  }
  ex.snapToInk = snapToInk;

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
  // never thinner than a third of the stroke — then round the stroke ends:
  // a marker can't draw anything sharper than its tip, so needle points
  // thinner than the thin side of the tip become round caps.
  ex.cleanMask = function (mask, w, h, smoothing, opts) {
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
      if (!(opts && opts.noRound)) m = ex.roundEnds(m, w, h, null);
    }
    m = R.fillHoles(m, w, h, 0.06);
    m = R.despeckle(m, w, h, 0.04, 24);
    return m;
  };

  // Round stroke ends (everywhere, or only inside `region`): prune what a
  // disk of ~70% of the thin strokes' half-width can't reach, keeping thin
  // stretches that hold the shape together.
  ex.roundEnds = function (mask, w, h, region) {
    const dt = R.distanceTransform(mask, w, h);
    const rt = R.thinRadius(mask, w, h, dt, region);
    const r = Math.round(rt * 0.7);
    return r >= 2 ? R.pruneThin(mask, w, h, r, region) : mask;
  };

  // Where a cut sliced through the strokes, round the sliced ends with a
  // cap sized to the strokes that touch the cut (a cut through a thin bar
  // must not erase it, so the radius comes from the thinner side).
  ex.roundCutEnds = function (mask, w, h, band) {
    const dt = R.distanceTransform(mask, w, h);
    const ring = R.dilate(band, w, h, 2);
    let rmax = 0;
    for (let i = 0; i < ring.length; i++) if (ring[i] && dt[i] > rmax) rmax = dt[i];
    if (rmax < 2) return mask;
    const near = R.dilate(band, w, h, Math.ceil(rmax * 2) + 2);
    const rt = R.thinRadius(mask, w, h, dt, near);
    const r = Math.round((rt || rmax) * 0.9);
    return r >= 2 ? R.pruneThin(mask, w, h, r, near) : mask;
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
  // the click, reconstruct stroke width inside the original region. Only a
  // split at a genuinely thin neck counts — a letter's own sharp corner or
  // a full-width join must not be "separated" (that would hand back a
  // fragment of the letter); those are what cuts and Isolate are for.
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
    // a real neighbor split leaves a substantial piece; crumbs are noise
    if (!(got < total * 0.72 && got > Math.max(80, total * 0.12))) return null;
    // the contact: ink left behind that touches the piece. A neck narrower
    // than the stroke is a contact; anything wider is the letter itself.
    let contact = 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const i = yy * w + xx;
        if (!mask[i] || rebuilt[i]) continue;
        if ((xx > 0 && rebuilt[i - 1]) || (xx < w - 1 && rebuilt[i + 1]) ||
            (yy > 0 && rebuilt[i - w]) || (yy < h - 1 && rebuilt[i + w])) contact++;
      }
    }
    return contact < sw * 0.7 ? rebuilt : null;
  };

  // Breadth-first walk into `mask` from the crossing pixels `seeds`. The
  // join is where the front first lands on ink the template expects (the
  // letter proper, via isLetter), or — failing that — where the layers
  // widen because the front spread both ways along the letter's stroke.
  // Returns the spur mask up to just short of the join, or null when no
  // join was found within maxLen steps.
  function followSpur(mask, w, h, seeds, sw, maxLen, isLetter, slack) {
    const dist = new Int32Array(w * h).fill(-1);
    let frontier = seeds.slice();
    for (const s of frontier) dist[s] = 0;
    const layers = [frontier.length];
    let junction = -1, guided = -1;
    const onLetter = (list) => {
      if (!isLetter || !list.length) return false;
      let n = 0;
      for (const j of list) if (isLetter(j)) n++;
      return n >= list.length * 0.6;
    };
    if (onLetter(frontier)) return null; // the crossing already sits on the letter
    for (let k = 1; k <= maxLen && frontier.length; k++) {
      const next = [];
      for (const j of frontier) {
        const x = j % w, y = (j / w) | 0;
        if (x > 0 && mask[j - 1] && dist[j - 1] < 0) { dist[j - 1] = k; next.push(j - 1); }
        if (x < w - 1 && mask[j + 1] && dist[j + 1] < 0) { dist[j + 1] = k; next.push(j + 1); }
        if (y > 0 && mask[j - w] && dist[j - w] < 0) { dist[j - w] = k; next.push(j - w); }
        if (y < h - 1 && mask[j + w] && dist[j + w] < 0) { dist[j + w] = k; next.push(j + w); }
      }
      layers.push(next.length);
      frontier = next;
      // the template's ink begins here; keep looking a little further for
      // the actual join (the widening), which places the cut more exactly
      if (guided < 0 && onLetter(next)) guided = k;
      if (guided >= 0 && k > guided + (slack || 0)) { junction = guided; break; }
      if (k >= 4) {
        const win = layers.slice(1, Math.min(k - 1, 9)).sort((a, b) => a - b);
        const base = win[win.length >> 1];
        if (layers[k] > base * 1.6 && layers[k - 1] > base * 1.6) { junction = k - 1; guided = -1; break; }
      }
    }
    if (junction < 0 && guided >= 0) junction = guided;
    if (junction < 0) return null;
    // a widening registers only once the front is inside the letter's
    // stroke: stop a little short and let the heal close the notch
    const stop = Math.max(1, guided >= 0 ? junction : junction - Math.round(sw * 0.3));
    const spur = new Uint8Array(w * h);
    let n = 0;
    for (let i = 0; i < dist.length; i++) if (dist[i] >= 0 && dist[i] < stop) { spur[i] = 1; n++; }
    return n ? spur : null;
  }

  /**
   * "Cut off the excess": after a template box has been placed on a fused
   * shape, ink that enters the box from outside is either a bit of the
   * letter itself poking past a box that fit it imperfectly — a long tail,
   * a flourish: small, so it is given back — or a neighbor's stroke: big,
   * so it is followed inward from where it crosses the box edge to where
   * it merges into the letter, erased up to there, and the notch healed.
   * `full` is the fused mask (outside still present), `kept` the boxed
   * piece, box = {x0, y0, x1, y1} (exclusive x1/y1). `guide`, when given,
   * is {box: {x,y,w,h}, cells} — the template's placement and its
   * letterCells — and tells the walk where the letter's own ink begins.
   * Returns a mask.
   */
  ex.trimSpurs = function (full, kept, w, h, box, guide) {
    const sw = R.strokeWidth(kept, w, h);
    const keptCount = R.count(kept);
    if (!(sw > 1) || !keptCount) return kept;
    let isLetter = null, slack = 0;
    if (guide && guide.cells && ST.classify && ST.classify.cellOf) {
      isLetter = (i) => {
        const c = ST.classify.cellOf(guide.box, i % w, (i / w) | 0);
        return c >= 0 && guide.cells[c] === 1;
      };
      slack = Math.round((1.5 * Math.max(guide.box.w, guide.box.h)) / ST.classify.GRID);
    }
    const outside = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const inY = y >= box.y0 && y < box.y1;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (full[i] && !(inY && x >= box.x0 && x < box.x1)) outside[i] = 1;
      }
    }
    const { labels, sizes } = R.components(outside, w, h);
    const maxLen = Math.round(Math.max(box.x1 - box.x0, box.y1 - box.y0) * 0.5);
    let out = kept, erased = null, erasedCount = 0;
    const n = sizes.length;
    const touches = new Uint8Array(n);
    const bx0 = new Int32Array(n).fill(w), by0 = new Int32Array(n).fill(h);
    const bx1 = new Int32Array(n).fill(-1), by1 = new Int32Array(n).fill(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const L = labels[i];
        if (!L) continue;
        if (x < bx0[L]) bx0[L] = x; if (x > bx1[L]) bx1[L] = x;
        if (y < by0[L]) by0[L] = y; if (y > by1[L]) by1[L] = y;
        if ((x > 0 && kept[i - 1]) || (x < w - 1 && kept[i + 1]) ||
            (y > 0 && kept[i - w]) || (y < h - 1 && kept[i + w])) touches[L] = 1;
      }
    }
    const boxDim = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const sliced = new Uint8Array(w * h);
    let anySliced = false;
    for (let L = 1; L < n; L++) {
      if (!touches[L]) continue;
      // a neighbor reaches well beyond the box; anything short is the
      // letter's own overhang past a box that fit it imperfectly
      const reach = Math.max(bx1[L] - bx0[L] + 1, by1[L] - by0[L] + 1);
      const neighbor = reach >= boxDim * 0.3 && sizes[L] >= 3 * sw * sw;
      if (!neighbor) {
        const next = new Uint8Array(out);
        for (let y = by0[L]; y <= by1[L]; y++) {
          for (let x = bx0[L]; x <= bx1[L]; x++) {
            const i = y * w + x;
            if (labels[i] === L) next[i] = 1;
          }
        }
        out = next;
        continue;
      }
      // kept pixels touching this outside component: where it crosses in
      const cross = new Uint8Array(w * h);
      let any = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!out[i]) continue;
          if ((x > 0 && labels[i - 1] === L) || (x < w - 1 && labels[i + 1] === L) ||
              (y > 0 && labels[i - w] === L) || (y < h - 1 && labels[i + w] === L)) { cross[i] = 1; any = true; }
        }
      }
      if (!any) continue;
      const cc = R.components(cross, w, h);
      for (let c = 1; c < cc.sizes.length; c++) {
        const seeds = [];
        for (let i = 0; i < cross.length; i++) if (cc.labels[i] === c) seeds.push(i);
        const spur = followSpur(out, w, h, seeds, sw, maxLen, isLetter, slack);
        const n = spur ? R.count(spur) : 0;
        if (!spur || erasedCount + n > keptCount * 0.3) {
          // no join found (or it would eat the letter): the box edge itself
          // is the cut — round that sliced face
          for (const s of seeds) sliced[s] = 1;
          anySliced = true;
          continue;
        }
        const next = new Uint8Array(out);
        erased = erased || new Uint8Array(w * h);
        for (let i = 0; i < spur.length; i++) if (spur[i]) { next[i] = 0; erased[i] = 1; }
        out = next;
        erasedCount += n;
      }
    }
    if (erased) {
      // heal: close the notch, only around what was erased, never adding
      // ink the boxed piece didn't have
      const r = Math.max(1, Math.ceil(sw / 2));
      const closed = R.close(out, w, h, r);
      const near = R.dilate(erased, w, h, r + 1);
      for (let i = 0; i < out.length; i++) if (closed[i] && near[i] && kept[i]) out[i] = 1;
      // and shave the shallow nub the spur leaves on the stroke
      const opened = R.open(out, w, h, Math.max(1, Math.round(sw * 0.3)));
      for (let i = 0; i < out.length; i++) if (near[i] && !opened[i]) out[i] = 0;
    }
    if (anySliced) out = ex.roundCutEnds(out, w, h, R.dilate(sliced, w, h, 2));
    return out;
  };

  /**
   * Seeded extraction from a click at canvas pixel (x, y).
   * Returns { seed, bg, click: {x,y}, tolerance, region: {x,y,w,h},
   *   candidates: [{crop, mask, w, h, paths, kind}] } or null when nothing
   *   paint-like is near the click. `click` is where the click snapped to;
   *   candidates[0] is the best guess (separated piece when a touching
   *   neighbor was detected, else the whole region).
   */
  ex.seeded = function (canvas, x, y, opts) {
    const o = Object.assign({ smoothing: 4, blur: 2, cuts: null }, opts || {});
    const w = canvas.width, h = canvas.height;
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const excl = ex.cutMask(w, h, o.cuts);
    const bg = ex.backgroundColor(data, w, h);
    if (bg) {
      const snap = snapToInk(data, w, h, x, y, Math.max(6, Math.round(Math.max(w, h) * 0.03)), bg);
      x = snap.x; y = snap.y;
    }
    // Reference color: the click sample first, then refined to the mean of
    // the core region it grows — a single k-means step. A 5×5 sample sits
    // wherever the pen happened to be densest; the stroke's mean is what
    // the rest of the stroke is actually near.
    let seed = seedColorAt(data, w, h, x, y, bg);
    let field = R.colorDistMap(data, w, h, [seed]);
    if (o.blur > 0) field = R.blur(field, w, h, o.blur);
    const core = R.floodFrom(w, h, x, y, (i) => field[i] <= 60 && !(excl && excl[i]));
    if (core.count >= 60 && core.count < w * h * 0.3) {
      let r = 0, g = 0, b = 0;
      for (let i = 0, p = 0; i < core.mask.length; i++, p += 4) {
        if (core.mask[i]) { r += data[p]; g += data[p + 1]; b += data[p + 2]; }
      }
      seed = { r: r / core.count, g: g / core.count, b: b / core.count };
      field = R.colorDistMap(data, w, h, [seed]);
      if (o.blur > 0) field = R.blur(field, w, h, o.blur);
    }
    // never grow past the midpoint between paint and background: beyond it
    // a pixel is more paper than paint whatever the boundary looks like
    const sep = bg ? R.colorDist(seed.r, seed.g, seed.b, bg.r, bg.g, bg.b) : Infinity;
    const grown = autoRegion(field, excl, w, h, x, y, { maxTol: Math.max(40, sep * 0.55) });
    if (!grown || grown.count < 40) return null;

    const crop = bboxOf(grown.mask, w, h, 12);
    if (!crop) return null;
    const sub = cropMask(grown.mask, w, crop);
    const lx = x - crop.x, ly = y - crop.y;
    let whole = ex.cleanMask(sub, crop.w, crop.h, o.smoothing, { noRound: o.noRound });
    // a cut slices the stroke flat; give the sliced ends a marker's round cap
    if (excl && !o.noRound) whole = ex.roundCutEnds(whole, crop.w, crop.h, cropMask(excl, w, crop));

    const candidates = [];
    const push = (mask, kind) => {
      const paths = ST.trace.vectorize(mask, crop.w, crop.h, {});
      if (paths.length) candidates.push({ crop, mask, w: crop.w, h: crop.h, paths, kind });
    };
    const separated = ex.separateTouching(whole, crop.w, crop.h, lx, ly);
    if (separated) push(separated, 'separated');
    push(whole, 'whole');
    if (!candidates.length) return null;
    return { seed, bg, click: { x, y }, tolerance: grown.t, region: crop, candidates };
  };
})(typeof window !== 'undefined' ? window : globalThis);
