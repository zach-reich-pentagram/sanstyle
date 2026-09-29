/* Sanstyle — rectify.js
 * Flattening a photo taken at an angle. A wall shot from the side or from
 * below is foreshortened: its edges, a sign's border, a panel's seams, a
 * pole's sides — lines that are parallel on the wall — converge in the
 * photo, and every letter on it leans and tapers the same way. So:
 *
 *   1. straight line segments are found (a line-support-region detector:
 *      pixels of like gradient direction grown into long thin regions);
 *   2. the near-vertical ones and the near-horizontal ones each vote for a
 *      vanishing point (RANSAC, refined by least squares) — a point at
 *      infinity when they are parallel already;
 *   3. a homography sends the vanishing line to infinity (the lines come out
 *      parallel), then an affine map stands them upright and square.
 *
 * Only long lines count, and only a family of several of them agreeing,
 * spread across the photo — a letter's own stems (an A's legs meet at its
 * apex; an M's lean) never define the wall. A correction that would warp
 * the photo wildly is refused: the photo is then left as it is.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const RF = (ST.rectify = {});

  // ---------- 1. line segments ----------
  // gray (Float32, w×h) → [{x1, y1, x2, y2, len, ang}] (ang: the line's
  // direction, radians in [0, π))
  RF.segments = function (gray, w, h, opts) {
    const o = opts || {};
    const minLen = o.minLen || Math.max(20, 0.08 * Math.max(w, h));
    const n = w * h;
    const mag = new Float32Array(n), ang = new Float32Array(n);
    let sum = 0, cnt = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
        const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
        const m = Math.hypot(gx, gy);
        mag[i] = m;
        // the level line runs across the gradient; direction mod π
        let a = Math.atan2(gy, gx) + Math.PI / 2;
        a %= Math.PI; if (a < 0) a += Math.PI;
        ang[i] = a;
        sum += m; cnt++;
      }
    }
    // strong edges only: well above the photo's typical gradient
    const thr = Math.max(o.minMag || 24, 2.2 * (sum / Math.max(1, cnt)));
    const order = [];
    for (let i = 0; i < n; i++) if (mag[i] > thr) order.push(i);
    order.sort((a, b) => mag[b] - mag[a]);
    const used = new Uint8Array(n);
    const tol = (o.angTol || 22.5) * Math.PI / 180;
    const segs = [];
    const region = [];
    const angDiff = (a, b) => { let d = Math.abs(a - b) % Math.PI; return d > Math.PI / 2 ? Math.PI - d : d; };
    for (const seed of order) {
      if (used[seed]) continue;
      region.length = 0;
      region.push(seed); used[seed] = 1;
      // the region's direction as a doubled-angle mean (so 0 and π agree)
      let cx2 = Math.cos(2 * ang[seed]), sy2 = Math.sin(2 * ang[seed]);
      let ra = ang[seed];
      for (let k = 0; k < region.length && region.length < 20000; k++) {
        const p = region[k], px = p % w, py = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const qx = px + dx, qy = py + dy;
            if (qx < 1 || qy < 1 || qx >= w - 1 || qy >= h - 1) continue;
            const q = qy * w + qx;
            if (used[q] || mag[q] <= thr * 0.6 || angDiff(ang[q], ra) > tol) continue;
            used[q] = 1; region.push(q);
            cx2 += Math.cos(2 * ang[q]); sy2 += Math.sin(2 * ang[q]);
            ra = Math.atan2(sy2, cx2) / 2; if (ra < 0) ra += Math.PI;
          }
        }
      }
      if (region.length < minLen * 0.8) continue;
      // principal axis of the region
      let mx = 0, my = 0, W = 0;
      for (const p of region) { const m = mag[p]; mx += (p % w) * m; my += ((p / w) | 0) * m; W += m; }
      mx /= W; my /= W;
      let sxx = 0, syy = 0, sxy = 0;
      for (const p of region) {
        const m = mag[p], dx = (p % w) - mx, dy = ((p / w) | 0) - my;
        sxx += m * dx * dx; syy += m * dy * dy; sxy += m * dx * dy;
      }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const ux = Math.cos(th), uy = Math.sin(th);
      let t0 = Infinity, t1 = -Infinity, wd = 0;
      for (const p of region) {
        const dx = (p % w) - mx, dy = ((p / w) | 0) - my;
        const t = dx * ux + dy * uy;
        if (t < t0) t0 = t; if (t > t1) t1 = t;
        wd = Math.max(wd, Math.abs(-dx * uy + dy * ux));
      }
      const len = t1 - t0;
      if (len < minLen || wd > Math.max(3, 0.06 * len)) continue;
      let a = th % Math.PI; if (a < 0) a += Math.PI;
      segs.push({ x1: mx + ux * t0, y1: my + uy * t0, x2: mx + ux * t1, y2: my + uy * t1, len, ang: a });
    }
    return segs;
  };

  // ---------- 2. vanishing points ----------
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const lineOf = (s, cx, cy) => {
    const l = cross([s.x1 - cx, s.y1 - cy, 1], [s.x2 - cx, s.y2 - cy, 1]);
    const k = Math.hypot(l[0], l[1]) || 1;
    return [l[0] / k, l[1] / k, l[2] / k];
  };
  // how far (radians) a segment's direction is from pointing at vanishing
  // point v (homogeneous, centered coordinates)
  function misfit(s, v, cx, cy) {
    const mx = (s.x1 + s.x2) / 2 - cx, my = (s.y1 + s.y2) / 2 - cy;
    let dx, dy;
    if (Math.abs(v[2]) < 1e-9) { dx = v[0]; dy = v[1]; } else { dx = v[0] / v[2] - mx; dy = v[1] / v[2] - my; }
    const sx = s.x2 - s.x1, sy = s.y2 - s.y1;
    const c = Math.abs(dx * sx + dy * sy) / ((Math.hypot(dx, dy) * Math.hypot(sx, sy)) || 1);
    return Math.acos(Math.min(1, c));
  }
  // smallest-eigenvector of Σ w l lᵀ: the point closest to every line
  function refine(lines, ws) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    lines.forEach((l, k) => { for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += ws[k] * l[i] * l[j]; });
    // inverse iteration on the 3×3 symmetric matrix
    let v = [0.3, 0.3, 0.9];
    const A = M.map((r, i) => r.map((x, j) => x + (i === j ? 1e-9 : 0)));
    const solve = (b) => {
      const m = A.map((r, i) => r.concat([b[i]]));
      for (let i = 0; i < 3; i++) {
        let p = i;
        for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
        [m[i], m[p]] = [m[p], m[i]];
        if (Math.abs(m[i][i]) < 1e-15) return null;
        for (let k = i + 1; k < 3; k++) { const f = m[k][i] / m[i][i]; for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j]; }
      }
      const x = [0, 0, 0];
      for (let i = 2; i >= 0; i--) { let s = m[i][3]; for (let j = i + 1; j < 3; j++) s -= m[i][j] * x[j]; x[i] = s / m[i][i]; }
      return x;
    };
    for (let it = 0; it < 30; it++) {
      const x = solve(v);
      if (!x) break;
      const k = Math.hypot(x[0], x[1], x[2]) || 1;
      v = [x[0] / k, x[1] / k, x[2] / k];
    }
    return v;
  }

  // One family of segments (near-vertical or near-horizontal) → its
  // vanishing point, or null when the family doesn't agree on one.
  RF.vanishing = function (segs, cx, cy, D) {
    if (segs.length < 2) return null;
    const lines = segs.map((s) => lineOf(s, cx, cy));
    const total = segs.reduce((a, s) => a + s.len, 0);
    const tol = (1.5 * Math.PI) / 180;
    let best = null;
    // every pair (few segments survive the length cut) proposes a point
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        let v = cross(lines[i], lines[j]);
        const k = Math.hypot(v[0], v[1], v[2]);
        if (!k) continue;
        v = [v[0] / k, v[1] / k, v[2] / k];
        let score = 0;
        for (let q = 0; q < segs.length; q++) if (misfit(segs[q], v, cx, cy) < tol) score += segs[q].len * segs[q].len;
        if (!best || score > best.score) best = { v, score };
      }
    }
    if (!best) return null;
    const inl = [], ws = [];
    segs.forEach((s, q) => { if (misfit(s, best.v, cx, cy) < 2 * tol) { inl.push(q); ws.push(s.len * s.len); } });
    if (inl.length < 2) return null;
    const v = refine(inl.map((q) => lines[q]), ws);
    const inLen = inl.reduce((a, q) => a + segs[q].len, 0);
    // the inliers must be spread across the photo, not the two edges of one
    // stroke: their offsets across the family's direction at the middle
    let lo = Infinity, hi = -Infinity;
    const dir = Math.abs(v[2]) < 1e-9 ? [v[0], v[1]] : null;
    for (const q of inl) {
      const s = segs[q];
      const mx = (s.x1 + s.x2) / 2 - cx, my = (s.y1 + s.y2) / 2 - cy;
      let dx, dy;
      if (dir) { dx = dir[0]; dy = dir[1]; } else { dx = v[0] / v[2] - mx; dy = v[1] / v[2] - my; }
      const L = Math.hypot(dx, dy) || 1;
      // perpendicular offset of the line from the photo's middle
      const off = (-mx * dy + my * dx) / L;
      lo = Math.min(lo, off); hi = Math.max(hi, off);
    }
    return { v, inliers: inl.length, len: inLen, share: inLen / total, spread: (hi - lo) / D };
  };

  // ---------- 3. the flattening map ----------
  const mul = (A, B) => A.map((r, i) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const apply = (Hm, x, y) => {
    const X = Hm[0][0] * x + Hm[0][1] * y + Hm[0][2], Y = Hm[1][0] * x + Hm[1][1] * y + Hm[1][2], Z = Hm[2][0] * x + Hm[2][1] * y + Hm[2][2];
    return [X / Z, Y / Z, Z];
  };
  RF.apply = apply;
  function inv3(m) {
    const [a, b, c] = m[0], [d, e, f] = m[1], [gg, hh, i] = m[2];
    const A = e * i - f * hh, B = -(d * i - f * gg), C = d * hh - e * gg;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) return null;
    return [
      [A / det, -(b * i - c * hh) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * gg) / det, -(a * f - c * d) / det],
      [C / det, -(a * hh - b * gg) / det, (a * e - b * d) / det],
    ];
  }
  RF.inv3 = inv3;

  /**
   * The flattening of a photo: rgba `data` (w×h) → { H (photo px → flat px),
   * W, H2 (the flat photo's size), lines: [the segments that decided it],
   * tilt (degrees the verticals were turned), keystone (how much the
   * perspective was undone: 0 none) } or null (nothing to straighten, or no
   * clear evidence of how).
   */
  RF.estimate = function (data, w, h, opts) {
    const exclude = opts && opts.exclude; // w×h: the letters' paint (their own edges never vote)
    // at a working size of ~640 px
    const s = Math.min(1, 640 / Math.max(w, h));
    const sw = Math.max(8, Math.round(w * s)), sh = Math.max(8, Math.round(h * s));
    const gray = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      const yy = Math.min(h - 1, Math.floor((y + 0.5) / s));
      for (let x = 0; x < sw; x++) {
        const xx = Math.min(w - 1, Math.floor((x + 0.5) / s));
        const p = (yy * w + xx) * 4;
        gray[y * sw + x] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      }
    }
    const D = Math.max(sw, sh);
    // long lines only: a wall's structure spans the photo; a letter's
    // strokes rarely do
    const all = RF.segments(ST.raster ? ST.raster.blur(gray, sw, sh, 1) : gray, sw, sh, { minLen: 0.14 * D });
    // and the wall's lines only: the edge of a painted stroke has a narrow
    // band of the stroke's color on one side (a few stroke widths at most)
    // and the wall on the other; a panel's edge, a pole's side, a sign's
    // border has broad surfaces on both. A thin line (a scratch, a marker
    // stroke) shows the same wall on both sides and the line's own color
    // between: it counts only when it runs across most of the photo.
    // (colors read off a lightly blurred copy at the working size: single
    // pixels of a textured wall or a grainy stroke differ too much to say)
    const R = ST.raster;
    const chan = [new Float32Array(sw * sh), new Float32Array(sw * sh), new Float32Array(sw * sh)];
    for (let y = 0; y < sh; y++) {
      const yy = Math.min(h - 1, Math.floor((y + 0.5) / s));
      for (let x = 0; x < sw; x++) {
        const p = (yy * w + Math.min(w - 1, Math.floor((x + 0.5) / s))) * 4;
        chan[0][y * sw + x] = data[p]; chan[1][y * sw + x] = data[p + 1]; chan[2][y * sw + x] = data[p + 2];
      }
    }
    const [cr, cg, cb] = chan.map((c) => (R ? R.blur(c, sw, sh, 2) : c));
    const px = (x, y) => Math.max(0, Math.min(sh - 1, Math.round(y))) * sw + Math.max(0, Math.min(sw - 1, Math.round(x)));
    const dist = (p, q) => (R ? R.colorDist(cr[p], cg[p], cb[p], cr[q], cg[q], cb[q])
      : Math.abs(cr[p] - cr[q]) + Math.abs(cg[p] - cg[q]) + Math.abs(cb[p] - cb[q]));
    // (a stroke's edge: across the line, out to a fat stroke's width, the
    // far part of one side looks like the other side again — the wall
    // beyond the stroke; down a thin stroke's middle both far sides are the
    // same wall, and the line itself isn't)
    const R2 = 0.14 * D;
    const structural = (q) => {
      const ux = (q.x2 - q.x1) / q.len, uy = (q.y2 - q.y1) / q.len, nx = -uy, ny = ux;
      let bands = 0;
      for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const bx = q.x1 + (q.x2 - q.x1) * t, by = q.y1 + (q.y2 - q.y1) * t;
        const at = (sd, d) => px(bx + nx * sd * d, by + ny * sd * d);
        const refs = [at(1, 3), at(-1, 3)];
        const gap = dist(refs[0], refs[1]);
        let band = false;
        if (gap > 40) {
          for (let k = 0; k < 2 && !band; k++) {
            const sd = k ? -1 : 1;
            let n = 0, o = 0;
            for (let d = 0.6 * R2; d <= R2; d += 2) { n++; if (dist(at(sd, d), refs[1 - k]) < Math.min(60, 0.6 * gap)) o++; }
            if (o >= 0.6 * n) band = true;
          }
        } else {
          // both sides alike at 3 px: inside a stroke, or on the wall by it
          const fa = at(1, 0.8 * R2), fb = at(-1, 0.8 * R2), c = px(bx, by);
          if (dist(fa, fb) < 60 && dist(fa, c) > 60) band = true;
        }
        if (band) bands++;
      }
      if (bands >= 3) return false;
      // on the letters' paint (a stroke's edge, a stroke's middle)
      if (exclude) {
        let on = 0;
        for (let k = 0; k <= 8; k++) {
          const x = Math.round((q.x1 + ((q.x2 - q.x1) * k) / 8) / s), y = Math.round((q.y1 + ((q.y2 - q.y1) * k) / 8) / s);
          if (x >= 0 && y >= 0 && x < w && y < h && exclude[y * w + x]) on++;
        }
        // (most of it: the edge of a rail or a panel runs right along the
        // tops of the letters painted up to it)
        if (on >= 5) return false;
      }
      return true;
    };
    const segs = all.filter(structural);
    if (RF.debug) RF.last = { all, segs, s };
    const cx = sw / 2, cy = sh / 2;
    const near = (a, target) => { let d = Math.abs(a - target) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d; };
    const lim = (32 * Math.PI) / 180;
    const vert = segs.filter((q) => near(q.ang, Math.PI / 2) < lim);
    const horz = segs.filter((q) => near(q.ang, 0) < lim);
    // a family counts when several long lines agree, spread over the photo,
    // with enough length between them — and its vanishing point lies well
    // outside the photo (or at infinity): nearer, and it is a letter's own
    // converging strokes, or perspective too steep to undo
    const judge = (fam) => {
      const vp = RF.vanishing(fam, cx, cy, D);
      if (!vp || vp.inliers < 2 || vp.len < 0.7 * D || vp.spread < 0.15) return null;
      if (Math.abs(vp.v[2]) > 1e-9) {
        const dist = Math.hypot(vp.v[0] / vp.v[2], vp.v[1] / vp.v[2]);
        if (dist < 1.1 * D) return null;
      }
      return vp;
    };
    const V = judge(vert), Hz = judge(horz);
    if (!V && !Hz) return null;
    // vanishing line → infinity (centered coordinates)
    let l = null;
    const fin = (vp) => vp && Math.abs(vp.v[2]) > 1e-9;
    if (V && Hz && (fin(V) || fin(Hz))) l = cross(V.v, Hz.v);
    else if (V && fin(V)) l = cross(V.v, [1, 0, 0]);
    else if (Hz && fin(Hz)) l = cross(Hz.v, [0, 1, 0]);
    let P = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    if (l && Math.abs(l[2]) > 1e-9) P = [[1, 0, 0], [0, 1, 0], [l[0] / l[2], l[1] / l[2], 1]];
    // the families' directions once the lines are parallel
    const dirOf = (vp) => {
      const q = [P[0][0] * vp.v[0] + P[0][1] * vp.v[1] + P[0][2] * vp.v[2], P[1][0] * vp.v[0] + P[1][1] * vp.v[1] + P[1][2] * vp.v[2], P[2][0] * vp.v[0] + P[2][1] * vp.v[1] + P[2][2] * vp.v[2]];
      let dx = q[0], dy = q[1];
      if (Math.abs(q[2]) > 1e-6 * Math.hypot(dx, dy)) {
        // not quite at infinity (one family only): its lines' own mean
        // direction after the map
        return null;
      }
      const L = Math.hypot(dx, dy) || 1;
      return [dx / L, dy / L];
    };
    const meanDir = (fam, want) => {
      let sx = 0, sy = 0;
      for (const q of fam) {
        const a = apply(P, q.x1 - cx, q.y1 - cy), b = apply(P, q.x2 - cx, q.y2 - cy);
        let dx = b[0] - a[0], dy = b[1] - a[1];
        if (dx * want[0] + dy * want[1] < 0) { dx = -dx; dy = -dy; }
        sx += dx; sy += dy;
      }
      const L = Math.hypot(sx, sy) || 1;
      return [sx / L, sy / L];
    };
    let dv = V ? dirOf(V) || meanDir(vert, [0, 1]) : null;
    let dh = Hz ? dirOf(Hz) || meanDir(horz, [1, 0]) : null;
    if (dv && dv[1] < 0) dv = [-dv[0], -dv[1]];
    if (dh && dh[0] < 0) dh = [-dh[0], -dh[1]];
    // affine: the verticals down, the horizontals across
    let A;
    if (dv && dh) {
      const det = dh[0] * dv[1] - dv[0] * dh[1];
      if (Math.abs(det) < 0.5) return null; // the two families nearly agree: no frame to square
      A = [[dv[1] / det, -dv[0] / det, 0], [-dh[1] / det, dh[0] / det, 0], [0, 0, 1]];
    } else if (dv) {
      const t = Math.atan2(dv[0], dv[1]); // turn so (dv) → (0, 1)
      A = [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
    } else {
      const t = -Math.atan2(dh[1], dh[0]);
      A = [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
    }
    // in photo pixels: center, map, and scale back to about the photo's size
    const T = [[1, 0, -w / 2], [0, 1, -h / 2], [0, 0, 1]];
    const Sd = [[s, 0, 0], [0, s, 0], [0, 0, 1]];
    const Su = [[1 / s, 0, 0], [0, 1 / s, 0], [0, 0, 1]];
    let Hm = mul(Su, mul(A, mul(P, mul(Sd, T))));
    // local scale at the middle stays 1
    const o = apply(Hm, w / 2, h / 2), ox = apply(Hm, w / 2 + 1, h / 2), oy = apply(Hm, w / 2, h / 2 + 1);
    const jac = Math.abs((ox[0] - o[0]) * (oy[1] - o[1]) - (ox[1] - o[1]) * (oy[0] - o[0]));
    const k = 1 / Math.sqrt(jac || 1);
    Hm = mul([[k, 0, 0], [0, k, 0], [0, 0, 1]], Hm);
    // how far the corners go, and how much the scale varies over the photo:
    // refused when wild
    const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => apply(Hm, x, y));
    if (corners.some((c) => !(c[2] > 0))) return null;
    const scaleAt = (x, y) => {
      const a = apply(Hm, x, y), bx = apply(Hm, x + 1, y), by = apply(Hm, x, y + 1);
      return Math.sqrt(Math.abs((bx[0] - a[0]) * (by[1] - a[1]) - (bx[1] - a[1]) * (by[0] - a[0])));
    };
    const scales = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => scaleAt(x, y));
    const smin = Math.min(...scales), smax = Math.max(...scales);
    if (smax / smin > 2.2) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of corners) { x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]); x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]); }
    // shifted to the output's origin
    Hm = mul([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], Hm);
    let W2 = Math.round(x1 - x0), H2 = Math.round(y1 - y0);
    if (W2 * H2 > 2.2 * w * h) return null;
    // how much it does: the verticals' turn, and the perspective undone
    const up = apply(Hm, w / 2, h / 2), dn = apply(Hm, w / 2, h / 2 + 50);
    const tilt = (Math.atan2(dn[0] - up[0], dn[1] - up[1]) * 180) / Math.PI;
    const keystone = smax / smin - 1;
    // not worth a resample
    const identityish = Math.abs(tilt) < 0.8 && keystone < 0.04 && Math.abs(W2 - w) < 0.02 * w && Math.abs(H2 - h) < 0.02 * h;
    if (identityish) return null;
    const lines = [];
    const addLines = (fam, vp) => { if (vp) for (const q of fam) if (misfit(q, vp.v, cx, cy) < (3 * Math.PI) / 180) lines.push({ x1: q.x1 / s, y1: q.y1 / s, x2: q.x2 / s, y2: q.y2 / s }); };
    addLines(vert, V); addLines(horz, Hz);
    return { H: Hm, W: W2, H2, lines, tilt: Math.round(tilt * 10) / 10, keystone: Math.round(keystone * 100) / 100, families: (V ? 1 : 0) + (Hz ? 1 : 0) };
  };

  // Resample a canvas through the flattening (bilinear), onto a canvas of
  // the flat size; `fill` ({r,g,b}) where the photo doesn't reach. The
  // result carries `_inPhoto` (1 where the photo covers it) — beyond it a
  // letter is finished past the frame, as at any edge.
  RF.warp = function (src, rect, fill) {
    const w = src.width, h = src.height;
    const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
    const Hi = inv3(rect.H);
    const W2 = rect.W, H2 = rect.H2;
    const out = ST.makeCanvas(W2, H2);
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(W2, H2);
    const od = img.data;
    const inPhoto = new Uint8Array(W2 * H2);
    const prev = src._inPhoto || null;
    const f = fill || { r: 128, g: 128, b: 128 };
    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        const Z = Hi[2][0] * x + Hi[2][1] * y + Hi[2][2];
        const sx = (Hi[0][0] * x + Hi[0][1] * y + Hi[0][2]) / Z, sy = (Hi[1][0] * x + Hi[1][1] * y + Hi[1][2]) / Z;
        const o = (y * W2 + x) * 4;
        if (!(sx >= 0 && sy >= 0 && sx <= w - 1 && sy <= h - 1)) {
          od[o] = f.r; od[o + 1] = f.g; od[o + 2] = f.b; od[o + 3] = 255;
          continue;
        }
        const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        const tx = sx - x0, ty = sy - y0;
        const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4, p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
        for (let c = 0; c < 3; c++) {
          od[o + c] = (sd[p00 + c] * (1 - tx) + sd[p10 + c] * tx) * (1 - ty) + (sd[p01 + c] * (1 - tx) + sd[p11 + c] * tx) * ty;
        }
        od[o + 3] = 255;
        inPhoto[y * W2 + x] = prev ? prev[Math.round(sy) * w + Math.round(sx)] : 1;
      }
    }
    ctx.putImageData(img, 0, 0);
    out._inPhoto = inPhoto;
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
