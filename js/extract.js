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

  // How far the wall's own color wanders (grain, texture, light): the 90th
  // percentile of the frame's border ring's distance to the background
  // estimate, with headroom. Pixels within it read as "wall".
  ex.wallTolerance = function (data, w, h, bg) {
    const m = Math.max(3, Math.round(Math.min(w, h) * 0.08));
    const step = Math.max(1, Math.round(Math.sqrt((w * h) / 60000)));
    const vals = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (!(x < m || y < m || x >= w - m || y >= h - m)) continue;
        const p = (y * w + x) * 4;
        vals.push(R.colorDist(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b));
      }
    }
    if (!vals.length) return 40;
    vals.sort((a, b) => a - b);
    return Math.max(25, vals[Math.floor(vals.length * 0.9)] * 1.3);
  };

  // Wall mask: pixels within the wall's tolerance of the background color.
  ex.wallMask = function (data, w, h, bg, tol) {
    const d = R.colorDistMap(data, w, h, [bg]);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i] <= tol ? 1 : 0;
    return out;
  };

  // Surface defects: patches that are neither paint- nor wall-colored — a
  // pock's shadow in porous concrete, a crack, a chip, dirt. A compact
  // patch whose boundary is mostly paint is paint: the spray went over it.
  // A patch bordered by the wall stays the wall's. A real gap or counter
  // is wall-colored, so it is never a candidate here — and the paint's
  // soft edge is a long thin band touching both, so it is not either.
  ex.absorbDefects = function (paint, wall, w, h) {
    const other = new Uint8Array(w * h);
    let any = false;
    for (let i = 0; i < other.length; i++) if (!paint[i] && !wall[i]) { other[i] = 1; any = true; }
    if (!any) return paint;
    const { labels, sizes } = R.components(other, w, h);
    const n = sizes.length;
    const cp = new Int32Array(n), cw = new Int32Array(n), per = new Int32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, L = labels[i];
        if (!L) continue;
        let edge = false;
        if (x > 0) { if (paint[i - 1]) { cp[L]++; edge = true; } else if (wall[i - 1]) { cw[L]++; edge = true; } } else edge = true;
        if (x < w - 1) { if (paint[i + 1]) { cp[L]++; edge = true; } else if (wall[i + 1]) { cw[L]++; edge = true; } } else edge = true;
        if (y > 0) { if (paint[i - w]) { cp[L]++; edge = true; } else if (wall[i - w]) { cw[L]++; edge = true; } } else edge = true;
        if (y < h - 1) { if (paint[i + w]) { cp[L]++; edge = true; } else if (wall[i + w]) { cw[L]++; edge = true; } } else edge = true;
        if (edge) per[L]++;
      }
    }
    const paintCount = R.count(paint);
    const fill = new Uint8Array(n);
    for (let L = 1; L < n; L++) {
      const contacts = cp[L] + cw[L];
      if (!contacts || sizes[L] > paintCount * 0.15) continue;
      const share = cp[L] / contacts;
      const compact = per[L] ? (4 * Math.PI * sizes[L]) / (per[L] * per[L]) : 0; // 1 = a disk
      if (share >= 0.85 || (share >= 0.6 && compact >= 0.3)) fill[L] = 1;
    }
    const out = new Uint8Array(paint);
    for (let i = 0; i < out.length; i++) if (labels[i] && fill[labels[i]]) out[i] = 1;
    return out;
  };

  // Rasterize cut strokes (canvas coords) into an exclusion mask. With
  // `keep` (the point on the letter the cut is made for), each cut only
  // takes from the far side of its line: the letter keeps every pixel up to
  // the line — a cut drawn along or into the letter's own stroke leaves no
  // notch — while the neighbor loses a whole band, so nothing re-bridges it.
  ex.cutMask = function (w, h, cuts, keep) {
    if (!cuts || !cuts.length) return null;
    const excl = new Uint8Array(w * h);
    for (const c of cuts) {
      const half = Math.max(2, c.width / 2);
      const x0 = Math.max(0, Math.floor(Math.min(c.x0, c.x1) - half));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(c.x0, c.x1) + half));
      const y0 = Math.max(0, Math.floor(Math.min(c.y0, c.y1) - half));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(c.y0, c.y1) + half));
      const a = { x: c.x0, y: c.y0 }, b = { x: c.x1, y: c.y1 };
      const dx = c.x1 - c.x0, dy = c.y1 - c.y0, len = Math.hypot(dx, dy);
      // signed distance to the cut's line, positive on the letter's side
      let side = null;
      if (keep && len > 1) {
        const s = Math.sign(dx * (keep.y - c.y0) - dy * (keep.x - c.x0));
        if (s) side = (x, y) => (s * (dx * (y - c.y0) - dy * (x - c.x0))) / len;
      }
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (side && side(x, y) > 1.5) continue;
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

  // A crop that may reach past the frame (a letter completed beyond the
  // photo's edge): pixels outside the w×h mask read as `outside`.
  function cropAny(mask, w, h, crop, outside) {
    const out = new Uint8Array(crop.w * crop.h);
    for (let y = 0; y < crop.h; y++) {
      const sy = y + crop.y;
      for (let x = 0; x < crop.w; x++) {
        const sx = x + crop.x;
        out[y * crop.w + x] = sx < 0 || sy < 0 || sx >= w || sy >= h ? outside : mask[sy * w + sx];
      }
    }
    return out;
  }
  ex.cropAny = cropAny;

  // Scale-aware clean-up shared with the studio: shave fingers, heal gaps,
  // never thinner than a third of the stroke — then round the stroke ends:
  // a marker can't draw anything sharper than its tip, so needle points
  // thinner than the thin side of the tip become round caps.
  ex.cleanMask = function (mask, w, h, smoothing, opts) {
    const sm = smoothing == null ? 4 : smoothing;
    let m = R.despeckle(mask, w, h, 0.04, 24);
    const sw = R.strokeWidth(m, w, h);
    if (sm > 0) {
      const scale = Math.max(w, h) / 700;
      // closing heals gaps, cracks and notches: the radius follows the knob
      // and the photo's size, up to nearly half a stroke
      const rc = Math.max(0, Math.min(Math.round(sm * 1.6 * scale), Math.floor(sw * 0.45)));
      // opening shaves fibers, burrs and drips, but never thins the
      // THINNEST strokes (a chisel marker's thin side is far thinner than
      // the average stroke): fibers are thin, so a modest disk still
      // removes them — and nothing it would take may hold the shape
      // together (a thin neck where an arm meets its stem, a worn stretch
      // of a curl, is the letter's; a drip hangs free)
      const rt = R.thinRadius(m, w, h);
      const ro = Math.max(0, Math.min(rc, rt > 0 ? Math.floor(rt * 0.7) : rc));
      if (rc > 0) {
        // the closing's bridges heal; its fillets at inside corners don't stay
        const closed = R.close(m, w, h, rc);
        m = rc > 2 ? ex.keepBridges(m, closed, w, h) : closed;
      }
      if (ro > 0) m = R.pruneThin(m, w, h, ro, null, { bridgeMin: Math.round(rt * 0.35) });
      if (!(opts && opts.noRound)) {
        m = ex.roundEnds(m, w, h, null);
        m = ex.capEnds(m, w, h);
      }
    }
    // fill speckle gaps — holes smaller than the pen could leave on purpose
    // (well under a stroke width across, more with the knob up), and slits
    // of any length that are never more than a third of a stroke thick (a
    // metallic glint or bare wall showing along a stroke); a counter, even a
    // small one in a fat letter, is neither
    const cap = sw > 0 ? Math.pow(0.6 * sw * (0.5 + sm / 8), 2) : undefined;
    m = R.fillHoles(m, w, h, 0.06, cap, sw > 0 && sm > 0 ? sw * 0.35 : 0);
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
    if (r < 2) return mask;
    // what gets pruned is judged without the pocks in the strokes: the rim
    // between a glint (or a fleck of bare wall) and the stroke's edge is no
    // thin stretch of it (the pocks themselves are left for the hole
    // filling to decide)
    const sw = R.strokeWidth(mask, w, h);
    const solid = sw > 0 ? R.fillHoles(mask, w, h, 0.05, Math.pow(0.8 * sw, 2)) : mask;
    const pruned = R.pruneThin(solid, w, h, r, region);
    if (solid === mask) return pruned;
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < out.length; i++) out[i] = pruned[i] && mask[i] ? 1 : 0;
    return out;
  };

  // Keep only the BRIDGES of a closing. `closed` is `paint` closed by some
  // radius: the new pixels heal streak gaps, cracks and notches — and also
  // web over every acute inside corner where two strokes meet, with a
  // fillet the pen never drew. A bridge lies inside a stroke: within that
  // stroke's half-width of its skeleton. A corner web lies outside every
  // stroke. So the skeleton of the closed shape is read stroke by stroke
  // (each with its median half-width; skeleton pieces that run through
  // the new pixels themselves are a web's and don't count), every new
  // pixel is handed to its nearest skeleton pixel, and only those within
  // reach of that stroke's half-width survive.
  ex.keepBridges = function (paint, closed, w, h) {
    const sw = R.strokeWidth(closed, w, h);
    if (sw < 3) return closed;
    let any = false;
    for (let i = 0; i < closed.length; i++) if (closed[i] && !paint[i]) { any = true; break; }
    if (!any) return closed;
    // the paint's own distance transform: at a skeleton pixel on paint, the
    // exact radius of the maximal disc there — the union of those discs IS
    // the paint, with no bulge into a concave corner
    const dtP = R.distanceTransform(paint, w, h);
    const graph = strokeGraph(closed, w, h, sw);
    const rad = new Float32Array(w * h);
    const src = new Uint8Array(w * h); // pixels that may own ink
    const own = (q, r) => {
      if (q < 0 || !closed[q]) return;
      if (!src[q] || r > rad[q]) rad[q] = r;
      src[q] = 1;
    };
    const X = (p) => p % w, Y = (p) => (p / w) | 0;
    const dtC = R.distanceTransform(closed, w, h);
    // how much of a box around a pixel is paint: a worn, speckled stretch
    // of a stroke is mostly paint; wall texture with a few flecks is not
    const S = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x < w; x++) { run += paint[y * w + x] ? 1 : 0; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + run; }
    }
    const density = (p, r) => {
      const x = p % w, y = (p / w) | 0;
      const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
      const a = (x1 - x0) * (y1 - y0);
      return a ? (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / a : 0;
    };
    for (const s of graph.segments) {
      const px = s.pixels, n = px.length;
      // the stroke's usual half-width: the median of the closed shape's
      // distance transform along it (a slit or streak inside the stroke
      // doesn't narrow the closed shape; a web beside it only widens it
      // locally)
      const vals = [];
      for (const p of px) vals.push(dtC[p]);
      vals.sort((a, b) => a - b);
      const med = vals.length ? vals[vals.length >> 1] : 0;
      const guard = Math.ceil(2.5 * Math.max(med, 2));
      const joinAt = s.ends.map((e) => e >= 0 && !graph.endpoint[e]);
      // a bend in one stroke webs over only its own inside corner, right at
      // the vertex; where strokes meet, the webs spread further along them
      const guardAt = s.ends.map((e) => (e >= 0 && graph.junction[e] ? guard : Math.ceil(1.0 * Math.max(med, 2))));
      // a short piece from one junction to another is the web's own link
      // between two strokes, not a stroke with a gap in it
      const link = joinAt[0] && joinAt[1] && n < 2.5 * sw;
      const strict = (k) => link || (joinAt[0] && k < guardAt[0]) || (joinAt[1] && n - 1 - k < guardAt[1]);
      // Where the closed shape has the stroke's usual width, its skeleton IS
      // the stroke's centerline and its disc there is the stroke's own
      // (a slit, a streak gap, a notch are healed at the stroke's width).
      // Where it is wider than usual, a web is spun beside the stroke: the
      // web widens the closed shape and its medial axis bows out into it.
      // Such a stretch is bridged along the curve that continues the
      // trusted centerline from either side, at the stroke's usual width —
      // the web, which lies outside that tube, is dropped. Near a junction
      // there is nothing to continue from, and only the paint counts.
      const reliable = (k) => dtC[px[k]] <= 1.2 * med;
      let i = 0;
      while (i < n) {
        if (reliable(i)) {
          // near a join only the paint's own disc — unless the paint there
          // is a speckled stroke: then the stroke's width (a disc no wider
          // than the stroke, on its centerline, never reaches a web beside it)
          let r = strict(i) ? dtP[px[i]] : dtC[px[i]];
          if (strict(i) && density(px[i], Math.max(2, Math.round(med))) >= 0.6) r = Math.max(r, Math.min(dtC[px[i]], med));
          own(px[i], Math.max(1, r));
          i++;
          continue;
        }
        let j = i;
        while (j < n && !reliable(j)) j++;
        // the run's own paint pixels own their exact paint disc, no more
        for (let k = i; k < j; k++) if (paint[px[k]]) own(px[k], Math.max(1, dtP[px[k]]));
        if (i > 0 && j < n && !link && !strict(i - 1) && !strict(j)) {
          const a = px[i - 1], b = px[j];
          const ra = Math.min(dtC[a], med), rb = Math.min(dtC[b], med);
          // tangents from the trusted skeleton on either side
          const m = Math.max(3, Math.min(Math.round(med), 12));
          const a0 = px[Math.max(0, i - 1 - m)], b1 = px[Math.min(n - 1, j + m)];
          const ax = X(a), ay = Y(a), bx = X(b), by = Y(b);
          const L = Math.hypot(bx - ax, by - ay);
          let tax = ax - X(a0), tay = ay - Y(a0), tbx = X(b1) - bx, tby = Y(b1) - by;
          const la = Math.hypot(tax, tay) || 1, lb = Math.hypot(tbx, tby) || 1;
          tax = (tax / la) * L; tay = (tay / la) * L; tbx = (tbx / lb) * L; tby = (tby / lb) * L;
          const steps = Math.max(2, Math.ceil(L * 2));
          for (let q = 0; q <= steps; q++) {
            const t = q / steps, t2 = t * t, t3 = t2 * t;
            const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
            const cx = Math.round(h00 * ax + h10 * tax + h01 * bx + h11 * tbx);
            const cy = Math.round(h00 * ay + h10 * tay + h01 * by + h11 * tby);
            if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
            own(cy * w + cx, Math.max(1, ra + (rb - ra) * t));
          }
        }
        i = j;
      }
    }
    for (let i = 0; i < graph.skel.length; i++) {
      if (graph.skel[i] && paint[i] && !src[i]) { src[i] = 1; rad[i] = Math.max(1, dtP[i]); }
    }
    const owner = new Int32Array(w * h).fill(-1);
    const queue = new Int32Array(w * h);
    let qh = 0, qt = 0;
    for (let i = 0; i < src.length; i++) if (src[i] && closed[i]) { owner[i] = i; queue[qt++] = i; }
    if (!qt) return closed;
    while (qh < qt) {
      const i = queue[qh++], o = owner[i], x = i % w;
      if (x > 0 && closed[i - 1] && owner[i - 1] < 0) { owner[i - 1] = o; queue[qt++] = i - 1; }
      if (x < w - 1 && closed[i + 1] && owner[i + 1] < 0) { owner[i + 1] = o; queue[qt++] = i + 1; }
      if (i >= w && closed[i - w] && owner[i - w] < 0) { owner[i - w] = o; queue[qt++] = i - w; }
      if (i + w < closed.length && closed[i + w] && owner[i + w] < 0) { owner[i + w] = o; queue[qt++] = i + w; }
    }
    const out = new Uint8Array(paint);
    for (let i = 0; i < closed.length; i++) {
      if (!closed[i] || paint[i]) continue;
      const o = owner[i];
      if (o < 0) continue;
      const dx = (i % w) - (o % w), dy = ((i / w) | 0) - ((o / w) | 0);
      if (Math.sqrt(dx * dx + dy * dy) <= rad[o] + 1.5) out[i] = 1;
    }
    return out;
  };

  // The paint's own tone: among the non-wall pixels of `include` that lie
  // along the wall→sample color axis (the shades and glints of ONE paint,
  // not a differently colored neighbor), the most common color. A click on
  // silver's dark shading, or on its bright glint, then still reads the
  // silver body as the paint.
  function dominantAlongAxis(data, w, h, include, sample, bg) {
    const ax = sample.r - bg.r, ay = sample.g - bg.g, az = sample.b - bg.b;
    const len2 = ax * ax + ay * ay + az * az;
    if (len2 < 400) return null;
    const len = Math.sqrt(len2), maxRes = Math.max(30, len * 0.25);
    const keep = new Uint8Array(w * h);
    let n = 0;
    for (let i = 0, p = 0; i < keep.length; i++, p += 4) {
      if (!include[i]) continue;
      const vx = data[p] - bg.r, vy = data[p + 1] - bg.g, vz = data[p + 2] - bg.b;
      const u = (vx * ax + vy * ay + vz * az) / len2;
      // a bleed halo or overspray sits a short way off the wall; a paint's
      // body tone (silver's, next to its darkest shading) well along
      if (u < 0.3 || u > 1.6) continue;
      const rx = vx - u * ax, ry = vy - u * ay, rz = vz - u * az;
      if (Math.sqrt(rx * rx + ry * ry + rz * rz) > maxRes) continue;
      keep[i] = 1; n++;
    }
    if (n < 60) return null;
    return R.dominantColor(data, w, h, (x, y) => keep[y * w + x] === 1);
  }
  ex.dominantAlongAxis = dominantAlongAxis;

  // Marker caps. A stroke that fades out — spray thinning, a marker lifting
  // — tapers to a point in the mask, and no pen leaves a point. Walk the
  // skeleton in from each free end to where the stroke has its width back
  // (85% of that stroke's body half-width, within three half-widths), drop
  // the taper beyond, and end the stroke there with a disc of the local
  // half-width: the round cap a marker tip leaves. Ends already that round
  // are left alone; so is anything WIDER than the stroke near its end (an
  // arrowhead is drawn that way, not faded).
  ex.capEnds = function (mask, w, h) {
    const sw = R.strokeWidth(mask, w, h);
    if (sw < 4) return mask;
    const dt = R.distanceTransform(mask, w, h);
    const graph = strokeGraph(mask, w, h, sw);
    const skel = graph.skel;
    const cls = new Uint8Array(w * h); // skeleton px: 1 = body, 2 = taper
    for (let i = 0; i < skel.length; i++) if (skel[i]) cls[i] = 1;
    const caps = [];
    for (const s of graph.segments) {
      for (let k = 0; k < 2; k++) {
        const e = s.ends[k];
        if (e < 0 || !graph.endpoint[e]) continue;
        const path = [e].concat(k === 0 ? s.pixels : s.pixels.slice().reverse());
        const vals = path.map((i) => dt[i]).sort((a, b) => a - b);
        const rBody = vals[Math.floor(vals.length * 0.75)];
        if (!(rBody >= 1.5)) continue;
        const otherFree = s.ends[1 - k] >= 0 && graph.endpoint[s.ends[1 - k]];
        const reach = Math.min(otherFree ? Math.floor(path.length / 2) : path.length - 1, Math.ceil(4 * rBody));
        let ci = -1, dmax = 0;
        for (let i = 0; i <= reach; i++) {
          dmax = Math.max(dmax, dt[path[i]]);
          if (ci < 0 && dt[path[i]] >= 0.7 * rBody) ci = i;
        }
        if (dmax > 1.15 * rBody) continue;
        if (ci < 0) ci = reach;
        const c = path[ci], rc = dt[c];
        if (rc < 1.5 || ci <= 0.5 * rc) continue;
        for (let i = 0; i < ci; i++) cls[path[i]] = 2;
        caps.push({ c, r: rc });
      }
    }
    if (!caps.length) return mask;
    // every ink pixel belongs to its nearest skeleton pixel: the taper's goes
    const label = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let qh = 0, qt = 0;
    for (let i = 0; i < skel.length; i++) if (skel[i] && mask[i]) { label[i] = cls[i]; queue[qt++] = i; }
    while (qh < qt) {
      const i = queue[qh++], L = label[i], x = i % w;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = L; queue[qt++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = L; queue[qt++] = i + 1; }
      if (i >= w && mask[i - w] && !label[i - w]) { label[i - w] = L; queue[qt++] = i - w; }
      if (i + w < mask.length && mask[i + w] && !label[i + w]) { label[i + w] = L; queue[qt++] = i + w; }
    }
    const out = new Uint8Array(mask);
    for (let i = 0; i < out.length; i++) if (label[i] === 2) out[i] = 0;
    for (const cap of caps) {
      const cx = cap.c % w, cy = (cap.c / w) | 0, r = cap.r, r2 = (r + 0.5) * (r + 0.5);
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) out[y * w + x] = 1;
        }
      }
    }
    return out;
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
    // the cap is nearly the stroke's own half-width, so an oblique slice's
    // wedge is pruned back to a proper round end instead of a point
    const near = R.dilate(band, w, h, Math.ceil(rmax * 2) + 2);
    const r = Math.round(rmax * 0.85);
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

  // ---------- stroke graph ----------
  // A shape as strokes: thin it to a skeleton, prune the skeleton's spurs,
  // cut it into pieces at junctions and at sharp corners. Each piece is one
  // stroke (or part of one); a neighbor's stroke is a piece of its own even
  // where it merely continues a letter's stroke around a corner.
  function strokeGraph(mask, w, h, sw) {
    const skel = R.thin(mask, w, h);
    const N8 = [-w, -1, 1, w, -w - 1, -w + 1, w - 1, w + 1]; // 4-neighbors first
    const ring = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1];
    // connectivity number: 0→1 transitions around the 8-ring. Unlike a raw
    // neighbor count it reads a staircase as a plain path, not a junction.
    const deg = (i) => {
      let t = 0;
      for (let k = 0; k < 8; k++) if (!skel[i + ring[k]] && skel[i + ring[(k + 1) & 7]]) t++;
      return t;
    };
    // prune spurs shorter than ~0.7 strokes: the little Y-branches thinning
    // grows at stroke ends and at bumps (a real short stroke, like the
    // start of a 2's loop just past a join, is longer and must survive,
    // or the join loses its junction)
    const L = Math.round(sw * 0.7) + 2;
    for (let pass = 0; pass < 2; pass++) {
      const ends = [];
      for (let i = 0; i < skel.length; i++) if (skel[i] && deg(i) === 1) ends.push(i);
      for (const e of ends) {
        if (!skel[e]) continue;
        const path = [e];
        let prev = -1, cur = e, junction = false;
        for (let step = 0; step < L; step++) {
          let next = -1;
          for (const d of N8) { const n = cur + d; if (skel[n] && n !== prev && !path.includes(n)) { next = n; break; } }
          if (next < 0) break;
          if (deg(next) >= 3) { junction = true; break; }
          path.push(next); prev = cur; cur = next;
        }
        if (junction) for (const p of path) skel[p] = 0;
      }
    }
    const node = new Uint8Array(w * h), junction = new Uint8Array(w * h), endpoint = new Uint8Array(w * h);
    for (let i = 0; i < skel.length; i++) {
      if (!skel[i]) continue;
      const d = deg(i);
      if (d !== 2) node[i] = 1;
      if (d >= 3) junction[i] = 1;
      if (d <= 1) endpoint[i] = 1;
    }
    const visited = new Uint8Array(w * h);
    // walk from a node along plain path pixels to the next node; a segment
    // remembers the nodes at its two ends (-1: none — a free end or ring)
    const trace = (start, from) => {
      const pixels = [];
      let prev = from, cur = start, atNode = -1;
      for (;;) {
        visited[cur] = 1; pixels.push(cur);
        let next = -1;
        atNode = -1;
        for (const d of N8) {
          const n = cur + d;
          if (!skel[n] || n === prev) continue;
          if (node[n]) { if (atNode < 0) atNode = n; continue; }
          if (!visited[n]) { next = n; break; }
        }
        if (next < 0) return { pixels, ends: [from, atNode] };
        prev = cur; cur = next;
      }
    };
    let segments = [];
    for (let i = 0; i < skel.length; i++) {
      if (!node[i]) continue;
      for (const d of N8) { const n = i + d; if (skel[n] && !node[n] && !visited[n]) segments.push(trace(n, i)); }
    }
    for (let i = 0; i < skel.length; i++) if (skel[i] && !node[i] && !visited[i]) segments.push(trace(i, -1)); // rings
    // split at corners: the turn between the chords k pixels back and k
    // pixels ahead. Where two strokes meet, the union's medial axis smears
    // the corner over about two stroke widths, so the chords are that long;
    // local maxima over 35° become cuts (a curl also splits — harmlessly,
    // both halves stay the letter's)
    const k = Math.max(6, Math.round(sw * 2));
    const thr = (35 * Math.PI) / 180;
    const split = [];
    for (const s of segments) {
      const p = s.pixels, n = p.length;
      if (n < 2 * k + 3) { split.push(s); continue; }
      const turn = new Float32Array(n);
      for (let i = k; i < n - k; i++) {
        const ax = (p[i] % w) - (p[i - k] % w), ay = ((p[i] / w) | 0) - ((p[i - k] / w) | 0);
        const bx = (p[i + k] % w) - (p[i] % w), by = ((p[i + k] / w) | 0) - ((p[i] / w) | 0);
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        turn[i] = la && lb ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) : 0;
      }
      const cuts = [];
      for (let i = k; i < n - k; i++) {
        if (turn[i] < thr) continue;
        let isMax = true;
        for (let j = Math.max(k, i - k); j <= Math.min(n - k - 1, i + k); j++) {
          if (turn[j] > turn[i] || (turn[j] === turn[i] && j < i)) { isMax = false; break; }
        }
        if (isMax) cuts.push(i);
      }
      if (!cuts.length) { split.push(s); continue; }
      // the apex itself belongs to neither stroke: it stays with the letter,
      // and is the node at which the pieces on either side end
      const m = Math.max(2, Math.round(k / 4));
      let a = 0, from = s.ends[0];
      for (const c of cuts) {
        split.push({ pixels: p.slice(a, Math.max(a, c - m)), ends: [from, p[c]] });
        for (let i = Math.max(a, c - m); i < Math.min(n, c + m); i++) node[p[i]] = 1;
        a = Math.min(n, c + m);
        from = p[c];
      }
      split.push({ pixels: p.slice(a), ends: [from, s.ends[1]] });
    }
    segments = split.filter((s) => s.pixels.length);
    return { skel, node, junction, endpoint, segments };
  }
  ex.strokeGraph = strokeGraph;

  // A shape that is only read (a candidate's mask, trimmed several ways
  // in a row) is skeletonized once.
  const graphCache = new WeakMap();
  function cachedGraph(mask, w, h) {
    let c = graphCache.get(mask);
    if (!c || c.w !== w || c.h !== h) {
      const sw = R.strokeWidth(mask, w, h);
      c = { w, h, sw, graph: sw > 1 ? strokeGraph(mask, w, h, sw) : null };
      graphCache.set(mask, c);
    }
    return c;
  }

  /**
   * "Cut off the excess": keep the strokes of a fused shape that belong to
   * the letter inside `box` ({x0, y0, x1, y1}, exclusive, the template's
   * placement with its margin) and drop, at their joins, the strokes that
   * leave the box by more than a couple of stroke widths — a neighbor's.
   * The letter's own overhang past an imperfect box stays. The result is
   * the piece connected to the click (cx, cy), with the cut faces healed
   * and capped. Returns { mask, removed, strokes } or null.
   */
  ex.isolateStrokes = function (mask, w, h, box, cx, cy) {
    const { sw, graph } = cachedGraph(mask, w, h);
    if (!(sw > 1) || !graph || !graph.segments.length) return null;
    // A neighbor's stroke reaches far beyond the box, or crosses the box
    // edge and carries on into more strokes out there — either joining the
    // letter side-on at a T inside, or living mostly outside. The letter's
    // own leg, bar end, tail or flourish past an imperfect box (a template
    // never knows how long a handstyle's legs are) reaches a modest way and
    // simply ends out there, so a free end outside is never a neighbor's.
    const boxDim = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const farLimit = Math.max(sw, boxDim * 0.25);
    const beyond = (i) => {
      const x = i % w, y = (i / w) | 0;
      return Math.max(0, box.x0 - x, x - (box.x1 - 1), box.y0 - y, y - (box.y1 - 1));
    };
    // reach is measured on the skeleton, which stops half a stroke short of
    // the stroke's actual end
    const stats = graph.segments.map((s) => {
      let far = 0, outside = 0;
      for (const p of s.pixels) { const d = beyond(p); if (d > far) far = d; if (d > 0) outside++; }
      return { far: far > 0 ? far + sw / 2 : 0, frac: outside / s.pixels.length };
    });
    const atNode = new Map(); // node pixel → segment indices meeting there
    graph.segments.forEach((s, k) => {
      for (const e of s.ends) if (e >= 0) { if (!atNode.has(e)) atNode.set(e, []); atNode.get(e).push(k); }
    });
    const foreign = new Uint8Array(graph.segments.length + 1);
    const anchoredInside = (s) => s.ends.some((e) => e >= 0 && beyond(e) === 0);
    // pass 1: a stroke that reaches far, or hangs entirely outside the box
    // (neither end inside), is a neighbor's
    graph.segments.forEach((s, k) => {
      const { far } = stats[k];
      if (far > farLimit || (far > sw && !anchoredInside(s))) foreign[k + 1] = 1;
    });
    // pass 2: a stroke anchored inside — at a T with the letter, or with
    // most of its length outside — that continues past an outside end into
    // a junction or into a neighbor's stroke is a neighbor's too. One that
    // simply ends out there (a leg, a bar end, a tail) is the letter's.
    const info = [];
    graph.segments.forEach((s, k) => {
      const { far, frac } = stats[k];
      const teesInside = s.ends.some((e) => e >= 0 && graph.junction[e] && beyond(e) === 0);
      const goesOn = far > sw && s.ends.some((e) => e >= 0 && beyond(e) > 0 && !graph.endpoint[e] &&
        (graph.junction[e] || (atNode.get(e) || []).some((j) => j !== k && foreign[j + 1])));
      if (!foreign[k + 1] && goesOn && (teesInside || (far > 2 * sw && frac > 0.6))) foreign[k + 1] = 1;
      info.push({ len: s.pixels.length, far: Math.round(far), frac: +frac.toFixed(2), teesInside, goesOn, foreign: !!foreign[k + 1],
        ends: s.ends.map((e) => (e < 0 ? '-' : (graph.junction[e] ? 'T' : graph.endpoint[e] ? 'end' : 'corner') + (beyond(e) > 0 ? '(out)' : '(in)'))) });
    });
    let nForeign = 0;
    for (let k = 1; k < foreign.length; k++) if (foreign[k]) nForeign++;
    // every ink pixel belongs to its nearest skeleton piece (nodes and any
    // stray skeleton pixels count as the letter's)
    const id = new Int32Array(w * h).fill(-1);
    const queue = new Int32Array(w * h);
    let qh = 0, qt = 0;
    for (let i = 0; i < graph.skel.length; i++) if (graph.skel[i]) { id[i] = 0; queue[qt++] = i; }
    graph.segments.forEach((s, k) => { for (const p of s.pixels) id[p] = k + 1; });
    while (qh < qt) {
      const j = queue[qh++];
      const x = j % w, y = (j / w) | 0;
      if (x > 0 && mask[j - 1] && id[j - 1] < 0) { id[j - 1] = id[j]; queue[qt++] = j - 1; }
      if (x < w - 1 && mask[j + 1] && id[j + 1] < 0) { id[j + 1] = id[j]; queue[qt++] = j + 1; }
      if (y > 0 && mask[j - w] && id[j - w] < 0) { id[j - w] = id[j]; queue[qt++] = j - w; }
      if (y < h - 1 && mask[j + w] && id[j + w] < 0) { id[j + w] = id[j]; queue[qt++] = j + w; }
    }
    // the click is on the letter: whatever stroke it sits on is never a
    // neighbor's (a neighbor continuing the letter's stroke dead straight
    // can't be told apart — better a stub than a lost stroke)
    let sx = Math.round(cx), sy = Math.round(cy);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h || !mask[sy * w + sx]) {
      let bd = Infinity, bi = -1;
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const d = ((i % w) - cx) ** 2 + (((i / w) | 0) - cy) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi < 0) return null;
      sx = bi % w; sy = (bi / w) | 0;
    }
    const clickId = id[sy * w + sx];
    if (clickId > 0 && foreign[clickId]) { foreign[clickId] = 0; nForeign--; }
    const out = new Uint8Array(w * h), removed = new Uint8Array(w * h);
    let nRemoved = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      if (id[i] > 0 && foreign[id[i]]) { removed[i] = 1; nRemoved++; } else out[i] = 1;
    }
    let result = R.floodFrom(w, h, sx, sy, (i) => out[i] === 1).mask;
    if (nRemoved) result = healCut(result, mask, removed, w, h, sw);
    return { mask: result, removed: nRemoved, strokes: graph.segments.length, foreign: nForeign, farLimit, info };
  };

  // Heal where strokes were taken off a shape: a removed stroke's skeleton
  // ran into the letter's stroke, taking a notch of the letter with it —
  // closing refills the notch (a concavity) without rebuilding the removed
  // stroke (convex); then shave the nub and cap the faces.
  function healCut(result, mask, removed, w, h, sw) {
    // the work is all around what came off: done in a window round it
    const bb = R.maskBounds(removed, w, h);
    if (!bb) return result;
    const pad = 4 * Math.max(1, Math.ceil(sw / 2)) + 6;
    const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
    const x1 = Math.min(w, bb.x1 + 1 + pad), y1 = Math.min(h, bb.y1 + 1 + pad);
    if ((x1 - x0) * (y1 - y0) < 0.8 * w * h) {
      const cw = x1 - x0, ch = y1 - y0;
      const cut = (m) => { const o = new Uint8Array(cw * ch); for (let y = 0; y < ch; y++) o.set(m.subarray((y + y0) * w + x0, (y + y0) * w + x1), y * cw); return o; };
      const healed = healCutIn(cut(result), cut(mask), cut(removed), cw, ch, sw);
      const out = new Uint8Array(result);
      for (let y = 0; y < ch; y++) out.set(healed.subarray(y * cw, (y + 1) * cw), (y + y0) * w + x0);
      return out;
    }
    return healCutIn(result, mask, removed, w, h, sw);
  }
  function healCutIn(result, mask, removed, w, h, sw) {
    const r = Math.max(1, Math.ceil(sw / 2));
    const near = R.dilate(removed, w, h, r + 1);
    const closed = R.close(result, w, h, r);
    for (let i = 0; i < result.length; i++) if (closed[i] && near[i] && mask[i]) result[i] = 1;
    const opened = R.open(result, w, h, Math.max(1, Math.round(sw * 0.3)));
    for (let i = 0; i < result.length; i++) if (near[i] && !opened[i]) result[i] = 0;
    const face = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!result[i]) continue;
        if ((x > 0 && removed[i - 1]) || (x < w - 1 && removed[i + 1]) ||
            (y > 0 && removed[i - w]) || (y < h - 1 && removed[i + w])) face[i] = 1;
      }
    }
    return ex.roundCutEnds(result, w, h, R.dilate(face, w, h, 2));
  }

  // ---------- strokes as chains ----------
  // A fused shape as whole strokes: the skeleton's pieces are rejoined
  // across the letter's own corners, and across junctions by good
  // continuation — at a crossing the two arms that run straight on are one
  // stroke (an O's ring stays one ring where a T's bar crosses it; the bar
  // stays one bar). Every ink pixel belongs to a stroke, or to a junction.
  // Returns { n, owner (Int32: chain id ≥ 1, −(cluster+1) at junctions),
  //   armsOf (cluster → chain ids), adj (chain → Set of chains), sw } or null.
  // opts.continuation === false: no joining across junctions — every stroke
  // stops where it meets another (finer pieces, for grouping into letters).
  const chainCache = new WeakMap(); // a shape that is only read is split once
  ex.strokeChains = function (mask, w, h, opts) {
    const continuation = !(opts && opts.continuation === false);
    let byOpt = chainCache.get(mask);
    const key = (continuation ? 'c' : 'n') + w + 'x' + h;
    if (byOpt && byOpt.has(key)) return byOpt.get(key);
    const res = strokeChainsOf(mask, w, h, continuation);
    if (!byOpt) { byOpt = new Map(); chainCache.set(mask, byOpt); }
    byOpt.set(key, res);
    return res;
  };
  function strokeChainsOf(mask, w, h, continuation) {
    const { sw, graph } = cachedGraph(mask, w, h);
    if (!(sw > 2) || !graph) return null;
    const segs = graph.segments;
    if (segs.length < 2) return null;
    const X = (p) => p % w, Y = (p) => (p / w) | 0;
    // junction clusters: junction pixels within ¾ of a stroke of each other
    const jpix = [];
    for (let i = 0; i < graph.junction.length; i++) if (graph.junction[i]) jpix.push(i);
    const jpar = new Map(jpix.map((p) => [p, p]));
    const jfind = (p) => { while (jpar.get(p) !== p) { jpar.set(p, jpar.get(jpar.get(p))); p = jpar.get(p); } return p; };
    const junion = (a, b) => { a = jfind(a); b = jfind(b); if (a !== b) jpar.set(a, b); };
    const near = 0.75 * sw;
    for (let a = 0; a < jpix.length; a++) {
      for (let b = a + 1; b < jpix.length; b++) {
        if (Math.hypot(X(jpix[a]) - X(jpix[b]), Y(jpix[a]) - Y(jpix[b])) <= near) junion(jpix[a], jpix[b]);
      }
    }
    // a corner split right beside a junction is the junction itself (the
    // skeleton can pass diagonally by a junction pixel instead of through
    // it, and read the turn into the stem as a corner)
    const jNear = new Set();
    for (const s of segs) {
      for (const e of s.ends) {
        if (e < 0 || graph.junction[e] || graph.endpoint[e] || jNear.has(e)) continue;
        for (const p of jpix) {
          if (Math.hypot(X(p) - X(e), Y(p) - Y(e)) <= near) { jNear.add(e); jpar.set(e, e); junion(e, p); break; }
        }
      }
    }
    for (const e of jNear) jpix.push(e);
    // short pieces between junctions are the junction's own inside
    const isJ = (e) => e >= 0 && (graph.junction[e] || jNear.has(e));
    const link = new Uint8Array(segs.length);
    segs.forEach((s, k) => {
      const [a, b] = s.ends;
      if (isJ(a) && isJ(b) && (jfind(a) === jfind(b) || s.pixels.length < 0.6 * sw)) { junion(a, b); link[k] = 1; }
    });
    // chains: union-find over segments
    const par = segs.map((_, k) => k);
    const find = (k) => { while (par[k] !== k) { par[k] = par[par[k]]; k = par[k]; } return k; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
    // across the letter's own corners (split points shared by two pieces)
    const byNode = new Map();
    segs.forEach((s, k) => {
      if (link[k]) return;
      for (const e of s.ends) {
        if (e < 0 || graph.junction[e] || graph.endpoint[e] || jNear.has(e)) continue;
        if (!byNode.has(e)) byNode.set(e, []);
        byNode.get(e).push(k);
      }
    });
    for (const ks of byNode.values()) for (let i = 1; i < ks.length; i++) union(ks[0], ks[i]);
    // arms of each junction cluster, with the direction they leave in
    const arms = new Map(); // cluster root → [{k, dx, dy}]
    segs.forEach((s, k) => {
      if (link[k]) return;
      const n = s.pixels.length;
      if (!n) return;
      for (let side = 0; side < 2; side++) {
        const e = s.ends[side];
        if (!isJ(e)) continue;
        const m = Math.min(n - 1, Math.max(2, Math.round(1.5 * sw)));
        const nearP = side === 0 ? s.pixels[0] : s.pixels[n - 1];
        const farP = side === 0 ? s.pixels[m] : s.pixels[n - 1 - m];
        let dx = X(farP) - X(nearP), dy = Y(farP) - Y(nearP);
        const L = Math.hypot(dx, dy) || 1;
        const root = jfind(e);
        if (!arms.has(root)) arms.set(root, []);
        arms.get(root).push({ k, dx: dx / L, dy: dy / L });
      }
    });
    // good continuation: the arms that run straight on through a junction
    for (const list of continuation ? arms.values() : []) {
      const pairs = [];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const dev = Math.acos(Math.max(-1, Math.min(1, -(list[i].dx * list[j].dx + list[i].dy * list[j].dy))));
          if (dev < (40 * Math.PI) / 180) pairs.push({ i, j, dev });
        }
      }
      pairs.sort((a, b) => a.dev - b.dev);
      const used = new Uint8Array(list.length);
      for (const p of pairs) {
        if (used[p.i] || used[p.j]) continue;
        used[p.i] = used[p.j] = 1;
        union(list[p.i].k, list[p.j].k);
      }
    }
    // number the chains
    const chainId = new Int32Array(segs.length);
    let n = 0;
    const idOf = new Map();
    segs.forEach((_, k) => {
      if (link[k]) return;
      const r = find(k);
      if (!idOf.has(r)) idOf.set(r, ++n);
      chainId[k] = idOf.get(r);
    });
    if (n < 2) return null;
    const clusterIdx = new Map();
    let nc = 0;
    for (const p of jpix) { const r = jfind(p); if (!clusterIdx.has(r)) clusterIdx.set(r, nc++); }
    const armsOf = Array.from({ length: nc }, () => new Set());
    for (const [root, list] of arms) for (const a of list) armsOf[clusterIdx.get(root)].add(chainId[a.k]);
    const adj = Array.from({ length: n + 1 }, () => new Set());
    for (const set of armsOf) for (const a of set) for (const b of set) if (a !== b) adj[a].add(b);
    // every ink pixel to its nearest skeleton owner
    const owner = new Int32Array(w * h);
    const queue = new Int32Array(w * h);
    let qh = 0, qt = 0;
    segs.forEach((s, k) => {
      const id = link[k] ? -(clusterIdx.get(jfind(s.ends[0])) + 1) : chainId[k];
      for (const p of s.pixels) if (!owner[p]) { owner[p] = id; queue[qt++] = p; }
    });
    for (const p of jpix) if (!owner[p]) { owner[p] = -(clusterIdx.get(jfind(p)) + 1); queue[qt++] = p; }
    while (qh < qt) {
      const i = queue[qh++], o = owner[i], x = i % w;
      if (x > 0 && mask[i - 1] && !owner[i - 1]) { owner[i - 1] = o; queue[qt++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !owner[i + 1]) { owner[i + 1] = o; queue[qt++] = i + 1; }
      if (i >= w && mask[i - w] && !owner[i - w]) { owner[i - w] = o; queue[qt++] = i - w; }
      if (i + w < mask.length && mask[i + w] && !owner[i + w]) { owner[i + w] = o; queue[qt++] = i + w; }
    }
    // each chain's whole tube — the discs of its skeleton — so a stroke
    // kept stays whole where it crosses one taken away
    const dt = R.distanceTransform(mask, w, h);
    const tubes = Array.from({ length: n + 1 }, () => null);
    const skel = Array.from({ length: n + 1 }, () => []); // each chain's skeleton pixels
    const mark = new Uint8Array(w * h);
    for (let c = 1; c <= n; c++) {
      const idx = [];
      segs.forEach((sg, k) => {
        if (link[k] || chainId[k] !== c) return;
        for (const p of sg.pixels) skel[c].push(p);
        // a disc every few pixels along the skeleton: they overlap so much
        // that stamping every one only costs time (a fat stroke's discs are
        // big) — spaced a sixth of the radius apart the tube is the same
        let lastK = -1e9;
        const px0 = sg.pixels;
        for (let k = 0; k < px0.length; k++) {
          const p = px0[k];
          if (k !== px0.length - 1 && k - lastK < Math.max(1, dt[p] / 6)) continue;
          lastK = k;
          const r = dt[p], px = X(p), py = Y(p), rr = (r + 0.5) * (r + 0.5);
          for (let yy = Math.max(0, Math.floor(py - r)); yy <= Math.min(h - 1, Math.ceil(py + r)); yy++) {
            for (let xx = Math.max(0, Math.floor(px - r)); xx <= Math.min(w - 1, Math.ceil(px + r)); xx++) {
              const i = yy * w + xx;
              if (mark[i] || !mask[i] || (xx - px) * (xx - px) + (yy - py) * (yy - py) > rr) continue;
              mark[i] = 1; idx.push(i);
            }
          }
        }
      });
      for (const i of idx) mark[i] = 0;
      tubes[c] = Int32Array.from(idx);
    }
    return { n, owner, armsOf, adj, sw, tubes, skel, dt };
  }

  // The shape made of some of the chains (a Set of ids), with the junctions
  // any of them runs into.
  function renderChains(sc, mask, set) {
    const out = new Uint8Array(mask.length);
    const jIn = sc.armsOf.map((arms) => { for (const a of arms) if (set.has(a)) return true; return false; });
    for (let i = 0; i < mask.length; i++) {
      const o = sc.owner[i];
      if (!mask[i] || !o) continue;
      if (o > 0 ? set.has(o) : jIn[-o - 1]) out[i] = 1;
    }
    for (const c of set) for (const i of sc.tubes[c]) out[i] = 1;
    return out;
  }

  // The shape made of some of its strokes (a Set of chain ids from
  // strokeChains), the faces where the rest came off healed and capped.
  ex.renderStrokes = function (sc, mask, w, h, set) {
    let out = renderChains(sc, mask, set);
    const removed = new Uint8Array(mask.length);
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] && !out[i]) { removed[i] = 1; n++; }
    if (n) out = healCut(out, mask, removed, w, h, sc.sw);
    return out;
  };

  /**
   * Take a piece off a shape: the stroke under (px, py) and whatever hangs
   * on the shape only through it — a neighbor's letter fused on, a drip, a
   * stray blob — keeping the part that holds `anchor` ({x, y}, the letter
   * you clicked; else the biggest part). A piece not joined to the letter
   * at all goes whole. The faces where it came off are healed and capped.
   * → { mask, removed } or null (nothing there, or it is the whole shape)
   */
  ex.removePiece = function (mask, w, h, px, py, anchor) {
    const sw = R.strokeWidth(mask, w, h);
    const x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const at = nearestInk(mask, w, h, x, y, Math.max(6, Math.round(sw)));
    if (at < 0) return null;
    const total = R.count(mask);
    const { labels, sizes } = R.components(mask, w, h);
    const anchorIdx = anchor ? nearestInk(mask, w, h, Math.max(0, Math.min(w - 1, Math.round(anchor.x))), Math.max(0, Math.min(h - 1, Math.round(anchor.y))), 3) : -1;
    let mainL = anchorIdx >= 0 ? labels[anchorIdx] : 0;
    if (!mainL) { let best = 0; for (let L = 1; L < sizes.length; L++) if (sizes[L] > best) { best = sizes[L]; mainL = L; } }
    let out;
    if (labels[at] !== mainL) {
      // a separate piece: all of it goes
      out = new Uint8Array(mask);
      for (let i = 0; i < out.length; i++) if (labels[i] === labels[at]) out[i] = 0;
    } else {
      const sc = ex.strokeChains(mask, w, h);
      if (!sc) return null;
      let chain = sc.owner[at];
      if (chain < 0) {
        // on a junction: the stroke through it whose tube holds the click
        const arms = Array.from(sc.armsOf[-chain - 1]);
        chain = arms.find((c) => sc.tubes[c].indexOf(at) >= 0) || arms[0];
      }
      if (!(chain > 0)) return null;
      const rest = new Set();
      for (let c = 1; c <= sc.n; c++) if (c !== chain) rest.add(c);
      const kept = renderChains(sc, mask, rest);
      // what still holds the letter: the part with the anchor if it
      // survived, else the biggest part
      const kc = R.components(kept, w, h);
      let keepL = anchorIdx >= 0 && kept[anchorIdx] ? kc.labels[anchorIdx] : 0;
      if (!keepL) { let best = 0; for (let L = 1; L < kc.sizes.length; L++) if (kc.sizes[L] > best) { best = kc.sizes[L]; keepL = L; } }
      if (!keepL) return null;
      out = new Uint8Array(w * h);
      for (let i = 0; i < out.length; i++) if (kc.labels[i] === keepL) out[i] = 1;
      // other separate pieces of the shape stay as they were
      for (let i = 0; i < out.length; i++) if (mask[i] && labels[i] !== mainL) out[i] = 1;
    }
    const removed = new Uint8Array(w * h);
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] && !out[i]) { removed[i] = 1; n++; }
    if (!n || R.count(out) < total * 0.05) return null;
    if (sw > 1) out = healCut(out, mask, removed, w, h, sw);
    return { mask: out, removed: n };
  };

  /**
   * The letter under a click in a shape fused with same-colored neighbors,
   * grown stroke by stroke: from the stroke under (cx, cy), add whichever
   * touching stroke makes the shape score best as the letter (`score(mask)`,
   * e.g. a template match for the typed character), and keep the best
   * shape met along the way. → { mask, score, strokes, of } or null
   */
  ex.growLetter = function (mask, w, h, cx, cy, score) {
    const sc = ex.strokeChains(mask, w, h);
    if (!sc) return null;
    let sx = Math.round(cx), sy = Math.round(cy);
    const at = nearestInk(mask, w, h, Math.max(0, Math.min(w - 1, sx)), Math.max(0, Math.min(h - 1, sy)), Math.round(sc.sw * 2) + 4);
    if (at < 0) return null;
    let start = sc.owner[at];
    if (start < 0) { const arms = Array.from(sc.armsOf[-start - 1]); if (!arms.length) return null; start = arms[0]; }
    if (!(start > 0)) return null;
    let set = new Set([start]);
    let cur = score(renderChains(sc, mask, set));
    let best = { set: new Set(set), s: cur };
    for (let step = 0; step < 14; step++) {
      const next = new Set();
      for (const c of set) for (const d of sc.adj[c]) if (!set.has(d)) next.add(d);
      if (!next.size) break;
      let pick = null, pickS = -1;
      for (const d of next) {
        const trial = new Set(set); trial.add(d);
        const s = score(renderChains(sc, mask, trial));
        if (s > pickS) { pickS = s; pick = d; }
      }
      set.add(pick); cur = pickS;
      if (cur > best.s + 1e-4) best = { set: new Set(set), s: cur };
    }
    let out = renderChains(sc, mask, best.set);
    const removed = new Uint8Array(mask.length);
    let nRemoved = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] && !out[i]) { removed[i] = 1; nRemoved++; }
    if (!nRemoved) return null;
    out = healCut(out, mask, removed, w, h, sc.sw);
    return { mask: out, score: best.s, strokes: best.set.size, of: sc.n };
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
    // the click is on the letter: each cut takes only from its other side
    const excl = ex.cutMask(w, h, o.cuts, { x, y });
    const bg = ex.backgroundColor(data, w, h);
    if (bg && !o.noSnap) {
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
    }
    // Metallic and shaded paint has several tones, and the click (or the
    // densest spot it snapped to) may sit on the darkest streak: the paint's
    // BODY tone is the most common non-wall color around the click that
    // shares the wall→sample axis (a neighbor of another color does not)
    let wall = null;
    if (bg) {
      wall = ex.wallMask(data, w, h, bg, ex.wallTolerance(data, w, h, bg));
      const reach = Math.round(Math.max(w, h) * 0.2);
      const x0 = Math.max(0, x - reach), x1 = Math.min(w - 1, x + reach);
      const y0 = Math.max(0, y - reach), y1 = Math.min(h - 1, y + reach);
      const blob = R.floodFrom(w, h, x, y, (i) => {
        if (wall[i] || (excl && excl[i])) return false;
        const px = i % w, py = (i / w) | 0;
        return px >= x0 && px <= x1 && py >= y0 && py <= y1;
      });
      if (blob.count >= 60) {
        const dom = dominantAlongAxis(data, w, h, blob.mask, seed, bg);
        if (dom && R.colorDist(dom.r, dom.g, dom.b, bg.r, bg.g, bg.b) >= 40) seed = dom;
      }
    }
    // the field: distance along the wall→paint axis, so metallic and glossy
    // paint that shades and glints past the paint color still counts
    field = bg ? R.axisDistMap(data, w, h, seed, bg) : R.colorDistMap(data, w, h, [seed]);
    if (o.blur > 0) field = R.blur(field, w, h, o.blur);
    // never grow past the midpoint between paint and background: beyond it
    // a pixel is more paper than paint whatever the boundary looks like
    const sep = bg ? R.colorDist(seed.r, seed.g, seed.b, bg.r, bg.g, bg.b) : Infinity;
    const grown = autoRegion(field, excl, w, h, x, y, { maxTol: Math.max(40, sep * 0.55) });
    if (!grown || grown.count < 40) return null;

    // Gap jumping: dry-brush streaks and porous surfaces break a stroke
    // into fragments a plain flood stops at. Grow again on the paint closed
    // by up to half a stroke (scaled by the smoothing knob), so a streaky
    // stroke reads as one — unless that suddenly pulls in far more.
    let region = grown.mask, count = grown.count;
    // this paint, as classified, all over the photo
    const paintT = new Uint8Array(w * h);
    for (let i = 0; i < paintT.length; i++) paintT[i] = field[i] <= grown.t && !(excl && excl[i]) ? 1 : 0;
    let pieces = paintT; // what completion may join: the paint, gap-jumped if that held
    const sw0 = R.strokeWidth(grown.mask, w, h);
    const g = Math.round(Math.min(sw0 * 0.45, Math.max(w, h) * 0.02) * (o.smoothing / 4));
    if (g >= 2) {
      const closed = R.close(paintT, w, h, g);
      if (excl) for (let i = 0; i < closed.length; i++) if (excl[i]) closed[i] = 0;
      const re = R.floodFrom(w, h, x, y, (i) => closed[i] === 1);
      if (re.count >= count && re.count <= count * 2.5 && !leaks(re.mask, re.count, w, h, 0.35)) {
        region = re.mask; count = re.count; pieces = closed;
      }
    }

    // Occlusion: carry the letter on under whatever hides it — a pipe, a
    // crack, another color painted over it, the frame edge — joining the
    // pieces of it that show on the far side (see complete.js)
    let P = 0, W2 = w, H2 = h, full = region, tubes = null, cls = null, completion = null;
    if (bg && wall && ST.complete && !o.noComplete) {
      cls = ST.complete.classify(data, w, h, { bg, seed, paint: paintT, wall, sw: sw0 });
      // past the photo's edge (a straightened photo's filled-in corners)
      if (canvas._inPhoto) for (let i = 0; i < cls.length; i++) if (!canvas._inPhoto[i]) cls[i] = ST.complete.FRAME;
      // a cut says the letter stops there: nothing is carried across it
      if (excl) for (let i = 0; i < cls.length; i++) if (excl[i]) cls[i] = ST.complete.WALL;
      const bb = R.maskBounds(region, w, h);
      const margin = Math.round(Math.max(5 * sw0, 0.35 * Math.max(bb.w, bb.h)));
      completion = ST.complete.complete(pieces, w, h, {
        at: ST.complete.sampler(cls, w, h),
        seed: y * w + x,
        box: { x0: Math.max(0, bb.x0 - margin), y0: Math.max(0, bb.y0 - margin), x1: Math.min(w - 1, bb.x1 + margin), y1: Math.min(h - 1, bb.y1 + margin) },
        margin,
        letterWidth: sw0,
        minArea: Math.max(60, Math.round(count * 0.01)),
      });
      P = completion.P; W2 = completion.W2; H2 = completion.H2;
      full = completion.mask; tubes = completion.tubes;
    }

    // room round the letter for an outline hugging it
    const cropP = bboxOf(full, W2, H2, 12 + (cls ? Math.round(0.25 * sw0) : 0));
    if (!cropP) return null;
    const crop = { x: cropP.x - P, y: cropP.y - P, w: cropP.w, h: cropP.h };
    let sub = cropMask(full, W2, cropP);
    const tubeSub = tubes ? cropMask(tubes, W2, cropP) : null;
    // the paint as classified, before any filling
    const base = cropAny(paintT, w, h, crop, 0);
    for (let i = 0; i < base.length; i++) if (!sub[i]) base[i] = 0;
    // what completion drew is set aside while the fills are judged
    if (tubeSub) for (let i = 0; i < sub.length; i++) if (tubeSub[i] && !base[i]) sub[i] = 0;
    // pocks, cracks and dirt inside the paint read as paint
    if (wall) sub = ex.absorbDefects(sub, cropAny(wall, w, h, crop, 1), crop.w, crop.h);
    // of everything the gap-jump closing and the defect fill added, keep the
    // bridges across gaps and the pocks inside the strokes — not the webs
    // spun over inside corners
    sub = ex.keepBridges(base, sub, crop.w, crop.h);
    if (tubeSub) for (let i = 0; i < sub.length; i++) if (tubeSub[i]) sub[i] = 1;
    let counters = null;
    if (cls) {
      const at = ST.complete.sampler(cls, w, h);
      // a throw-up's outline is the letter's; so is a hole that shows no wall
      const ol = ST.complete.absorbOutline(sub, crop.w, crop.h, cls, w, h, crop.x, crop.y);
      sub = ol.mask; counters = ol.counters;
      sub = ST.complete.fillHiddenHoles(sub, crop.w, crop.h, at, crop.x, crop.y);
    }
    const lx = x - crop.x, ly = y - crop.y;
    let whole = ex.cleanMask(sub, crop.w, crop.h, o.smoothing, { noRound: o.noRound });
    if (counters) for (let i = 0; i < whole.length; i++) if (counters[i]) whole[i] = 0;
    // a cut slices the stroke flat; give the sliced ends a marker's round cap
    if (excl && !o.noRound) whole = ex.roundCutEnds(whole, crop.w, crop.h, cropAny(excl, w, h, crop, 0));

    const candidates = [];
    const push = (mask, kind) => {
      const paths = ST.trace.vectorize(mask, crop.w, crop.h, {});
      if (paths.length) candidates.push({ crop, mask, w: crop.w, h: crop.h, paths, kind });
    };
    // The letter under the click without the neighbors fused onto it: its
    // strokes grouped the way the recognizer reads one character (see
    // letters.js) — offered first when the whole shape reads as several
    // letters, or the letter reads clearly better than the whole. Without
    // a recognizer, a split at a thin neck (a touching neighbor) instead.
    let separated = null, kind = 'separated', read = null;
    // (after a cut the shape is what you made it: nothing is regrouped)
    const reads = ST.letters && ST.recognize && ST.recognize.ready() && !o.noLetters && !(o.cuts && o.cuts.length);
    if (reads) {
      const found = ST.letters.find(whole, crop.w, crop.h, { center: { x: lx, y: ly }, must: { x: lx, y: ly } });
      const lt = found && found.letters[0];
      if (lt && lt.set.size < found.sc.n && lt.explained && ST.letters.better(lt.read, { ranked: found.whole.top, letterness: found.whole.letterness })) {
        separated = ST.letters.render(found, whole, crop.w, crop.h, lt);
        kind = 'letter';
        read = lt.read;
      }
    } else if (!(o.cuts && o.cuts.length)) {
      separated = ex.separateTouching(whole, crop.w, crop.h, lx, ly);
    }
    // what completion joined is the letter's by evidence: a split that
    // drops part of it is not a neighbor coming off
    if (separated && tubeSub) {
      let t = 0, kept = 0;
      for (let i = 0; i < tubeSub.length; i++) if (tubeSub[i] && whole[i]) { t++; if (separated[i]) kept++; }
      if (t && kept < 0.9 * t) separated = null;
    }
    if (separated && kind === 'letter') {
      // boxed to the letter itself
      const bb = R.maskBounds(separated, crop.w, crop.h);
      if (bb) {
        const pad = 12;
        const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
        const x1 = Math.min(crop.w, bb.x1 + 1 + pad), y1 = Math.min(crop.h, bb.y1 + 1 + pad);
        const lw = x1 - x0, lh = y1 - y0, sub = new Uint8Array(lw * lh);
        for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) sub[y * lw + x] = separated[(y + y0) * crop.w + (x + x0)];
        const paths = ST.trace.vectorize(sub, lw, lh, {});
        if (paths.length) candidates.push({ crop: { x: crop.x + x0, y: crop.y + y0, w: lw, h: lh }, mask: sub, w: lw, h: lh, paths, kind, read });
      }
    } else if (separated) push(separated, kind);
    push(whole, 'whole');
    if (!candidates.length) return null;
    return {
      seed, bg, click: { x, y }, tolerance: grown.t, region: crop, candidates,
      completion: completion ? { pairs: completion.pairs, extensions: completion.extensions } : null,
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
