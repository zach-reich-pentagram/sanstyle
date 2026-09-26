/* Sanstyle — complete.js
 * Seeing past what hides the letter. A stroke that stops at bare wall has
 * ended: the pen lifted there. A stroke that stops at something else — a
 * drainpipe or a sign in front of it, a crack or a chip, another color
 * painted over it, the edge of the photo — has only been HIDDEN there, and
 * the letter goes on underneath. So:
 *
 *   1. every pixel of the photo is read as wall, this paint, this paint's
 *      own halo/shading, or hidden (anything else; outside the frame too);
 *   2. the free ends of the strokes are found, each with the direction it
 *      leaves in and its width, and the ones that run into hidden pixels
 *      are marked as cut short;
 *   3. two cut-short ends that face each other across hidden ground are
 *      the same stroke: they are joined by the curve that continues both
 *      (straight across a pipe, round a U's bottom past the frame edge) at
 *      the width they share — never across visible wall;
 *   4. a cut-short end with no partner is carried on into the hidden
 *      ground by a plausible amount and given the pen's round cap: past
 *      the frame as far as the letter's other strokes reach that way,
 *      behind an occluder no further than the occluder allows;
 *   5. holes in the letter that are not wall-colored (a sticker on the
 *      stroke, a chip) are not counters and are filled, and a thin band of
 *      another color hugging the letter all round — a throw-up's outline —
 *      is part of the letter.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const R = ST.raster;
  const C = (ST.complete = {});
  const WALL = 0, PAINT = 1, FAMILY = 2, HIDDEN = 3, FRAME = 4;
  Object.assign(C, { WALL, PAINT, FAMILY, HIDDEN, FRAME });

  // ---------- 1. what the photo shows ----------
  // o: { bg, seed, paint (W×H mask of this paint), wall (W×H mask), sw }
  C.classify = function (data, w, h, o) {
    const { bg, seed, paint, wall } = o;
    const sw = Math.max(4, o.sw || 20);
    const cls = new Uint8Array(w * h);
    const ax = seed.r - bg.r, ay = seed.g - bg.g, az = seed.b - bg.b;
    const len2 = Math.max(1, ax * ax + ay * ay + az * az);
    const maxRes = Math.max(26, Math.sqrt(len2) * 0.3);
    // the paint's halo and blend hug it; the same tone further off is an
    // object of its own (a silver pipe in front of black paint)
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < inv.length; i++) inv[i] = paint[i] ? 0 : 1;
    const dp = R.distanceTransform(inv, w, h, { borderInk: true });
    const reach = 2.5 * sw + 4;
    const hid = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < cls.length; i++, p += 4) {
      if (paint[i]) { cls[i] = PAINT; continue; }
      if (wall[i]) { cls[i] = WALL; continue; }
      const vx = data[p] - bg.r, vy = data[p + 1] - bg.g, vz = data[p + 2] - bg.b;
      const u = (vx * ax + vy * ay + vz * az) / len2;
      const rx = vx - u * ax, ry = vy - u * ay, rz = vz - u * az;
      const onAxis = u > -0.05 && u < 1.8 && Math.sqrt(rx * rx + ry * ry + rz * rz) <= maxRes;
      if (onAxis && dp[i] <= reach) cls[i] = FAMILY;
      else { cls[i] = HIDDEN; hid[i] = 1; }
    }
    // grain, dirt and blend pixels hide nothing: only solid patches count
    const solid = R.open(hid, w, h, 1);
    const { labels, sizes } = R.components(solid, w, h);
    const minArea = Math.max(30, Math.pow(0.25 * sw, 2));
    for (let i = 0; i < cls.length; i++) {
      if (cls[i] !== HIDDEN) continue;
      const L = labels[i];
      if (!solid[i] || sizes[L] < minArea) cls[i] = dp[i] <= 2.5 ? FAMILY : WALL;
    }
    return cls;
  };

  // class at photo pixel (x, y); outside the photo is hidden by the frame
  C.sampler = function (cls, w, h) {
    return (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? FRAME : cls[y * w + x]);
  };

  // ---------- 2. stroke ends ----------
  // The free ends of the strokes of `mask` inside `box` ({x0, y0, x1, y1},
  // inclusive; default: all), in mask coordinates: the tip (the last ink
  // along the stroke's direction), the unit direction the stroke leaves
  // in, and the stroke's body half-width near the end.
  C.strokeEnds = function (mask, w, h, box, only) {
    const x0 = box ? Math.max(0, box.x0) : 0, y0 = box ? Math.max(0, box.y0) : 0;
    const x1 = box ? Math.min(w - 1, box.x1) : w - 1, y1 = box ? Math.min(h - 1, box.y1) : h - 1;
    // a one-pixel empty ring round the box keeps the skeleton off its edge
    const bw = x1 - x0 + 3, bh = y1 - y0 + 3;
    if (bw < 8 || bh < 8) return [];
    const sub = new Uint8Array(bw * bh);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (mask[i] && (!only || only(i))) sub[(y - y0 + 1) * bw + (x - x0 + 1)] = 1;
      }
    }
    const sw = R.strokeWidth(sub, bw, bh);
    if (!(sw >= 3)) return [];
    const graph = ST.extract.strokeGraph(sub, bw, bh, sw);
    const dt = R.distanceTransform(sub, bw, bh);
    const X = (p) => p % bw, Y = (p) => (p / bw) | 0;
    const ends = [];
    // from each free end, the skeleton inward up to the first junction —
    // not split at corners: a stroke that bends to graze the frame edge
    // still reads its body beyond the bend
    const skel = graph.skel;
    const N8 = [-bw, -1, 1, bw, -bw - 1, -bw + 1, bw - 1, bw + 1];
    const walk = (e) => {
      const path = [e], seen = new Set(path);
      let cur = e;
      for (let step = 0; step < 2500; step++) {
        let next = -1;
        for (const d of N8) {
          const q = cur + d;
          if (!skel[q] || seen.has(q)) continue;
          next = q; break;
        }
        if (next < 0 || graph.junction[next]) break;
        path.push(next); seen.add(next); cur = next;
      }
      return path;
    };
    for (let e = 0; e < skel.length; e++) {
      if (!skel[e] || !graph.endpoint[e]) continue;
      {
        const path = walk(e);
        const pctl = (a, b, q) => {
          const v = [];
          for (let i = a; i <= b && i < path.length; i++) v.push(dt[path[i]]);
          if (!v.length) return 0;
          v.sort((m, n) => m - n);
          return v[Math.min(v.length - 1, Math.floor(v.length * q))];
        };
        // the stroke's body width, and where the body starts: an end that
        // tapers (a marker fading out, a stroke grazing the frame edge, one
        // cut at a slant by an occluder) is read from where the stroke has
        // its width back, not from the sliver
        const body = pctl(0, Math.min(path.length - 1, 1500), 0.6);
        if (!(body >= 1.5)) continue;
        let s0 = 0;
        while (s0 < path.length / 2 && dt[path[s0]] < 0.7 * body) s0++;
        const r = pctl(s0, s0 + Math.round(4 * body), 0.6) || body;
        if (path.length - s0 < 1.2 * r) continue;
        // direction: the chord over the body (from 0.5 to 3.5 half-widths
        // past its start), or as much of it as the stroke has
        const last = path.length - 1;
        let a = Math.min(last, s0 + Math.round(0.5 * r));
        let b = Math.min(last, s0 + Math.round(3.5 * r));
        if (b - a < 3) { a = Math.min(last, s0); b = Math.min(last, s0 + Math.max(4, Math.round(2 * r))); }
        if (b - a < 3) continue;
        let dx = X(path[a]) - X(path[b]), dy = Y(path[a]) - Y(path[b]);
        const L = Math.hypot(dx, dy);
        if (!L) continue;
        dx /= L; dy /= L;
        // a curving stroke (a U's bottom, an O's arc) leaves its end turned
        // further than the chord says: read the turn between the near and
        // the far halves of the body and carry it on to the tip
        const m = Math.min(last, s0 + Math.round(1.8 * r)), f2 = Math.min(last, s0 + Math.round(3.3 * r));
        const n0 = Math.min(last, s0 + Math.round(0.3 * r));
        if (f2 - m >= Math.max(4, r) && m - n0 >= Math.max(4, r)) {
          const d1x = X(path[n0]) - X(path[m]), d1y = Y(path[n0]) - Y(path[m]);
          const d2x = X(path[m]) - X(path[f2]), d2y = Y(path[m]) - Y(path[f2]);
          const delta = Math.atan2(d2x * d1y - d2y * d1x, d2x * d1x + d2y * d1y);
          const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
          if (Math.abs(delta) > (6 * Math.PI) / 180 && l1 && l2) {
            // tangent at the near chord's middle, turned on by the curvature
            // over the arc from there to the end of the body
            const kappa = delta / (0.5 * (l1 + l2));
            const turnBy = Math.max(-0.8, Math.min(0.8, kappa * (0.5 * l1 + 0.8 * r)));
            const bx = d1x / l1, by = d1y / l1, cs = Math.cos(turnBy), sn = Math.sin(turnBy);
            dx = bx * cs - by * sn; dy = bx * sn + by * cs;
          }
        }
        // march out along the body's centerline to the last ink
        const ax0 = X(path[a]), ay0 = Y(path[a]);
        const proj = Math.max(0, (X(path[s0]) - ax0) * dx + (Y(path[s0]) - ay0) * dy);
        const sx0 = ax0 + dx * proj, sy0 = ay0 + dy * proj;
        let tx = sx0, ty = sy0;
        for (let d = 0.5; d < 4 * r + 8; d += 0.5) {
          const qx = Math.round(sx0 + dx * d), qy = Math.round(sy0 + dy * d);
          if (qx < 0 || qy < 0 || qx >= bw || qy >= bh || !sub[qy * bw + qx]) break;
          tx = sx0 + dx * d; ty = sy0 + dy * d;
        }
        ends.push({
          x: tx + x0 - 1, y: ty + y0 - 1, sx: X(e) + x0 - 1, sy: Y(e) + y0 - 1,
          dx, dy, r, sw, len: path.length,
        });
      }
    }
    return ends;
  };

  // ---------- 3. what lies beyond an end ----------
  // How far past the paint the wall starts: beyond the tip (three parallel
  // rays), and beside the stroke just behind it. A bleed halo, overspray
  // and the blended edge surround a stroke on every side alike, so a real
  // end meets the wall about as soon ahead as to the sides. Something in
  // front of the end — a pipe, a sign, another color, a crack — keeps the
  // wall away ahead only; the frame edge hides everything past it.
  // along a ray: how far to the wall, and how far to the first hidden
  // pixel (another color, an object, the frame)
  function rayRun(at, x, y, dx, dy, maxD) {
    let hid = Infinity, frame = false;
    for (let d = 1; d <= maxD; d++) {
      const c = at(Math.round(x + dx * d), Math.round(y + dy * d));
      if (c === WALL) return { wall: d, hid, frame };
      if ((c === HIDDEN || c === FRAME) && hid === Infinity) { hid = d; frame = c === FRAME; }
    }
    return { wall: maxD, hid, frame };
  }
  C.probe = function (end, at) {
    const maxD = Math.round(3 * end.sw + 6);
    const nx = -end.dy, ny = end.dx;
    // the halo beside the stroke, 1.5 half-widths back from the tip: from
    // the skeleton out through the ink to the side edge, then across the
    // paint's own blend and halo only
    let side = Infinity;
    const bx = end.x - end.dx * 1.5 * end.r, by = end.y - end.dy * 1.5 * end.r;
    for (const s of [-1, 1]) {
      let d = 0;
      while (d < 3 * end.r && at(Math.round(bx + nx * s * d), Math.round(by + ny * s * d)) === PAINT) d++;
      let k = 0;
      while (k < maxD && at(Math.round(bx + nx * s * (d + k + 1)), Math.round(by + ny * s * (d + k + 1))) === FAMILY) k++;
      side = Math.min(side, k + 1);
    }
    const margin = Math.max(6, 0.35 * end.sw);
    let votes = 0, frames = 0;
    for (const off of [-0.45, 0, 0.45]) {
      const run = rayRun(at, end.x + nx * off * end.r, end.y + ny * off * end.r, end.dx, end.dy, maxD);
      if (run.hid < run.wall || run.wall > side + margin) { votes++; if (run.frame) frames++; }
    }
    if (votes < 2) return 'wall';
    return frames >= 2 ? 'frame' : 'hidden';
  };

  // the curve that leaves end A along its direction and arrives at end B
  // against B's: straight when they face each other, a round turn when
  // they converge from side by side (a U's legs, an O's arcs)
  function bridgeCurve(A, B) {
    const D = Math.hypot(B.x - A.x, B.y - A.y);
    const turn = Math.acos(Math.max(-1, Math.min(1, A.dx * -B.dx + A.dy * -B.dy)));
    // tangent length of a circular arc turning that far over chord D (so
    // an O's lost side comes back round, a U's bottom a half circle)
    const k = turn < 1e-3 ? D : (2 * D * Math.tan(turn / 4)) / Math.sin(turn / 2);
    const t0x = A.dx * k, t0y = A.dy * k, t1x = -B.dx * k, t1y = -B.dy * k;
    return (t) => {
      const t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      return {
        x: h00 * A.x + h10 * t0x + h01 * B.x + h11 * t1x,
        y: h00 * A.y + h10 * t0y + h01 * B.y + h11 * t1y,
      };
    };
  }

  function curveLength(f) {
    let L = 0, p = f(0);
    for (let i = 1; i <= 32; i++) { const q = f(i / 32); L += Math.hypot(q.x - p.x, q.y - p.y); p = q; }
    return L;
  }

  // What a tube along the curve would cover: shares of visible wall and of
  // hidden ground, sampled along the centerline and 0.6 r to either side.
  function coverage(f, len, r0, r1, at) {
    const n = Math.max(4, Math.ceil(len));
    let wall = 0, hidden = 0, total = 0, cw = 0, cn = 0;
    let prev = f(0);
    for (let i = 1; i <= n; i++) {
      const t = i / n, p = f(t);
      let tx = p.x - prev.x, ty = p.y - prev.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const r = r0 + (r1 - r0) * t;
      for (const off of [-0.6, 0, 0.6]) {
        const c = at(Math.round(p.x - ty * off * r), Math.round(p.y + tx * off * r));
        total++;
        if (off === 0) { cn++; if (c === WALL) cw++; }
        if (c === WALL) wall++;
        else if (c === HIDDEN || c === FRAME) hidden++;
      }
      prev = p;
    }
    return { wall: wall / total, hidden: hidden / total, center: cw / Math.max(1, cn) };
  }

  // Pair cut-short ends. Each end joins at most one other; cheapest first.
  // The geometry is read from each end's cap center (a little behind the
  // tip, on the stroke's centerline): a stroke cut at a slant has its tip
  // off to one side, and two such pieces can even overlap end to end.
  const capCenter = (E) => ({ x: E.x - E.dx * 0.8 * E.r, y: E.y - E.dy * 0.8 * E.r, dx: E.dx, dy: E.dy, r: E.r, sw: E.sw });
  C.pairEnds = function (ends, at) {
    const cands = [];
    for (let i = 0; i < ends.length; i++) {
      if (ends[i].status === 'wall') continue;
      const A = capCenter(ends[i]);
      for (let j = i + 1; j < ends.length; j++) {
        if (ends[j].status === 'wall') continue;
        const B = capCenter(ends[j]);
        const ratio = Math.max(A.r, B.r) / Math.min(A.r, B.r);
        if (ratio > 1.6) continue;
        const vx = B.x - A.x, vy = B.y - A.y, D = Math.hypot(vx, vy);
        const sw = Math.max(A.sw, B.sw);
        if (D < 1 || D > Math.max(10 * sw, 6 * (A.r + B.r))) continue;
        const aA = Math.acos(Math.max(-1, Math.min(1, (A.dx * vx + A.dy * vy) / D)));
        const aB = Math.acos(Math.max(-1, Math.min(1, (-B.dx * vx - B.dy * vy) / D)));
        const lim = (78 * Math.PI) / 180;
        if (aA > lim || aB > lim || aA + aB > (145 * Math.PI) / 180) continue;
        const f = bridgeCurve(A, B);
        const len = curveLength(f);
        if (len > 2.2 * D + 2 * sw) continue;
        // never across visible wall: if the stroke went there, it would show
        const cov = coverage(f, len, A.r, B.r, at);
        if (C.debug) (C.rejects = C.rejects || []).push({ a: [Math.round(A.x), Math.round(A.y)], b: [Math.round(B.x), Math.round(B.y)], wall: +cov.wall.toFixed(3), center: +cov.center.toFixed(3) });
        // the centerline strictly; the tube's flanks may graze a little wall
        // where the guessed curve drifts off the real one
        if (cov.center > 0.06 || cov.wall > 0.15) continue;
        const cost = len * (1 + 4 * cov.wall) * (1 + 0.5 * Math.log(ratio)) * (1 + (aA + aB) / Math.PI);
        cands.push({ i, j, cost, f, len });
      }
    }
    cands.sort((p, q) => p.cost - q.cost);
    const used = new Uint8Array(ends.length);
    const pairs = [];
    for (const c of cands) {
      if (used[c.i] || used[c.j]) continue;
      used[c.i] = used[c.j] = 1;
      pairs.push(c);
    }
    return pairs;
  };

  // How far an unpartnered cut-short end carries on. Behind an occluder:
  // part way across it, never so far that the cap would show on the wall
  // beyond. Past the frame: as far as the letter's other strokes reach in
  // that direction, and at least a cap's worth.
  C.extensionOf = function (end, at, genuine) {
    const r = end.r, sw = end.sw;
    if (end.status === 'frame') {
      let E = r;
      for (const o of genuine) {
        if (o.dx * end.dx + o.dy * end.dy < Math.cos((35 * Math.PI) / 180)) continue;
        const reach = (o.x - end.x) * end.dx + (o.y - end.y) * end.dy;
        if (reach > E) E = reach;
      }
      return Math.min(E, 4 * sw);
    }
    const maxLen = 3 * sw;
    let U = maxLen;
    for (let d = 1; d <= maxLen; d++) {
      const c = at(Math.round(end.x + end.dx * d), Math.round(end.y + end.dy * d));
      if (c === WALL) { U = d; break; }
    }
    return Math.max(0, Math.min((U - r) * 0.6, 1.5 * sw));
  };

  // ---------- bites ----------
  // Where something hides a stroke along its side (a sticker over its
  // edge, another color painted along it), the stroke shows narrower than
  // it is. Put the hidden side back out to the stroke's width, measured
  // from the edge that does show — only onto hidden ground, never over
  // visible wall. The width is the stroke's own (its wider stretches); a
  // stroke hidden along most of its length (all that shows is a sliver)
  // takes the letter's usual width. Works on `mask` (W×H) inside `box`;
  // returns the pixels to add (W×H) or null.
  C.restoreWidth = function (mask, W, H, at, box, rLetter, only) {
    const x0 = Math.max(0, box.x0), y0 = Math.max(0, box.y0), x1 = Math.min(W - 1, box.x1), y1 = Math.min(H - 1, box.y1);
    const bw = x1 - x0 + 3, bh = y1 - y0 + 3;
    if (bw < 8 || bh < 8) return null;
    const sub = new Uint8Array(bw * bh);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (mask[i] && (!only || only(i))) sub[(y - y0 + 1) * bw + (x - x0 + 1)] = 1;
    }
    const sw = R.strokeWidth(sub, bw, bh);
    if (!(sw >= 4)) return null;
    const graph = ST.extract.strokeGraph(sub, bw, bh, sw);
    const dt = R.distanceTransform(sub, bw, bh);
    const X = (p) => p % bw, Y = (p) => (p / bw) | 0;
    const inSub = (x, y) => x >= 0 && y >= 0 && x < bw && y < bh && sub[Math.round(y) * bw + Math.round(x)] === 1;
    // class just past the edge reached from (px, py) along (nx, ny)
    const edgeAndBeyond = (px, py, nx, ny, maxD) => {
      let d = 0;
      while (d < maxD && inSub(px + nx * (d + 0.5), py + ny * (d + 0.5))) d += 0.5;
      let hid = 0, n = 0;
      for (let k = 2; k <= 5; k++) {
        const c = at(Math.round(px + nx * (d + k)) + x0 - 1, Math.round(py + ny * (d + k)) + y0 - 1);
        n++;
        if (c === HIDDEN) hid++;
      }
      return { d, hidden: hid * 2 > n };
    };
    let add = null;
    for (const s of graph.segments) {
      const px = s.pixels, n = px.length;
      if (n < 6) continue;
      const vals = px.map((p) => dt[p]).sort((a, b) => a - b);
      const own = vals[Math.floor(vals.length * 0.75)];
      const k = Math.max(3, Math.round(0.5 * own));
      const plan = [];
      let bitten = 0;
      for (let i = 0; i < n; i++) {
        const a = px[Math.max(0, i - k)], b = px[Math.min(n - 1, i + k)];
        let tx = X(b) - X(a), ty = Y(b) - Y(a);
        const tl = Math.hypot(tx, ty);
        if (!tl) continue;
        tx /= tl; ty /= tl;
        const nx = -ty, ny = tx, cx = X(px[i]), cy = Y(px[i]);
        const A = edgeAndBeyond(cx, cy, nx, ny, 3 * own + 4), B = edgeAndBeyond(cx, cy, -nx, -ny, 3 * own + 4);
        if (A.hidden !== B.hidden) bitten++;
        plan.push({ cx, cy, nx, ny, A, B });
      }
      // hidden along most of its length: the letter's width, else its own
      const target = bitten >= 0.7 * plan.length ? Math.max(own, 0.9 * rLetter) : own;
      for (const q of plan) {
        const width = q.A.d + q.B.d;
        if (width >= 2 * target * 0.85) continue;
        let cx, cy;
        if (q.A.hidden && !q.B.hidden) { cx = q.cx - q.nx * q.B.d + q.nx * target; cy = q.cy - q.ny * q.B.d + q.ny * target; }
        else if (q.B.hidden && !q.A.hidden) { cx = q.cx + q.nx * q.A.d - q.nx * target; cy = q.cy + q.ny * q.A.d - q.ny * target; }
        else continue;
        // stamp, onto hidden ground only
        const r = target, rr = (r + 0.5) * (r + 0.5);
        const gx = cx + x0 - 1, gy = cy + y0 - 1;
        for (let yy = Math.max(0, Math.floor(gy - r)); yy <= Math.min(H - 1, Math.ceil(gy + r)); yy++) {
          for (let xx = Math.max(0, Math.floor(gx - r)); xx <= Math.min(W - 1, Math.ceil(gx + r)); xx++) {
            if ((xx - gx) * (xx - gx) + (yy - gy) * (yy - gy) > rr) continue;
            const i = yy * W + xx;
            if (mask[i] || at(xx, yy) !== HIDDEN) continue;
            if (!add) add = new Uint8Array(W * H);
            add[i] = 1;
          }
        }
      }
    }
    return add;
  };

  // A cut-short end with no partner may still run on, under what hides it,
  // into the side of another stroke of the letter (an N's stem hidden all
  // the way down to the N's bottom corner): the first ink straight ahead,
  // with nothing but hidden ground on the way — never visible wall.
  // (a small fan of rays: what shows of a hidden stroke may sit to one side
  // of its centerline and lean a few degrees)
  C.joinAhead = function (end, at, labels, W, H, sizeOk) {
    const maxLen = Math.round(4 * end.sw);
    let best = null;
    for (const off of [0, -0.5, 0.5]) {
      for (const deg of [0, -8, 8]) {
        const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const dx = end.dx * c - end.dy * s, dy = end.dx * s + end.dy * c;
        const ox = end.x - end.dy * off * end.r, oy = end.y + end.dx * off * end.r;
        for (let d = 2; d <= maxLen; d++) {
          const x = Math.round(ox + dx * d), y = Math.round(oy + dy * d);
          if (x < 0 || y < 0 || x >= W || y >= H) break;
          const L = labels[y * W + x];
          if (L && sizeOk(L) && (L !== end.comp || d > 2 * end.r)) {
            if (!best || d < best.d) best = { comp: L, d };
            break;
          }
          if (at(x, y) === WALL) break;
        }
      }
    }
    return best;
  };

  // ---------- drawing ----------
  function stampDisc(out, w, h, cx, cy, r) {
    const rr = (r + 0.5) * (r + 0.5);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rr) out[y * w + x] = 1;
    }
  }
  C.stampDisc = stampDisc;

  function stampCurve(out, w, h, ox, oy, f, len, r0, r1) {
    const n = Math.max(2, Math.ceil(len * 1.5));
    for (let i = 0; i <= n; i++) {
      const t = i / n, p = f(t);
      stampDisc(out, w, h, p.x + ox, p.y + oy, r0 + (r1 - r0) * t);
    }
  }

  /**
   * Complete the letter(s) in `mask` (W×H, photo coordinates).
   * opts: { at (class sampler, photo coords), seed: pixel index — keep only
   *   the piece holding it and what completion joins to it (else keep
   *   all) —, box: {x0,y0,x1,y1} to look for ends in, pad, minArea }
   * Returns { mask, tubes, P, W2, H2, pairs, extensions } — both masks
   * (W+2P)×(H+2P), photo pixel (x, y) at (x+P, y+P); `tubes` holds only
   * what completion drew.
   */
  C.complete = function (mask, W, H, opts) {
    const o = opts || {};
    const at = o.at;
    const P = o.pad != null ? o.pad : Math.round(0.15 * Math.max(W, H));
    const W2 = W + 2 * P, H2 = H + 2 * P;
    // strokes bitten along their side by what hides them get their width
    // back first, so their ends and directions read true
    let restored = null;
    if (!o.noRestore) {
      const first = R.components(mask, W, H);
      const nb = first.sizes.length;
      const fx0 = new Int32Array(nb).fill(W), fy0 = new Int32Array(nb).fill(H), fx1 = new Int32Array(nb).fill(-1), fy1 = new Int32Array(nb).fill(-1);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const L = first.labels[y * W + x];
        if (!L) continue;
        if (x < fx0[L]) fx0[L] = x; if (x > fx1[L]) fx1[L] = x;
        if (y < fy0[L]) fy0[L] = y; if (y > fy1[L]) fy1[L] = y;
      }
      const seedL0 = o.seed != null ? first.labels[o.seed] : 0;
      const rLetter = 0.5 * (o.letterWidth || R.strokeWidth(mask, W, H));
      const b0 = o.box || { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
      const minA = o.minArea || 200;
      for (let L = 1; L < nb; L++) {
        if (first.sizes[L] < minA && L !== seedL0) continue;
        if (fx1[L] < b0.x0 || fx0[L] > b0.x1 || fy1[L] < b0.y0 || fy0[L] > b0.y1) continue;
        const m = Math.round(3 * rLetter + 4);
        const add = C.restoreWidth(mask, W, H, at, { x0: fx0[L] - m, y0: fy0[L] - m, x1: fx1[L] + m, y1: fy1[L] + m }, rLetter, (i) => first.labels[i] === L);
        if (!add) continue;
        if (!restored) restored = new Uint8Array(W * H);
        for (let i = 0; i < add.length; i++) if (add[i]) restored[i] = 1;
      }
      if (restored) {
        const m2 = new Uint8Array(mask);
        for (let i = 0; i < m2.length; i++) if (restored[i]) m2[i] = 1;
        mask = m2;
      }
    }
    const { labels, sizes } = R.components(mask, W, H);
    const n = sizes.length;
    const bx0 = new Int32Array(n).fill(W), by0 = new Int32Array(n).fill(H), bx1 = new Int32Array(n).fill(-1), by1 = new Int32Array(n).fill(-1);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const L = labels[y * W + x];
        if (!L) continue;
        if (x < bx0[L]) bx0[L] = x; if (x > bx1[L]) bx1[L] = x;
        if (y < by0[L]) by0[L] = y; if (y > by1[L]) by1[L] = y;
      }
    }
    const minArea = o.minArea || 200;
    const seedL = o.seed != null ? labels[o.seed] : 0;
    const margin = o.margin || 0;
    const endsOf = new Map();
    const endsFor = (L) => {
      if (!endsOf.has(L)) {
        const found = C.strokeEnds(mask, W, H, { x0: bx0[L] - 2, y0: by0[L] - 2, x1: bx1[L] + 2, y1: by1[L] + 2 }, (i) => labels[i] === L);
        for (const e of found) { e.comp = L; e.status = C.probe(e, at); }
        endsOf.set(L, found);
      }
      return endsOf.get(L);
    };
    let box = o.box || { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
    let ends = [], pairs = [], joins = [];
    const keep = new Uint8Array(n);
    const sizeOk = (L) => sizes[L] >= minArea || L === seedL;
    // the pieces near the letter; when completion joins one that reaches
    // further, look around it too
    for (let iter = 0; iter < 6; iter++) {
      ends = [];
      for (let L = 1; L < n; L++) {
        if (sizes[L] < minArea && L !== seedL) continue;
        if (bx1[L] < box.x0 || bx0[L] > box.x1 || by1[L] < box.y0 || by0[L] > box.y1) continue;
        for (const e of endsFor(L)) ends.push(e);
      }
      pairs = C.pairEnds(ends, at);
      // unpartnered cut-short ends that run on into another piece
      const paired = new Uint8Array(ends.length);
      for (const p of pairs) paired[p.i] = paired[p.j] = 1;
      joins = [];
      ends.forEach((e, k) => {
        if (paired[k] || e.status !== 'hidden') return;
        const j = C.joinAhead(e, at, labels, W, H, sizeOk);
        if (j) joins.push({ k, comp: j.comp, d: j.d });
      });
      keep.fill(0);
      if (!seedL) { for (let L = 1; L < n; L++) keep[L] = 1; break; }
      keep[seedL] = 1;
      for (let changed = true; changed;) {
        changed = false;
        const link = (a, b) => { if (keep[a] !== keep[b]) { keep[a] = keep[b] = 1; changed = true; } };
        for (const p of pairs) link(ends[p.i].comp, ends[p.j].comp);
        for (const j of joins) link(ends[j.k].comp, j.comp);
      }
      let nb = { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 }, grew = false;
      for (let L = 1; L < n; L++) {
        if (!keep[L]) continue;
        const e = { x0: Math.max(0, bx0[L] - margin), y0: Math.max(0, by0[L] - margin), x1: Math.min(W - 1, bx1[L] + margin), y1: Math.min(H - 1, by1[L] + margin) };
        if (e.x0 < nb.x0) { nb.x0 = e.x0; grew = true; }
        if (e.y0 < nb.y0) { nb.y0 = e.y0; grew = true; }
        if (e.x1 > nb.x1) { nb.x1 = e.x1; grew = true; }
        if (e.y1 > nb.y1) { nb.y1 = e.y1; grew = true; }
      }
      if (!grew) break;
      box = nb;
    }
    const out = new Uint8Array(W2 * H2), tubes = new Uint8Array(W2 * H2);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, L = labels[i];
        if (L && keep[L]) {
          out[(y + P) * W2 + (x + P)] = 1;
          if (restored && restored[i]) tubes[(y + P) * W2 + (x + P)] = 1;
        }
      }
    }
    const used = new Uint8Array(ends.length);
    const drawn = [];
    for (const p of pairs) {
      const A = ends[p.i], B = ends[p.j];
      if (!keep[A.comp]) continue;
      used[p.i] = used[p.j] = 1;
      // start and finish a little inside the strokes so the seams are solid
      stampCurve(tubes, W2, H2, P, P, p.f, p.len, A.r, B.r);
      stampDisc(tubes, W2, H2, A.x - A.dx * A.r * 0.5 + P, A.y - A.dy * A.r * 0.5 + P, A.r);
      stampDisc(tubes, W2, H2, B.x - B.dx * B.r * 0.5 + P, B.y - B.dy * B.r * 0.5 + P, B.r);
      drawn.push({ a: { x: A.x, y: A.y }, b: { x: B.x, y: B.y }, r: [A.r, B.r], kind: A.status === 'frame' || B.status === 'frame' ? 'frame' : 'hidden' });
    }
    for (const j of joins) {
      const e = ends[j.k];
      if (!keep[e.comp]) continue;
      used[j.k] = 1;
      // on into the other stroke by half a width, so they fuse
      const s0 = { x: e.x - e.dx * e.r, y: e.y - e.dy * e.r };
      const s1 = { x: e.x + e.dx * (j.d + 0.5 * e.r), y: e.y + e.dy * (j.d + 0.5 * e.r) };
      stampCurve(tubes, W2, H2, P, P, (t) => ({ x: s0.x + (s1.x - s0.x) * t, y: s0.y + (s1.y - s0.y) * t }), Math.hypot(s1.x - s0.x, s1.y - s0.y), e.r, e.r);
      drawn.push({ a: { x: e.x, y: e.y }, b: { x: s1.x, y: s1.y }, r: [e.r, e.r], kind: 'join' });
    }
    const extensions = [];
    for (let k = 0; k < ends.length; k++) {
      const e = ends[k];
      if (used[k] || e.status === 'wall' || !keep[e.comp]) continue;
      const genuine = ends.filter((q) => q.comp === e.comp && q.status === 'wall');
      const E = C.extensionOf(e, at, genuine);
      if (E < 2) continue;
      // a capsule from inside the stroke to where the cap's center goes
      const s0 = { x: e.x - e.dx * e.r, y: e.y - e.dy * e.r };
      const s1 = { x: e.x + e.dx * (E - e.r), y: e.y + e.dy * (E - e.r) };
      const len = Math.hypot(s1.x - s0.x, s1.y - s0.y);
      if (E > e.r) stampCurve(tubes, W2, H2, P, P, (t) => ({ x: s0.x + (s1.x - s0.x) * t, y: s0.y + (s1.y - s0.y) * t }), len, e.r, e.r);
      else stampDisc(tubes, W2, H2, s1.x + P, s1.y + P, e.r);
      extensions.push({ at: { x: e.x, y: e.y }, dir: { x: e.dx, y: e.dy }, length: Math.round(E), kind: e.status });
    }
    for (let i = 0; i < out.length; i++) if (tubes[i]) out[i] = 1;
    const res = { mask: out, tubes, P, W2, H2, pairs: drawn, extensions, ends };
    if (C.debug) C.last = res;
    return res;
  };

  // ---------- 5. holes and outlines ----------
  // Holes in `mask` (w×h, at photo offset ox, oy) that show no wall are not
  // counters: a sticker on the stroke, a chip, a second color inside it.
  C.fillHiddenHoles = function (mask, w, h, at, ox, oy) {
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
    const { labels, sizes } = R.components(inv, w, h);
    const n = sizes.length;
    const border = new Uint8Array(n), wall = new Int32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const L = labels[y * w + x];
        if (!L) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border[L] = 1;
        if (at(x + ox, y + oy) === WALL) wall[L]++;
      }
    }
    const out = new Uint8Array(mask);
    let filled = 0;
    for (let i = 0; i < out.length; i++) {
      const L = labels[i];
      if (L && !border[L] && wall[L] < 0.25 * sizes[L]) { out[i] = 1; filled++; }
    }
    return filled ? out : mask;
  };

  // A throw-up's outline: a band of another color hugging the letter —
  // most of its inner edge runs along the letter (across the thin blend
  // between them), and it is thin next to the strokes. The outline round
  // the outside must wrap most of the letter (a drop shadow on one side is
  // not the letter's); a ring inside a counter only has to hug the counter.
  // It belongs to the letter, together with the blend between.
  // mask: w×h at photo offset (ox, oy); cls: photo classes (W×H).
  C.absorbOutline = function (mask, w, h, cls, W, H, ox, oy) {
    const sw = R.strokeWidth(mask, w, h);
    if (!(sw >= 4)) return { mask, counters: null };
    const GAP = 3.5;
    const hid = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + ox, py = y + oy;
        if (px >= 0 && py >= 0 && px < W && py < H && cls[py * W + px] === HIDDEN && !mask[y * w + x]) hid[y * w + x] = 1;
      }
    }
    const { labels, sizes } = R.components(hid, w, h);
    const n = sizes.length;
    if (n <= 1) return { mask, counters: null };
    // distance from the letter; which background pieces are the letter's holes
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
    const dl = R.distanceTransform(inv, w, h, { borderInk: true });
    const bgc = R.components(inv, w, h);
    const outerBg = new Uint8Array(bgc.sizes.length);
    for (let x = 0; x < w; x++) { outerBg[bgc.labels[x]] = 1; outerBg[bgc.labels[(h - 1) * w + x]] = 1; }
    for (let y = 0; y < h; y++) { outerBg[bgc.labels[y * w]] = 1; outerBg[bgc.labels[y * w + w - 1]] = 1; }
    const inHole = new Uint8Array(n), outside = new Uint8Array(n);
    const edge = new Int32Array(n), touch = new Int32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, L = labels[i];
        if (!L) continue;
        if (outerBg[bgc.labels[i]]) outside[L] = 1; else inHole[L] = 1;
        const onEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !hid[i - 1] || !hid[i + 1] || !hid[i - w] || !hid[i + w];
        if (!onEdge) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue; // the crop's edge says nothing
        edge[L]++;
        if (dl[i] <= GAP) touch[L]++;
      }
    }
    // how much of the letter's own edge each piece runs along
    let letterEdge = 0;
    const along = new Int32Array(n);
    const r = Math.ceil(GAP);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!mask[i] || (mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w])) continue;
        letterEdge++;
        const seen = new Set();
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w || dx * dx + dy * dy > GAP * GAP) continue;
            const L = labels[yy * w + xx];
            if (L && !seen.has(L)) { seen.add(L); along[L]++; }
          }
        }
      }
    }
    // the band's thickness next to the letter
    const dtH = R.distanceTransform(hid, w, h, { borderInk: true });
    const thick = new Float32Array(n);
    for (let i = 0; i < hid.length; i++) {
      const L = labels[i];
      if (L && dl[i] <= 0.8 * sw && dtH[i] > thick[L]) thick[L] = dtH[i];
    }
    const take = new Uint8Array(n);
    let any = false, maxBand = 0;
    for (let L = 1; L < n; L++) {
      if (!edge[L]) continue;
      const share = touch[L] / edge[L];
      const wraps = along[L] / Math.max(1, letterEdge);
      const band = 2 * thick[L];
      if (C.debug && sizes[L] > 200) (C.outlineDbg = C.outlineDbg || []).push({ L, size: sizes[L], share: +share.toFixed(2), wraps: +wraps.toFixed(2), band, sw: +sw.toFixed(1), inHole: !!inHole[L] && !outside[L] });
      if (share < 0.3 || band > 0.5 * sw || band < 2) continue;
      const enclosed = inHole[L] && !outside[L];
      if (!enclosed && wraps < 0.45) continue;
      take[L] = 1; any = true; maxBand = Math.max(maxBand, band);
    }
    if (!any) return { mask, counters: null };
    const out = new Uint8Array(mask);
    for (let i = 0; i < hid.length; i++) if (take[labels[i]] && dl[i] <= 2 * thick[labels[i]] + GAP + 1) out[i] = 1;
    // the blend between letter and outline
    const closed = R.close(out, w, h, Math.ceil(GAP));
    for (let i = 0; i < out.length; i++) if (closed[i] && !out[i] && dl[i] <= GAP + 1) out[i] = 1;
    // a hole ringed by an outline is a counter, however small next to the
    // strokes: the clean-up must not fill it
    const ringed = new Uint8Array(bgc.sizes.length);
    for (let i = 0; i < hid.length; i++) if (take[labels[i]] && !outerBg[bgc.labels[i]]) ringed[bgc.labels[i]] = 1;
    let counters = null;
    for (let i = 0; i < out.length; i++) {
      if (out[i] || !ringed[bgc.labels[i]]) continue;
      if (!counters) counters = new Uint8Array(w * h);
      counters[i] = 1;
    }
    return { mask: out, counters };
  };
})(typeof window !== 'undefined' ? window : globalThis);
