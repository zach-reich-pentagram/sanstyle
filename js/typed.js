/* Sanstyle — typed.js
 * Finding a letter you name. When the automatic pass can't pull a letter
 * out of a tangle — graffiti letters cross, overlap and run into each other
 * in the same paint — type the character you see, and it is looked for
 * the way you look for it: you know what an "A" is made of (two legs
 * meeting at the top, a bar across), and you see those strokes in the
 * paint, running on under the others where they cross.
 *
 *   1. the character's skeleton — its strokes as center lines — is taken
 *      from the character drawn in a few typefaces (templates);
 *   2. the template is fitted onto the paint's own center lines: moved,
 *      scaled, stretched and slanted until its strokes lie along strokes of
 *      the paint running the same way (a chamfer match that also compares
 *      directions, and that counts the paint's strokes left unexplained
 *      inside the letter's box against it);
 *   3. the letter is drawn stroke by stroke along the paint: where a
 *      template stroke runs along a stroke of the paint, the paint's own
 *      center line and width; where it crosses another letter's stroke (a
 *      junction, or ink running another way), the fitted template's line at
 *      the letter's own width, so the stroke goes on through the crossing
 *      as it would on its own; a stroke's free ends follow the paint on as
 *      far as it goes. A template stroke the painting doesn't have (an A
 *      drawn without its bar) is left out.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const TY = (ST.typed = {});

  // ---------- 1. templates ----------
  // A range of letter shapes, all without serifs (a serif's short stroke
  // is no part of a hand-drawn letter): a grotesque, a geometric sans
  // (single-storey a and g), a humanist sans and two hands.
  const FONTS = [
    '600 180px "Helvetica Neue", Helvetica, Arial, sans-serif',
    '500 180px Futura, "Century Gothic", "Avenir Next", sans-serif',
    '500 180px Verdana, "Gill Sans", "Trebuchet MS", sans-serif',
    '400 180px "Marker Felt", "Comic Sans MS", "Chalkboard SE", cursive',
    '400 180px "Bradley Hand", "Segoe Print", "Noteworthy", cursive',
  ];
  const tplCache = new Map();

  // → [{ w (width / height), strokes: [{ pts: [u, v, …] (height-normalized,
  //   centered), free: [start end free?, end free?] }], pts: Float32Array
  //   [u, v, tu, tv, stroke, …] samples } ] — one per distinct typeface
  TY.templates = function (ch) {
    if (tplCache.has(ch)) return tplCache.get(ch);
    const R = ST.raster, out = [], seen = [];
    const S = 260;
    for (const font of FONTS) {
      let c;
      try { c = ST.makeCanvas(S, S); } catch (e) { break; }
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, S, S);
      x.fillStyle = '#000'; x.font = font; x.textBaseline = 'alphabetic'; x.textAlign = 'center';
      x.fillText(ch, S / 2, 200);
      const d = x.getImageData(0, 0, S, S).data;
      const m = new Uint8Array(S * S);
      for (let i = 0; i < m.length; i++) m[i] = d[i * 4] < 128 ? 1 : 0;
      const bb = R.maskBounds(m, S, S);
      if (!bb || bb.h < 8) continue;
      // the same shapes twice (a font missing, its fallback drawn): once
      let dup = false;
      for (const o of seen) {
        let diff = 0, n = 0;
        for (let i = 0; i < m.length; i += 7) { if (m[i] || o[i]) { n++; if (m[i] !== o[i]) diff++; } }
        if (n && diff < 0.08 * n) { dup = true; break; }
      }
      if (dup) continue;
      seen.push(m);
      const sw = R.strokeWidth(m, S, S);
      const graph = ST.extract.strokeGraph(m, S, S, sw);
      if (!graph || !graph.segments.length) continue;
      const H = bb.h, cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
      const norm = (p) => [((p % S) - cx) / H, (((p / S) | 0) - cy) / H];
      const strokes = [];
      const pts = [];
      graph.segments.forEach((sg) => {
        const px = sg.pixels;
        if (px.length < 0.08 * H) return; // a spur the pruning left
        const poly = [];
        for (let k = 0; k < px.length; k += 2) poly.push(...norm(px[k]));
        if (px.length % 2 === 0) poly.push(...norm(px[px.length - 1]));
        const free = sg.ends.map((e) => e < 0 || !!graph.endpoint[e]);
        const si = strokes.length;
        strokes.push({ pts: poly, free });
        // samples every ~2% of the height, with their direction
        const n = poly.length / 2, step = Math.max(1, Math.round(0.02 * H / 2)), m2 = Math.max(1, Math.round(0.04 * H / 2));
        for (let k = 0; k < n; k += step) {
          const a = Math.max(0, k - m2), b = Math.min(n - 1, k + m2);
          let tu = poly[2 * b] - poly[2 * a], tv = poly[2 * b + 1] - poly[2 * a + 1];
          const L = Math.hypot(tu, tv) || 1;
          pts.push(poly[2 * k], poly[2 * k + 1], tu / L, tv / L, si);
        }
      });
      if (pts.length < 15) continue;
      out.push({ font, w: bb.w / H, strokes, pts: Float32Array.from(pts) });
    }
    tplCache.set(ch, out);
    return out;
  };

  // ---------- the paint's center lines ----------
  // mask (w×h) → { sw, skel, dS (distance to the center lines), near
  // (nearest center-line pixel), tx/ty (its direction; 0,0 at junctions),
  // dOut (distance to the paint), dIn (distance to the paint's edge),
  // samples (center-line pixels, thinned out) }
  function field(mask, w, h, swIn) {
    const R = ST.raster;
    const N = w * h;
    const sw = swIn || Math.max(2, R.strokeWidth(mask, w, h));
    const graph = ST.extract.strokeGraph(mask, w, h, sw);
    const skel = graph.skel;
    const tx = new Float32Array(N), ty = new Float32Array(N);
    const m = Math.max(2, Math.round(0.6 * sw));
    for (const sg of graph.segments) {
      const px = sg.pixels, n = px.length;
      for (let k = 0; k < n; k++) {
        const a = px[Math.max(0, k - m)], b = px[Math.min(n - 1, k + m)];
        let dx = (b % w) - (a % w), dy = ((b / w) | 0) - ((a / w) | 0);
        const L = Math.hypot(dx, dy);
        if (!L) continue;
        // (near a junction the direction is the junction's, not the stroke's)
        const nearJ = sg.ends.some((e, side) => e >= 0 && graph.junction[e] && (side ? n - 1 - k : k) < 0.7 * sw);
        if (nearJ) continue;
        tx[px[k]] = dx / L; ty[px[k]] = dy / L;
      }
    }
    const invS = new Uint8Array(N);
    for (let i = 0; i < N; i++) invS[i] = skel[i] ? 0 : 1;
    const dS = R.distanceTransform(invS, w, h, { borderInk: true });
    // the nearest center-line pixel, spread out from the lines
    const near = new Int32Array(N).fill(-1);
    const q = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let i = 0; i < N; i++) if (skel[i]) { near[i] = i; q[qt++] = i; }
    while (qh < qt) {
      const i = q[qh++], o = near[i], x = i % w;
      if (x > 0 && near[i - 1] < 0) { near[i - 1] = o; q[qt++] = i - 1; }
      if (x < w - 1 && near[i + 1] < 0) { near[i + 1] = o; q[qt++] = i + 1; }
      if (i >= w && near[i - w] < 0) { near[i - w] = o; q[qt++] = i - w; }
      if (i + w < N && near[i + w] < 0) { near[i + w] = o; q[qt++] = i + w; }
    }
    const inv = new Uint8Array(N);
    for (let i = 0; i < N; i++) inv[i] = mask[i] ? 0 : 1;
    const dOut = R.distanceTransform(inv, w, h, { borderInk: true });
    const dIn = R.distanceTransform(mask, w, h);
    const samples = [];
    let k = 0;
    for (let i = 0; i < N; i++) if (skel[i] && (k++ % 2 === 0)) samples.push(i);
    return { w, h, sw, skel, graph, dS, near, tx, ty, dOut, dIn, samples: Int32Array.from(samples) };
  }

  // ---------- 2. fitting ----------
  // A template's distance field, for one stretch a: how far (in units of
  // the letter's height) each point of its box lies from its strokes.
  function gridOf(t, a) {
    const key = Math.round(a * 20);
    t.grids = t.grids || new Map();
    if (t.grids.has(key)) return t.grids.get(key);
    const aa = key / 20, cs = 0.025;
    const u0 = -(t.w / 2 + 0.12), v0 = -0.62;
    const nu = Math.ceil((t.w + 0.24) / cs) + 1, nv = Math.ceil(1.24 / cs) + 1;
    const d = new Float32Array(nu * nv).fill(Infinity);
    const pts = t.pts;
    for (let j = 0; j < nv; j++) {
      const v = v0 + j * cs;
      for (let i = 0; i < nu; i++) {
        const u = u0 + i * cs;
        let best = Infinity;
        for (let k = 0; k < pts.length; k += 5) {
          const du = (pts[k] - u) * aa, dv = pts[k + 1] - v, dd = du * du + dv * dv;
          if (dd < best) best = dd;
        }
        d[j * nu + i] = Math.sqrt(best);
      }
    }
    const G = { d, u0, v0, cs, nu, nv };
    t.grids.set(key, G);
    return G;
  }

  // A placement is an affine map from the template's frame (height 1,
  // centered) onto the paint: M = [a, b, c, d, e, f], x = a u + b v + c,
  // y = d u + e v + f. The first pass sets it by center (cx, cy), height s,
  // stretch st (width = st · the template's own), slant k.
  const fromP = (P) => [P.s * P.a, P.s * P.k, P.cx, 0, P.s, P.cy];
  const heightOf = (M) => Math.hypot(M[1], M[4]);
  const widthOf = (M) => Math.hypot(M[0], M[3]);
  const mapper = (M) => (u, v) => [M[0] * u + M[1] * v + M[2], M[3] * u + M[4] * v + M[5]];

  // How badly a placement fits (0 perfect … 1 hopeless)
  // (`coarse`: the first pass's looser tolerance, growing with the letter —
  // its grid steps are a tenth of the letter, far more than a pen's width
  // for a big one, and a placement nearly right must count as nearly right)
  function cost(t, M, F, step, coarse) {
    const { w, h, sw } = F;
    const s = heightOf(M);
    const tau = coarse ? Math.max(0.9 * sw, 0.09 * s) : 0.9 * sw;
    const pts = t.pts;
    let sum = 0, n = 0;
    for (let k = 0; k < pts.length; k += 5 * step) {
      const u = pts[k], v = pts[k + 1];
      const x = Math.round(M[0] * u + M[1] * v + M[2]), y = Math.round(M[3] * u + M[4] * v + M[5]);
      n++;
      if (x < 0 || y < 0 || x >= w || y >= h) { sum += 1; continue; }
      const i = y * w + x;
      if (F.dOut[i] > Math.max(0.45 * sw, tau - 0.45 * sw)) { sum += 1; continue; } // off the paint
      const d = F.dS[i];
      let e = d >= tau ? 1 : d / tau;
      const j = F.near[i];
      if (j >= 0 && d < tau && (F.tx[j] || F.ty[j])) {
        // the stroke of the paint here runs the template's way
        const tu = pts[k + 2], tv = pts[k + 3];
        const bx = M[0] * tu + M[1] * tv, by = M[3] * tu + M[4] * tv;
        const L = Math.hypot(bx, by) || 1;
        const cos = Math.abs((bx * F.tx[j] + by * F.ty[j]) / L);
        e += 0.7 * (1 - cos) * (1 - e);
      }
      sum += e;
    }
    const fwd = sum / Math.max(1, n);
    // the paint's center lines inside the letter's box that the letter
    // doesn't explain (a neighbor's strokes crossing it are expected: a
    // little of this is fine)
    let inside = 0, bad = 0;
    const det = M[0] * M[4] - M[1] * M[3];
    if (Math.abs(det) > 1e-6) {
      const i00 = M[4] / det, i01 = -M[1] / det, i10 = -M[3] / det, i11 = M[0] / det;
      const Gd = gridOf(t, widthOf(M) / s);
      const half = 0.5 * t.w + 0.04, S = F.samples, lim = (1.2 * sw) / s;
      for (let q = 0; q < S.length; q += step) {
        const i = S[q], x = (i % w) - M[2], y = ((i / w) | 0) - M[5];
        const u = i00 * x + i01 * y, v = i10 * x + i11 * y;
        if (Math.abs(v) > 0.5 || Math.abs(u) > half) continue;
        inside++;
        const gi = Math.round((u - Gd.u0) / Gd.cs), gj = Math.round((v - Gd.v0) / Gd.cs);
        const dd = gi < 0 || gj < 0 || gi >= Gd.nu || gj >= Gd.nv ? Infinity : Gd.d[gj * Gd.nu + gi];
        if (dd > lim) bad++;
      }
    }
    const rev = inside ? bad / inside : 0;
    if (cost.parts) { cost.parts.fwd = fwd; cost.parts.rev = rev; }
    // too small to be a letter of this paint — or squeezed so narrow that
    // strokes meant to stand apart (an A's legs) fall onto one stroke of
    // the paint: two strokes closer than a pen's width can't be told apart
    const small = s < 3.2 * sw ? (3.2 * sw - s) / sw : 0;
    const wide = t.w * widthOf(M), need = Math.min(2.6 * sw, 0.8 * t.w * s);
    const narrow = wide < need ? (need - wide) / sw : 0;
    return fwd + 0.35 * rev + 0.15 * small + 0.3 * narrow;
  }

  function search(t, F, box, prior) {
    const { sw } = F;
    const bh = box.y1 - box.y0 + 1, bw = box.x1 - box.x0 + 1;
    const smin = Math.max(3.2 * sw, 0.18 * Math.max(bh, bw)), smax = Math.max(smin * 1.05, 1.05 * bh);
    const found = [];
    for (let s = smin; s <= smax; s *= 1.16) {
      // (graffiti letters come condensed and extended far past a typeface's)
      for (const a of [0.4, 0.55, 0.7, 0.85, 1, 1.2, 1.45, 1.75]) {
        for (const k of [-0.3, 0, 0.3]) {
          const hw = 0.5 * (t.w * a * s + Math.abs(k) * s);
          const stepP = Math.max(0.5 * sw, 0.12 * s);
          for (let cy = box.y0 + 0.4 * s; cy <= box.y1 - 0.4 * s + 1e-6; cy += stepP) {
            for (let cx = box.x0 + 0.8 * hw; cx <= box.x1 - 0.8 * hw + 1e-6; cx += stepP) {
              const M = fromP({ cx, cy, s, a, k });
              let e = cost(t, M, F, 3, true);
              if (prior) e += prior(M);
              found.push({ M, e });
            }
          }
        }
      }
    }
    found.sort((p, q) => p.e - q.e);
    // the best few distinct placements, locked on
    const picks = [];
    for (const f of found) {
      if (picks.length >= 10) break;
      const s = heightOf(f.M);
      if (picks.some((p) => Math.hypot(p.M[2] - f.M[2], p.M[5] - f.M[5]) < 0.3 * s && Math.abs(Math.log(heightOf(p.M) / s)) < 0.25)) continue;
      picks.push(f);
    }
    const refined = picks.map((f) => {
      const M = icp(t, F, f.M);
      return { M, e: cost(t, M, F, 1) + (prior ? prior(M) : 0) };
    });
    refined.sort((p, q) => p.e - q.e);
    return refined;
  }

  // Locking a placement on (iterative closest points): each template point
  // is matched to the nearest center line of the paint running its way,
  // within a reach that shrinks from a sixth of the letter to a pen's
  // width, and the affine map that best carries the points onto their
  // matches is solved for — held back by the placement it started from, so
  // a few matches can't fold it up.
  function icp(t, F, M0) {
    const { w, h, sw } = F;
    const pts = t.pts, X = (i) => i % w, Y = (i) => (i / w) | 0;
    let M = M0.slice();
    const s0 = heightOf(M0);
    for (let it = 0; it < 10; it++) {
      const s = heightOf(M);
      const reach = Math.max(0.9 * sw, 0.16 * s * (1 - it / 10));
      // normal equations for [a b c] and [d e f]
      const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], bx = [0, 0, 0], by = [0, 0, 0];
      let n = 0;
      const add = (u, v, tx, ty, wt) => {
        const f = [u, v, 1];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) A[r * 3 + c] += wt * f[r] * f[c];
          bx[r] += wt * f[r] * tx; by[r] += wt * f[r] * ty;
        }
      };
      for (let k = 0; k < pts.length; k += 5) {
        const u = pts[k], v = pts[k + 1];
        const x = M[0] * u + M[1] * v + M[2], y = M[3] * u + M[4] * v + M[5];
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        const i = yi * w + xi;
        if (F.dS[i] > reach) continue;
        const j = F.near[i];
        if (j < 0) continue;
        let wt = 1 - F.dS[i] / (reach + 1);
        if (F.tx[j] || F.ty[j]) {
          const ax = M[0] * pts[k + 2] + M[1] * pts[k + 3], ay = M[3] * pts[k + 2] + M[4] * pts[k + 3];
          const cos = Math.abs((ax * F.tx[j] + ay * F.ty[j]) / (Math.hypot(ax, ay) || 1));
          if (cos < 0.7) continue; // a stroke running another way
          // (along the stroke the match is loose: pulled across it, mostly)
          const tx = F.tx[j], ty = F.ty[j];
          const ex = X(j) - x, ey = Y(j) - y, along = ex * tx + ey * ty;
          add(u, v, x + ex - 0.7 * along * tx, y + ey - 0.7 * along * ty, wt);
        } else add(u, v, X(j), Y(j), 0.5 * wt); // a junction: any way
        n++;
      }
      if (n < 12) break;
      // held back by where it started: the template's box corners stay put
      // with a weight of a fifth of the matches
      const lam = 0.2 * n / 4;
      for (const [u, v] of [[-t.w / 2, -0.5], [t.w / 2, -0.5], [-t.w / 2, 0.5], [t.w / 2, 0.5]]) {
        add(u, v, M[0] * u + M[1] * v + M[2], M[3] * u + M[4] * v + M[5], lam);
      }
      const ra = solve3(A, bx), rb = solve3(A, by);
      if (!ra || !rb) break;
      const N2 = [ra[0], ra[1], ra[2], rb[0], rb[1], rb[2]];
      // folded, flipped or run off to nothing: stop where it was
      const det = N2[0] * N2[4] - N2[1] * N2[3], hs = heightOf(N2), ws = widthOf(N2);
      if (det <= 0 || hs < 0.5 * s0 || hs > 1.8 * s0 || ws / hs < 0.25 || ws / hs > 2.6) break;
      const shear = Math.abs(N2[0] * N2[1] + N2[3] * N2[4]) / (hs * ws);
      if (shear > 0.6) break;
      M = N2;
    }
    return M;
  }
  function solve3(A, b) {
    const m = [[A[0], A[1], A[2], b[0]], [A[3], A[4], A[5], b[1]], [A[6], A[7], A[8], b[2]]];
    for (let i = 0; i < 3; i++) {
      let p = i;
      for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
      [m[i], m[p]] = [m[p], m[i]];
      if (Math.abs(m[i][i]) < 1e-9) return null;
      for (let k = i + 1; k < 3; k++) { const f = m[k][i] / m[i][i]; for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j]; }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) { let v = m[i][3]; for (let j = i + 1; j < 3; j++) v -= m[i][j] * x[j]; x[i] = v / m[i][i]; }
    return x;
  }

  // ---------- 3. drawing the letter ----------
  // The template's strokes, placed, drawn along the paint.
  function draw(t, M, F, mask) {
    const { w, h, sw } = F, R = ST.raster;
    const map = mapper(M);
    const tau = 0.9 * sw;
    const out = new Uint8Array(w * h);
    const hidden = new Uint8Array(w * h); // drawn across what hides the stroke
    const bridged = (cx, cy, r) => {
      const rr = (r + 0.5) * (r + 0.5);
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rr) { out[y * w + x] = 1; hidden[y * w + x] = 1; }
        }
      }
    };
    const disc = (cx, cy, r) => {
      const rr = (r + 0.5) * (r + 0.5);
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rr) out[y * w + x] = 1;
        }
      }
    };
    // the letter's own half-width: where its strokes lie along the paint's
    const rs = [];
    const dirOf = (tu, tv) => {
      const bx = M[0] * tu + M[1] * tv, by = M[3] * tu + M[4] * tv, L = Math.hypot(bx, by) || 1;
      return [bx / L, by / L];
    };
    const agrees = (x, y, dx, dy) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return -1;
      const i = Math.round(y) * w + Math.round(x);
      if (F.dS[i] >= tau) return -1;
      const j = F.near[i];
      if (j < 0 || !(F.tx[j] || F.ty[j])) return -1;
      return Math.abs(dx * F.tx[j] + dy * F.ty[j]) > 0.85 ? j : -1;
    };
    // each stroke's samples: placed, and snapped onto the paint's center
    // line where that runs the same way
    const strokes = t.strokes.map((st) => {
      const poly = st.pts, n = poly.length / 2;
      const pts = [];
      for (let k = 0; k < n; k++) {
        const [x, y] = map(poly[2 * k], poly[2 * k + 1]);
        const a = Math.max(0, k - 2), b = Math.min(n - 1, k + 2);
        const [dx, dy] = dirOf(poly[2 * b] - poly[2 * a], poly[2 * b + 1] - poly[2 * a + 1]);
        const j = agrees(x, y, dx, dy);
        if (j >= 0) rs.push(F.dIn[j]);
        const i = Math.round(y) * w + Math.round(x);
        const onPaint = x >= 0 && y >= 0 && x < w && y < h && F.dOut[i] <= 0.35 * sw;
        pts.push({ x, y, dx, dy, j, onPaint });
      }
      return { st, pts };
    });
    rs.sort((a, b) => a - b);
    const r0 = rs.length ? rs[rs.length >> 1] : sw / 2;
    for (const S of strokes) {
      const pts = S.pts, n = pts.length;
      // a stroke the painting doesn't have (an A without its bar)
      const on = pts.filter((p) => p.onPaint).length;
      if (on < 0.5 * n) { S.skip = true; continue; }
      // the center line: the paint's own where it agrees, the template's
      // across crossings — shifted by the offset the paint's line had just
      // before, so the stroke carries on straight through
      const cxs = new Float32Array(n), cys = new Float32Array(n), rad = new Float32Array(n);
      // (the offset of the paint's line from the template's, where they run
      // together: its median over the stroke — the last one before a
      // crossing can be pulled aside by the crossing itself)
      const oxs = [], oys = [];
      for (const p of pts) if (p.j >= 0) { oxs.push((p.j % w) - p.x); oys.push(((p.j / w) | 0) - p.y); }
      oxs.sort((a, b) => a - b); oys.sort((a, b) => a - b);
      const ox = oxs.length ? oxs[oxs.length >> 1] : 0, oy = oys.length ? oys[oys.length >> 1] : 0;
      for (let k = 0; k < n; k++) {
        const p = pts[k];
        if (p.j >= 0) {
          cxs[k] = p.j % w; cys[k] = (p.j / w) | 0; rad[k] = Math.min(F.dIn[p.j], 1.25 * r0);
        } else {
          cxs[k] = p.x + ox; cys[k] = p.y + oy; rad[k] = r0;
        }
      }
      // (smoothed, so the switch between the two leaves no step)
      const m = Math.max(1, Math.round(r0 / 2));
      const sx2 = new Float32Array(n), sy2 = new Float32Array(n), sr2 = new Float32Array(n), onP = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        let sx = 0, sy = 0, sr = 0, c2 = 0;
        for (let q = Math.max(0, k - m); q <= Math.min(n - 1, k + m); q++) { sx += cxs[q]; sy += cys[q]; sr += rad[q]; c2++; }
        sx2[k] = sx / c2; sy2[k] = sy / c2; sr2[k] = sr / c2;
        const x = sx2[k], y = sy2[k], i = Math.round(y) * w + Math.round(x);
        onP[k] = x >= 0 && y >= 0 && x < w && y < h && F.dOut[i] <= 0.5 * sw ? 1 : 0;
      }
      // a short stretch without paint between two with it: the stroke runs
      // on under something that hides it there (another letter's stroke in
      // another color, a sticker, a chip) — drawn across, at the stroke's
      // width; a long one is a stroke the painting doesn't have
      const bridge = new Uint8Array(n);
      for (let k = 0; k < n;) {
        if (onP[k]) { k++; continue; }
        let e = k;
        while (e < n && !onP[e]) e++;
        if (k > 0 && e < n) {
          const len = Math.hypot(sx2[e] - sx2[k - 1], sy2[e] - sy2[k - 1]);
          if (len <= 2.5 * sw) for (let q = k; q < e; q++) bridge[q] = 1;
        }
        k = e;
      }
      for (let k = 0; k < n; k++) {
        if (onP[k]) disc(sx2[k], sy2[k], sr2[k]);
        else if (bridge[k]) { bridged(sx2[k], sy2[k], r0); }
      }
      S.cx = cxs; S.cy = cys;
    }
    // a stem's or a leg's ends run on along the paint as far as it goes
    // the same way (a leg to its foot, two legs up into their apex — where
    // the typeface's apex is flat, or its stroke stops short)
    const X = (i) => i % w, Y = (i) => (i / w) | 0;
    // is (x, y) on this stroke's own drawn line (not another's)?
    const isOwnStroke = (S, x, y, r) => {
      for (let k = 0; k < S.cx.length; k++) if ((S.cx[k] - x) ** 2 + (S.cy[k] - y) ** 2 <= (r + 1) * (r + 1)) return true;
      return false;
    };
    const strokeLen = (st) => { let L = 0; for (let q = 2; q < st.pts.length; q += 2) L += Math.hypot(st.pts[q] - st.pts[q - 2], st.pts[q + 1] - st.pts[q - 1]); return L; };
    for (const S of strokes) {
      if (S.skip) continue;
      const pts = S.pts, n = pts.length;
      // (a stem or a leg — not a bar's overshoot, a short tail: those end
      // where the typeface ends them, or they run on into a neighbor)
      if (strokeLen(S.st) < 0.3) continue;
      for (const side of [0, 1]) {
        // (a free end runs on to where the paint ends; an end where the
        // typeface's stroke meets another — a leg's top at a flat apex —
        // only until it reaches the letter's own ink)
        const free = S.st.free[side];
        const k0 = side ? n - 1 : 0, k1 = side ? Math.max(0, n - 4) : Math.min(n - 1, 3);
        let dx = S.cx[k0] - S.cx[k1], dy = S.cy[k0] - S.cy[k1];
        const L = Math.hypot(dx, dy);
        if (!L) continue;
        dx /= L; dy /= L;
        let x = S.cx[k0], y = S.cy[k0];
        const own = free ? null : Uint8Array.from(out);
        for (let step = 0; step < (free ? 3 * sw : 1.5 * sw); step++) {
          const nx = x + dx, ny = y + dy;
          const i = Math.round(ny) * w + Math.round(nx);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[i]) break;
          // (reached the letter's own ink: joined)
          if (own && step > 0.5 * r0 && own[i] && !isOwnStroke(S, nx, ny, r0)) break;
          // follow the paint's center line where it runs this way
          const j = F.dS[i] < tau ? F.near[i] : -1;
          if (j >= 0 && (F.tx[j] || F.ty[j])) {
            const cos = dx * F.tx[j] + dy * F.ty[j];
            if (Math.abs(cos) < 0.8) break; // it turns off: another stroke
            const s2 = cos < 0 ? -1 : 1;
            dx = 0.8 * dx + 0.2 * s2 * F.tx[j]; dy = 0.8 * dy + 0.2 * s2 * F.ty[j];
            const L2 = Math.hypot(dx, dy); dx /= L2; dy /= L2;
            x = nx + 0.3 * (X(j) - nx); y = ny + 0.3 * (Y(j) - ny);
            disc(x, y, Math.min(F.dIn[j], 1.25 * r0));
          } else if (F.dIn[i] > 0 && !(j >= 0 && F.graph.junction[j])) {
            x = nx; y = ny;
            disc(x, y, Math.min(F.dIn[i], r0));
          } else break; // the end of the paint, or a crossing: the stroke's end
        }
      }
    }
    // on the paint only (a pixel or two past its edge, never onto the wall)
    const near = R.dilate(mask, w, h, 1);
    for (let i = 0; i < out.length; i++) if (!near[i] && !hidden[i]) out[i] = 0;
    return { mask: out, r0, strokes: strokes.map((S) => !S.skip) };
  }

  // The shapes a character typed may take: both cases where they look
  // alike on a wall (an o, an s, a k, a y — a Y's shape often enough); an
  // R is not an r (an r is part of an R, and would be found in its place)
  const ALIKE = new Set('cosuvwxzky'.split(''));
  TY.cases = (ch) => (ALIKE.has(ch.toLowerCase()) ? Array.from(new Set([ch, ch.toUpperCase(), ch.toLowerCase()])) : [ch]);

  /**
   * Find the character `ch` in a shape of paint (mask w×h). opts.hint
   * ({x, y}, mask px): where you are looking (a click, the shape selected)
   * — placements there are preferred. → { mask (the letter, w×h), fit (0
   * perfect … 1 hopeless), P, font } or null.
   */
  TY.find = function (mask, w, h, ch, opts) {
    const o = opts || {};
    const R = ST.raster;
    const cases = TY.cases(ch);
    const tpls = [].concat(...cases.map((c) => TY.templates(c)));
    if (!tpls.length) return null;
    const bb = R.maskBounds(mask, w, h);
    if (!bb) return null;
    // the pen's width (a pocked stroke read with its pocks filled)
    const rib = R.strokeWidth(mask, w, h), sol = ST.extract.solidWidth(mask, w, h);
    const sw = rib < 0.5 * sol ? 0.9 * sol : rib;
    if (!(sw > 1.5)) return null;
    // searched at ~300 px on the long side
    const f = Math.max(1, Math.max(bb.w, bb.h) / 300);
    const sw2 = sw / f;
    const x0 = bb.x0, y0 = bb.y0;
    const W2 = Math.ceil(bb.w / f) + 2, H2 = Math.ceil(bb.h / f) + 2;
    const small = new Uint8Array(W2 * H2);
    for (let y = 0; y < bb.h; y++) {
      for (let x = 0; x < bb.w; x++) {
        if (!mask[(y + y0) * w + x + x0]) continue;
        small[(Math.floor(y / f) + 1) * W2 + Math.floor(x / f) + 1] = 1;
      }
    }
    const F = field(small, W2, H2, sw2);
    const box = { x0: 1, y0: 1, x1: W2 - 2, y1: H2 - 2 };
    const hint = o.hint ? { x: (o.hint.x - x0) / f + 1, y: (o.hint.y - y0) / f + 1 } : null;
    // (a letter under the place you are looking: a mild preference)
    // (how much: a click says it plainly; the middle of the photo is a guess)
    const hw = o.hintWeight != null ? o.hintWeight : 0.25;
    const prior = hint ? (M) => {
      const d = Math.hypot(M[2] - hint.x, M[5] - hint.y) / Math.max(W2, H2);
      return hw * Math.min(1, d * d * 4);
    } : null;
    const all = [];
    for (const t of tpls) for (const r of search(t, F, box, prior)) all.push(Object.assign(r, { t }));
    if (!all.length) return null;
    all.sort((p, q) => p.e - q.e);
    // the few best placements, each drawn and read: the one that reads
    // most as the character wins (a template sitting on part of a stroke
    // can fit as well as the whole letter does; it doesn't read as it)
    const Ff = field(mask, w, h, sw);
    const want = new Set(cases);
    const tried = [];
    // (the best few overall, and the best at each size — a quarter, half,
    // three quarters, the whole of the shape's height — so a big letter is
    // drawn and read even when small fits along one of its strokes fit as
    // well)
    const Hs = H2 - 2;
    const bands = [0, 0.35, 0.6, 0.85, Infinity];
    const pool = all.slice(0, 4);
    for (let b = 0; b < bands.length - 1; b++) {
      const r = all.find((q) => heightOf(q.M) / Hs >= bands[b] && heightOf(q.M) / Hs < bands[b + 1] && q.e < all[0].e + 0.25);
      if (r && pool.indexOf(r) < 0) pool.push(r);
    }
    for (const r of pool) {
      const M = r.M, s = heightOf(M);
      if (tried.some((q) => Math.hypot(q.M0[2] - M[2], q.M0[5] - M[5]) < 0.15 * s && Math.abs(Math.log(heightOf(q.M0) / s)) < 0.15)) continue;
      // at full size: the placement scaled back
      const Mf = [M[0] * f, M[1] * f, (M[2] - 1) * f + x0, M[3] * f, M[4] * f, (M[5] - 1) * f + y0];
      const drawn = draw(r.t, Mf, Ff, mask);
      if (!R.count(drawn.mask)) continue;
      let reads = 0, letterness = 0;
      if (ST.recognize && ST.recognize.ready()) {
        const cl = ST.recognize.classify(drawn.mask, w, h);
        letterness = cl.letterness;
        for (const x of cl.ranked) if (want.has(x.ch)) reads += x.p;
      }
      tried.push({ M0: M, M: Mf, e: r.e, t: r.t, drawn, reads, letterness, score: r.e - 0.5 * reads * letterness });
    }
    if (!tried.length) return null;
    tried.sort((p, q) => p.score - q.score);
    if (o.debug) o.debug.tried = tried.map((q) => { cost.parts = {}; cost(q.t, q.M0, F, 1); const pr = cost.parts; cost.parts = null; return { cx: Math.round(q.M[2]), cy: Math.round(q.M[5]), s: Math.round(heightOf(q.M)), a: +(widthOf(q.M) / heightOf(q.M)).toFixed(2), e: +q.e.toFixed(3), fwd: +pr.fwd.toFixed(3), rev: +pr.rev.toFixed(3), reads: +q.reads.toFixed(2), L: +q.letterness.toFixed(2), score: +q.score.toFixed(3) }; });
    const b = tried[0];
    return { mask: b.drawn.mask, fit: +b.e.toFixed(3), reads: +(b.reads * b.letterness).toFixed(3), score: b.score, M: b.M, font: b.t.font, strokes: b.drawn.strokes };
  };

  /**
   * Look for `ch` across a photo's shapes (each {crop, mask, w, h}, photo
   * px): `first` (the shape you are looking at — the one selected, or the
   * one your click traced) before the others, the shape under `hint`
   * ({x, y}, photo px) preferred. → a candidate for the review queue
   * ({crop, mask, w, h, paths, kind: 'typed', read, lean, fit}) or null.
   */
  TY.findIn = function (shapes, ch, opts) {
    const o = opts || {};
    const R = ST.raster;
    const t0 = Date.now();
    const list = [];
    const overlap = (a, b) => {
      const x0 = Math.max(a.crop.x, b.crop.x), y0 = Math.max(a.crop.y, b.crop.y);
      const x1 = Math.min(a.crop.x + a.w, b.crop.x + b.w), y1 = Math.min(a.crop.y + a.h, b.crop.y + b.h);
      if (x1 <= x0 || y1 <= y0) return 0;
      return ((x1 - x0) * (y1 - y0)) / Math.min(a.w * a.h, b.w * b.h);
    };
    const holds = (c, p) => {
      if (!p) return false;
      const x = Math.round(p.x - c.crop.x), y = Math.round(p.y - c.crop.y), r = 12;
      for (let yy = Math.max(0, y - r); yy <= Math.min(c.h - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(c.w - 1, x + r); xx++) if (c.mask[yy * c.w + xx]) return true;
      }
      return false;
    };
    if (o.first) list.push(o.first);
    const rest = (shapes || []).filter((c) => !(o.first && overlap(c, o.first) > 0.9 && Math.abs(Math.log((c.w * c.h) / (o.first.w * o.first.h))) < 0.2));
    rest.sort((a, b) => (holds(b, o.hint) - holds(a, o.hint)) || R.count(b.mask) - R.count(a.mask));
    for (const c of rest) if (list.length < (o.maxShapes || 5)) list.push(c);
    let best = null;
    for (const c of list) {
      const hint = o.hint ? { x: o.hint.x - c.crop.x, y: o.hint.y - c.crop.y } : null;
      const r = TY.find(c.mask, c.w, c.h, ch, { hint, hintWeight: o.hintWeight, debug: o.debug ? (o.debug[list.indexOf(c)] = {}) : null });
      if (!r) continue;
      // (the shape you are looking at, or under your click: a head start —
      // when what was found there reads as the character)
      const score = r.score - ((c === o.first || holds(c, o.hint)) && r.reads >= 0.4 ? 0.08 * ((o.hintWeight != null ? o.hintWeight : 0.25) / 0.25) : 0);
      if (!best || score < best.score) best = { c, r, score };
      // clear enough where you were looking: no need to look further
      if (best.r.reads >= 0.8 && best.c === list[0]) break;
      if (o.budgetMs && Date.now() - t0 > o.budgetMs) break;
    }
    if (!best) return null;
    const { c, r } = best;
    // cleaned (round caps where the paint was cut) and boxed to the letter
    const clean = ST.extract.cleanMask(r.mask, c.w, c.h, 4);
    const bb = R.maskBounds(clean, c.w, c.h);
    if (!bb) return null;
    const pad = 12;
    const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
    const x1 = Math.min(c.w, bb.x1 + 1 + pad), y1 = Math.min(c.h, bb.y1 + 1 + pad);
    const w = x1 - x0, h = y1 - y0, mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = clean[(y + y0) * c.w + x + x0];
    const paths = ST.trace.vectorize(mask, w, h, {});
    if (!paths.length) return null;
    const cl = ST.recognize && ST.recognize.ready() ? ST.recognize.classify(mask, w, h) : null;
    return {
      crop: { x: c.crop.x + x0, y: c.crop.y + y0, w, h }, mask, w, h, paths, kind: 'typed', typed: ch,
      read: cl ? { ranked: cl.ranked, letterness: cl.letterness } : null,
      lean: ST.letters ? ST.letters.lean(mask, w, h) : 0,
      fit: r.fit, reads: r.reads,
    };
  };

  // ---------- a letter you trace ----------
  // Drag along a letter's strokes and the paint under them is taken as
  // the letter: your strokes are its skeleton. Each is moved onto the
  // center line of the paint running your way and drawn at the paint's
  // own width; where another stroke crosses, it carries on through at the
  // letter's width; where you traced across something hiding it, it is
  // drawn across (never out onto bare wall); each end follows the paint a
  // little on (you needn't reach it exactly). Any letterform at all: no
  // typeface, no reading, is involved.

  // your drag, smoothed and evened out to a point every 2 px
  function resample(path) {
    const pts = [];
    for (let k = 0; k + 1 < path.length; k += 2) pts.push([path[k], path[k + 1]]);
    if (pts.length < 2) return null;
    // (a hand's tremor averaged away: a running mean over ~8 px of path)
    const even = [];
    let carry = 0;
    even.push(pts[0].slice());
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let d = 2 - carry;
      while (d <= L) { even.push([a[0] + ((b[0] - a[0]) * d) / L, a[1] + ((b[1] - a[1]) * d) / L]); d += 2; }
      carry = L - (d - 2);
    }
    const last = pts[pts.length - 1];
    if (Math.hypot(last[0] - even[even.length - 1][0], last[1] - even[even.length - 1][1]) > 0.5) even.push(last.slice());
    if (even.length < 3) return null;
    const m = 2, out = [];
    for (let k = 0; k < even.length; k++) {
      let sx = 0, sy = 0, c = 0;
      for (let q = Math.max(0, k - m); q <= Math.min(even.length - 1, k + m); q++) { sx += even[q][0]; sy += even[q][1]; c++; }
      out.push(sx / c, sy / c);
    }
    return out;
  }

  // The paint the strokes were traced over: the photo's paint that lies
  // under most of them (within a pen's reach of your line — a hand is not
  // exact), or — a thin marker tag no paint was read for — the pixels that
  // stand out as a line from what is round them. → { mask (box px), any
  // (every paint in the box: what can hide a stroke), from, line() (the
  // line reading, on demand) } or null
  function paintUnder(samples, src, box) {
    const { W, H } = src, R = ST.raster;
    const reach = Math.max(6, Math.round(0.012 * Math.max(W, H)));
    const cover = (has) => {
      let hit = 0, n = 0;
      for (let k = 0; k < samples.length; k += 6) {
        const x = Math.round(samples[k]), y = Math.round(samples[k + 1]);
        n++;
        let got = false;
        for (let yy = Math.max(0, y - reach); yy <= Math.min(H - 1, y + reach) && !got; yy += 2) {
          for (let xx = Math.max(0, x - reach); xx <= Math.min(W - 1, x + reach); xx += 2) if (has(yy * W + xx)) { got = true; break; }
        }
        if (got) hit++;
      }
      return n ? hit / n : 0;
    };
    let best = null, shapesU = null;
    const each = (src.paints || []).map((p) => ({ c: cover((i) => p[i]), full: p })).sort((a, b) => b.c - a.c);
    if (each.length) best = each[0];
    // (a paint read as two — its light and its shade, a line's core and its
    // edge — taken together, when the second lies under more of your line)
    for (let k = 1; best && k < each.length && best.c < 0.95; k++) {
      if (each[k].c < 0.2) break;
      const a = best.full, b = each[k].full;
      const c = cover((i) => a[i] || b[i]);
      if (c < best.c + 0.08) continue;
      const u = new Uint8Array(W * H);
      for (let i = 0; i < u.length; i++) u[i] = a[i] | b[i];
      best = { c, full: u };
    }
    // the shapes the photo's analysis made, when no one paint lies under
    // your strokes (not otherwise: they hold every color — a stroke of
    // another that crosses the letter too)
    if (src.shapes && src.shapes.length) {
      const u = new Uint8Array(W * H);
      for (const sh of src.shapes) {
        for (let y = 0; y < sh.h; y++) {
          const Y = y + sh.crop.y;
          if (Y < 0 || Y >= H) continue;
          for (let x = 0; x < sh.w; x++) { const X = x + sh.crop.x; if (X >= 0 && X < W && sh.mask[y * sh.w + x]) u[Y * W + X] = 1; }
        }
      }
      const c = cover((i) => u[i]);
      if (!best || (best.c < 0.55 && c > best.c + 0.1)) best = { c, full: u };
      shapesU = u;
    }
    const rw = box.x1 - box.x0, rh = box.y1 - box.y0;
    const crop = (full) => {
      const m = new Uint8Array(rw * rh);
      for (let y = 0; y < rh; y++) m.set(full.subarray((y + box.y0) * W + box.x0, (y + box.y0) * W + box.x0 + rw), y * rw);
      return m;
    };
    // (any paint at all in the box: what a stroke can run on under)
    const any = new Uint8Array(rw * rh);
    for (const full of (src.paints || []).concat(shapesU ? [shapesU] : [])) {
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (full[(y + box.y0) * W + x + box.x0]) any[y * rw + x] = 1;
    }
    const got = (m, from) => ({ mask: m, any, from: from || (best && best.full === shapesU ? 'shapes' : 'paint') + ' ' + (best ? best.c.toFixed(2) : '') });
    if (best && best.c >= 0.55) return Object.assign(got(crop(best.full)), { line: () => lineUnder(samples, src, box) });
    const m = lineUnder(samples, src, box);
    if (!m) return best ? got(crop(best.full)) : null;
    if (best && best.c > 0.3) { const b2 = crop(best.full); for (let i = 0; i < m.length; i++) if (b2[i]) m[i] = 1; }
    return got(m, 'line');
  }

  // A line on the wall under your strokes: brighter (or darker) than what
  // is round it — a marker tag no paint was read for, or read in bits.
  function lineUnder(samples, src, box) {
    const { W, H } = src, R = ST.raster;
    const rw = box.x1 - box.x0, rh = box.y1 - box.y0;
    if (!src.data) return null;
    const Lm = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const p = ((y + box.y0) * W + x + box.x0) * 4;
        Lm[y * rw + x] = 0.299 * src.data[p] + 0.587 * src.data[p + 1] + 0.114 * src.data[p + 2];
      }
    }
    const rr = Math.max(3, Math.round(0.012 * Math.max(W, H)));
    const op = R.maxFilter(R.minFilter(Lm, rw, rh, rr), rw, rh, rr), cl = R.minFilter(R.maxFilter(Lm, rw, rh, rr), rw, rh, rr);
    let sb = 0, sd = 0, n = 0;
    for (let k = 0; k < samples.length; k += 6) {
      const x = Math.round(samples[k]) - box.x0, y = Math.round(samples[k + 1]) - box.y0;
      if (x < 0 || y < 0 || x >= rw || y >= rh) continue;
      let b = 0, d = 0;
      for (let yy = Math.max(0, y - 4); yy <= Math.min(rh - 1, y + 4); yy++) for (let xx = Math.max(0, x - 4); xx <= Math.min(rw - 1, x + 4); xx++) {
        const i = yy * rw + xx; b = Math.max(b, Lm[i] - op[i]); d = Math.max(d, cl[i] - Lm[i]);
      }
      sb += b; sd += d; n++;
    }
    if (!n) return null;
    const bright = sb >= sd;
    const th = new Float32Array(rw * rh);
    for (let i = 0; i < th.length; i++) th[i] = bright ? Lm[i] - op[i] : cl[i] - Lm[i];
    const T = Math.max(12, (0.3 * (bright ? sb : sd)) / n);
    let m = new Uint8Array(rw * rh);
    for (let i = 0; i < m.length; i++) if (th[i] > T) m[i] = 1;
    return R.open(m, rw, rh, 1);
  }

  // Your line, moved onto the paint's center line: at each point of it,
  // how far across it (along its normal) the paint's line lies — chosen for
  // the whole line at once (one Viterbi pass), so it holds to the stroke you
  // meant through crossings and gaps, never jumping to a neighbor's.
  // p: [x0, y0, …] 2 px apart, box px; reach: how far off your line may be.
  // → { cx, cy (the center line), agree (on a line of paint running your
  // way: its center-line pixel, or -1) }
  function snapTrace(p, F, reach) {
    const { w, h, sw } = F;
    const n = p.length >> 1;
    const D = Math.max(2, Math.ceil(reach)), S = 2 * D + 1;
    const nx = new Float32Array(n), ny = new Float32Array(n), tx = new Float32Array(n), ty = new Float32Array(n);
    const win = Math.max(2, Math.round(sw / 4));
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - win), b = Math.min(n - 1, k + win);
      let dx = p[2 * b] - p[2 * a], dy = p[2 * b + 1] - p[2 * a + 1];
      const L = Math.hypot(dx, dy) || 1;
      tx[k] = dx / L; ty[k] = dy / L; nx[k] = -ty[k]; ny[k] = tx[k];
    }
    const half = Math.max(1.5, 0.5 * sw);
    const at = (k, d) => {
      const x = Math.round(p[2 * k] + d * nx[k]), y = Math.round(p[2 * k + 1] + d * ny[k]);
      return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x;
    };
    // what each place costs: on a line of paint running your way, little;
    // on one running across (another stroke), more than on none at all
    const unary = new Float32Array(n * S), agreeAt = new Int32Array(n * S).fill(-1);
    for (let k = 0; k < n; k++) {
      for (let s2 = 0; s2 < S; s2++) {
        const d = s2 - D, i = at(k, d);
        let c = 1;
        if (i >= 0 && F.dOut[i] === 0 && F.dS[i] < half) {
          const j = F.near[i];
          const hasDir = j >= 0 && (F.tx[j] || F.ty[j]);
          const cos = hasDir ? Math.abs(tx[k] * F.tx[j] + ty[k] * F.ty[j]) : 0.75;
          c = 0.5 * (F.dS[i] / half) + 1.6 * (1 - cos);
          if (hasDir && cos > 0.8) agreeAt[k * S + s2] = j;
        } else if (i < 0) c = 1.5;
        unary[k * S + s2] = c + 0.3 * Math.abs(d) / D;
      }
    }
    // (a step across per 2 px along: up to about 45°, and paid for)
    const J = 2, lam = 0.12;
    let prev = new Float32Array(S), cur = new Float32Array(S);
    const back = new Int16Array(n * S);
    for (let s2 = 0; s2 < S; s2++) prev[s2] = unary[s2];
    for (let k = 1; k < n; k++) {
      for (let s2 = 0; s2 < S; s2++) {
        let best = Infinity, arg = s2;
        for (let q = Math.max(0, s2 - J); q <= Math.min(S - 1, s2 + J); q++) {
          const v = prev[q] + lam * Math.abs(q - s2);
          if (v < best) { best = v; arg = q; }
        }
        cur[s2] = best + unary[k * S + s2];
        back[k * S + s2] = arg;
      }
      const t = prev; prev = cur; cur = t;
    }
    let sEnd = 0;
    for (let s2 = 1; s2 < S; s2++) if (prev[s2] < prev[sEnd]) sEnd = s2;
    const cx = new Float32Array(n), cy = new Float32Array(n), agree = new Int32Array(n);
    for (let k = n - 1, s2 = sEnd; k >= 0; k--) {
      const d = s2 - D;
      cx[k] = p[2 * k] + d * nx[k]; cy[k] = p[2 * k + 1] + d * ny[k];
      agree[k] = agreeAt[k * S + s2];
      if (k) s2 = back[k * S + s2];
    }
    return { cx, cy, agree };
  }

  // The letter your strokes trace: each drawn along the paint's center line
  // it snapped to, at the paint's own width; across a crossing (a stroke of
  // another color over it, a gap) at the letter's width, only where
  // something hides it — never out onto bare wall; each end run on along
  // the paint a little (you stopped short), never on into a neighbor.
  function drawTraced(paths, F, mask, any, reach) {
    const { w, h, sw } = F;
    const out = new Uint8Array(w * h), hidden = new Uint8Array(w * h);
    const disc = (cx, cy, r, into) => {
      const rr = (r + 0.5) * (r + 0.5);
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rr) { out[y * w + x] = 1; if (into) into[y * w + x] = 1; }
        }
      }
    };
    const snaps = paths.map((p) => snapTrace(p, F, reach));
    // the letter's half-width: where its strokes lie along the paint's
    const rs = [];
    for (const sn of snaps) for (const j of sn.agree) if (j >= 0) rs.push(F.dIn[j]);
    rs.sort((a, b) => a - b);
    const r0 = rs.length ? rs[rs.length >> 1] : sw / 2;
    const idx = (x, y) => { const X = Math.round(x), Y = Math.round(y); return X < 0 || Y < 0 || X >= w || Y >= h ? -1 : Y * w + X; };
    const lines = [];
    for (const sn of snaps) {
      const { cx, cy, agree } = sn, n = cx.length;
      const rad = new Float32Array(n), onP = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const i = idx(cx[k], cy[k]);
        onP[k] = i >= 0 && F.dOut[i] <= 1.5 ? 1 : 0;
        rad[k] = agree[k] >= 0 ? Math.min(F.dIn[agree[k]], 1.25 * r0) : r0;
      }
      // (smoothed, so switching between the paint's width and the letter's leaves no step)
      const m = Math.max(1, Math.round(r0 / 4));
      const r2 = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        let sr = 0, c = 0;
        for (let q = Math.max(0, k - m); q <= Math.min(n - 1, k + m); q++) { sr += rad[q]; c++; }
        r2[k] = sr / c;
      }
      let first = -1, last = -1;
      for (let k = 0; k < n; k++) if (onP[k]) { if (first < 0) first = k; last = k; }
      if (first < 0) {
        // a stroke hidden all along under another's paint: drawn where you
        // traced it, at the letter's width
        let covered = 0;
        for (let k = 0; k < n; k++) { const i = idx(cx[k], cy[k]); if (i >= 0 && any[i]) covered++; }
        if (covered >= 0.8 * n) for (let k = 0; k < n; k++) disc(cx[k], cy[k], r0, hidden);
        continue;
      }
      for (let k = first; k <= last;) {
        if (onP[k]) { disc(cx[k], cy[k], r2[k]); k++; continue; }
        // a stretch without this paint: drawn across where it is short
        // (straight, from where the paint left off to where it goes on), or
        // where other paint lies over it (the stroke runs on underneath)
        let e = k;
        while (e <= last && !onP[e]) e++;
        let covered = 0;
        for (let q = k; q < e; q++) { const i = idx(cx[q], cy[q]); if (i >= 0 && any[i]) covered++; }
        const ax = cx[k - 1], ay = cy[k - 1], len = Math.hypot(cx[e] - ax, cy[e] - ay);
        // (the stroke runs on straight across it: the way it went before, and
        // after — not from one stroke over to another)
        const way = (a, b) => { const L = Math.hypot(cx[b] - cx[a], cy[b] - cy[a]) || 1; return [(cx[b] - cx[a]) / L, (cy[b] - cy[a]) / L]; };
        const before = way(Math.max(first, k - 1 - 2 * m - 3), k - 1), after = way(e, Math.min(last, e + 2 * m + 3));
        const chord = len ? [(cx[e] - ax) / len, (cy[e] - ay) / len] : before;
        const straight = before[0] * chord[0] + before[1] * chord[1] > 0.8 && after[0] * chord[0] + after[1] * chord[1] > 0.8;
        if (len <= 2.5 * sw && straight) {
          const m2 = Math.max(1, Math.ceil(len / 2));
          for (let q = 1; q < m2; q++) disc(ax + ((cx[e] - ax) * q) / m2, ay + ((cy[e] - ay) * q) / m2, r0, hidden);
        } else if (covered >= 0.8 * (e - k)) for (let q = k; q < e; q++) disc(cx[q], cy[q], r0, hidden);
        k = e;
      }
      lines.push({ cx, cy, first, last });
    }
    // each end run on along the paint the way it goes, a little: to where
    // the paint ends, not on into what it meets
    for (const L of lines) {
      for (const side of [0, 1]) {
        const k0 = side ? L.last : L.first, k1 = side ? Math.max(L.first, L.last - 4) : Math.min(L.last, L.first + 4);
        let dx = L.cx[k0] - L.cx[k1], dy = L.cy[k0] - L.cy[k1];
        const len = Math.hypot(dx, dy);
        if (!len) continue;
        dx /= len; dy /= len;
        let x = L.cx[k0], y = L.cy[k0];
        for (let step = 0; step < 0.6 * sw; step++) {
          const i = idx(x + dx, y + dy);
          if (i < 0 || !mask[i]) break;
          x += dx; y += dy;
          const j = F.dS[i] < 0.5 * sw ? F.near[i] : -1;
          if (j >= 0 && F.graph.junction[j]) break; // a crossing: the stroke's end
          if (j >= 0 && (F.tx[j] || F.ty[j]) && Math.abs(dx * F.tx[j] + dy * F.ty[j]) < 0.8) break; // it turns off: another stroke
          disc(x, y, Math.min(Math.max(F.dIn[i], 1), r0));
        }
      }
    }
    // on the paint only (its pits and notches closed: a photo's paint is
    // read patchy at its edges, a faint line in bits), or across what hides it
    const rc = Math.max(1, Math.round(0.2 * sw));
    const within = rc > 0 ? ST.raster.close(mask, w, h, rc) : mask;
    for (let i = 0; i < out.length; i++) if (!within[i] && !hidden[i]) out[i] = 0;
    return { mask: out, r0 };
  }

  /**
   * The letter under strokes you traced. strokes: [[x0, y0, x1, y1, …], …]
   * in photo px; src: { W, H, paints (masks of the photo's paints, W×H),
   * shapes (the analysis's shapes), data (the photo's rgba, for a line no
   * paint was read for) }; opts.tol: how far off the paint your line may
   * run (photo px — a few pointer widths at the zoom you traced at).
   * → a candidate for the review queue ({crop, mask, w, h, paths, kind:
   * 'traced', read, lean}) or null.
   */
  TY.traceStrokes = function (strokes, src, opts) {
    const o = opts || {};
    const R = ST.raster;
    const { W, H } = src;
    const paths = strokes.map(resample).filter(Boolean);
    if (!paths.length) return null;
    // the strokes' box, with room for their ends to run on
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const samples = [];
    for (const p of paths) for (let k = 0; k < p.length; k += 2) {
      samples.push(p[k], p[k + 1]);
      x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); y0 = Math.min(y0, p[k + 1]); y1 = Math.max(y1, p[k + 1]);
    }
    const margin = Math.round(40 + 0.3 * Math.max(x1 - x0, y1 - y0));
    const box = { x0: Math.max(0, Math.floor(x0 - margin)), y0: Math.max(0, Math.floor(y0 - margin)), x1: Math.min(W, Math.ceil(x1 + margin)), y1: Math.min(H, Math.ceil(y1 + margin)) };
    const rw = box.x1 - box.x0, rh = box.y1 - box.y0;
    if (rw < 8 || rh < 8) return null;
    const got = paintUnder(samples, src, box);
    if (!got || !R.count(got.mask)) return null;
    const mask = got.mask;
    if (o.debug) Object.assign(o.debug, { box, mask, any: got.any, from: got.from });
    // the pen's width, read on the paint along your strokes (the widest the
    // paint gets near each point of your line, low in the spread of those —
    // not the width of whatever else lies in the box, or of a crossing)
    const dIn = R.distanceTransform(mask, rw, rh);
    const near = Math.max(6, Math.round(0.012 * Math.max(W, H)));
    const halfs = [];
    for (let k = 0; k < samples.length; k += 6) {
      const x = Math.round(samples[k]) - box.x0, y = Math.round(samples[k + 1]) - box.y0;
      let m = 0;
      for (let yy = Math.max(0, y - near); yy <= Math.min(rh - 1, y + near); yy++) {
        for (let xx = Math.max(0, x - near); xx <= Math.min(rw - 1, x + near); xx++) if (dIn[yy * rw + xx] > m) m = dIn[yy * rw + xx];
      }
      if (m > 0) halfs.push(m);
    }
    if (!halfs.length) return null;
    halfs.sort((a, b) => a - b);
    const sw = Math.max(3, 2 * halfs[Math.floor(0.35 * halfs.length)]);
    // (a thin line's paint is read in bits: the line itself, where it
    // stands out from the wall, fills them in)
    if (sw <= 16 && got.line) {
      const lm = got.line();
      if (lm) {
        // (less the rim it adds round the paint already read: a line's
        // soft edge is not its paint)
        const u = new Uint8Array(mask.length);
        for (let i = 0; i < u.length; i++) u[i] = mask[i] | lm[i];
        const core = R.erode(u, rw, rh, 1);
        for (let i = 0; i < mask.length; i++) if (lm[i] && core[i]) mask[i] = 1;
      }
    }
    const F = field(mask, rw, rh, sw);
    // your strokes, in the box's px, onto the paint (a hand is off by a
    // stroke's width, or by what a pointer's pixel spans zoomed out)
    const loc = paths.map((p) => p.map((v, k) => v - (k % 2 ? box.y0 : box.x0)));
    const reach = Math.max(1.5 * sw, 8, o.tol || 0);
    const drawn = drawTraced(loc, F, mask, got.any, reach);
    if (o.debug) Object.assign(o.debug, { sw, r0: drawn.r0, drawn: drawn.mask, rw, rh });
    if (!R.count(drawn.mask)) return null;
    // (drawn along your strokes it is smooth already: only pinholes filled
    // and specks dropped — a clean-up for raw paint would shave off a thin
    // stretch you traced)
    const clean = ST.extract.cleanMask(drawn.mask, rw, rh, 0);
    const bb = R.maskBounds(clean, rw, rh);
    if (!bb) return null;
    const pad = 12;
    const cx0 = Math.max(0, bb.x0 - pad), cy0 = Math.max(0, bb.y0 - pad);
    const cx1 = Math.min(rw, bb.x1 + 1 + pad), cy1 = Math.min(rh, bb.y1 + 1 + pad);
    const w = cx1 - cx0, h = cy1 - cy0, out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = clean[(y + cy0) * rw + x + cx0];
    const vec = ST.trace.vectorize(out, w, h, {});
    if (!vec.length) return null;
    const cl = ST.recognize && ST.recognize.ready() ? ST.recognize.classify(out, w, h) : null;
    return {
      crop: { x: box.x0 + cx0, y: box.y0 + cy0, w, h }, mask: out, w, h, paths: vec, kind: 'traced',
      read: cl ? { ranked: cl.ranked, letterness: cl.letterness } : null,
      lean: ST.letters ? ST.letters.lean(out, w, h) : 0,
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
