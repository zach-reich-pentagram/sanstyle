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
    const sw = R.strokeWidth(m, w, h);
    if (sm > 0) {
      const scale = Math.max(w, h) / 700;
      // closing heals gaps, cracks and notches: the radius follows the knob
      // and the photo's size, up to nearly half a stroke
      const rc = Math.max(0, Math.min(Math.round(sm * 1.6 * scale), Math.floor(sw * 0.45)));
      // opening shaves fibers and burrs, but never thins the THINNEST
      // strokes (a chisel marker's thin side is far thinner than the
      // average stroke): fibers are thin, so a modest disk still removes them
      const rt = R.thinRadius(m, w, h);
      const ro = Math.max(0, Math.min(rc, rt > 0 ? Math.floor(rt * 0.7) : rc));
      if (rc > 0) m = R.close(m, w, h, rc);
      if (ro > 0) m = R.open(m, w, h, ro);
      if (!(opts && opts.noRound)) m = ex.roundEnds(m, w, h, null);
    }
    // fill speckle gaps — holes smaller than the pen could leave on purpose
    // (well under a stroke width across, more with the knob up); a counter,
    // even a small one in a fat letter, is never that small
    const cap = sw > 0 ? Math.pow(0.6 * sw * (0.5 + sm / 8), 2) : undefined;
    m = R.fillHoles(m, w, h, 0.06, cap);
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
    const sw = R.strokeWidth(mask, w, h);
    if (!(sw > 1)) return null;
    const graph = strokeGraph(mask, w, h, sw);
    if (!graph.segments.length) return null;
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
    if (nRemoved) {
      // heal the join: a removed stroke's skeleton ran into the letter's
      // stroke, taking a notch of the letter with it — closing refills the
      // notch (a concavity) without rebuilding the removed stroke (convex);
      // then shave the nub and cap the faces
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
      result = ex.roundCutEnds(result, w, h, R.dilate(face, w, h, 2));
    }
    return { mask: result, removed: nRemoved, strokes: graph.segments.length, foreign: nForeign, farLimit, info };
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
    const sw0 = R.strokeWidth(grown.mask, w, h);
    const g = Math.round(Math.min(sw0 * 0.45, Math.max(w, h) * 0.02) * (o.smoothing / 4));
    if (g >= 2) {
      const paintT = new Uint8Array(w * h);
      for (let i = 0; i < paintT.length; i++) paintT[i] = field[i] <= grown.t && !(excl && excl[i]) ? 1 : 0;
      const closed = R.close(paintT, w, h, g);
      if (excl) for (let i = 0; i < closed.length; i++) if (excl[i]) closed[i] = 0;
      const re = R.floodFrom(w, h, x, y, (i) => closed[i] === 1);
      if (re.count >= count && re.count <= count * 2.5 && !leaks(re.mask, re.count, w, h, 0.35)) { region = re.mask; count = re.count; }
    }

    const crop = bboxOf(region, w, h, 12);
    if (!crop) return null;
    let sub = cropMask(region, w, crop);
    // pocks, cracks and dirt inside the paint read as paint
    if (bg) {
      const wall = ex.wallMask(data, w, h, bg, ex.wallTolerance(data, w, h, bg));
      sub = ex.absorbDefects(sub, cropMask(wall, w, crop), crop.w, crop.h);
    }
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
