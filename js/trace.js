/* SANSTYLE — trace.js
 * Binary mask → vector outlines.
 *
 * 1. Boundary extraction: every exposed pixel side becomes a directed edge
 *    (ink kept on a consistent side), edges are linked into closed loops.
 *    Outer boundaries come out with positive shoelace area, counters
 *    (holes) negative — orientation falls out of the edge convention.
 * 2. The 1px staircase is relaxed with neighbor averaging, simplified with
 *    RDP, split at corners, and each smooth run is least-squares fit with
 *    cubic Béziers (fitcurves.js). Corners stay sharp, curves get smooth.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const V = ST.geom;
  const trace = (ST.trace = {});

  // --- 1. Loop extraction ---------------------------------------------------
  trace.maskToLoops = function (mask, w, h) {
    // Directed edges over grid points (w+1)x(h+1).
    // dir: 0=+x 1=+y 2=-x 3=-y
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const edges = []; // {sx, sy, dir}
    const byStart = new Map(); // vertexId -> [edgeIdx...]
    const vid = (x, y) => y * (w + 1) + x;
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : mask[y * w + x];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (!at(x, y - 1)) edges.push({ sx: x, sy: y, dir: 0 });         // top
        if (!at(x + 1, y)) edges.push({ sx: x + 1, sy: y, dir: 1 });     // right
        if (!at(x, y + 1)) edges.push({ sx: x + 1, sy: y + 1, dir: 2 }); // bottom
        if (!at(x - 1, y)) edges.push({ sx: x, sy: y + 1, dir: 3 });     // left
      }
    }
    for (let i = 0; i < edges.length; i++) {
      const id = vid(edges[i].sx, edges[i].sy);
      let a = byStart.get(id);
      if (!a) byStart.set(id, (a = []));
      a.push(i);
    }

    const used = new Uint8Array(edges.length);
    const loops = [];
    for (let s = 0; s < edges.length; s++) {
      if (used[s]) continue;
      const pts = [];
      let e = edges[s];
      const startId = vid(e.sx, e.sy);
      let curDir = -1;
      let guard = edges.length + 4;
      let idx = s;
      while (guard-- > 0) {
        used[idx] = 1;
        e = edges[idx];
        // Collapse collinear runs: only record a vertex on direction change.
        if (e.dir !== curDir) {
          pts.push({ x: e.sx, y: e.sy });
          curDir = e.dir;
        }
        const ex = e.sx + DX[e.dir], ey = e.sy + DY[e.dir];
        const endId = vid(ex, ey);
        if (endId === startId) break;
        const cands = byStart.get(endId);
        // Prefer the sharpest right turn (keeps diagonally-touching blobs
        // as separate contours), then straight, then left.
        let nextIdx = -1;
        for (const pref of [(curDir + 1) & 3, curDir, (curDir + 3) & 3]) {
          if (!cands) break;
          for (const ci of cands) {
            if (!used[ci] && edges[ci].dir === pref) { nextIdx = ci; break; }
          }
          if (nextIdx >= 0) break;
        }
        if (nextIdx < 0) break; // shouldn't happen on well-formed boundaries
        idx = nextIdx;
      }
      if (pts.length >= 4) loops.push(pts);
    }
    return loops;
  };

  // --- 2. Loop → cubic Bézier contour ---------------------------------------
  // Uniform arc-length resampling — prerequisite for the box low-pass, whose
  // index window must correspond to a fixed arc distance.
  function resampleClosed(pts, step) {
    const n = pts.length;
    const out = [{ x: pts[0].x, y: pts[0].y }];
    let prev = pts[0], acc = 0;
    for (let i = 1; i <= n; i++) {
      const cur = pts[i % n];
      let d = V.dist(prev, cur);
      while (acc + d >= step && d > 1e-9) {
        const t = (step - acc) / d;
        const np = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
        out.push(np);
        prev = np;
        d = V.dist(prev, cur);
        acc = 0;
      }
      acc += d;
      prev = cur;
    }
    while (out.length > 3 && V.dist(out[0], out[out.length - 1]) < step * 0.5) out.pop();
    return out;
  }

  // Closed-loop box filter over ±radius indices (sliding sum, O(n) per pass).
  function boxSmoothClosed(pts, radius, passes) {
    let cur = pts;
    const n = pts.length;
    if (n < 2 * radius + 2) return cur;
    for (let p = 0; p < passes; p++) {
      const out = new Array(n);
      let sx = 0, sy = 0;
      const win = 2 * radius + 1;
      for (let k = -radius; k <= radius; k++) {
        const q = cur[(k + n) % n];
        sx += q.x; sy += q.y;
      }
      for (let i = 0; i < n; i++) {
        out[i] = { x: sx / win, y: sy / win };
        const drop = cur[(i - radius + n) % n];
        const add = cur[(i + radius + 1) % n];
        sx += add.x - drop.x;
        sy += add.y - drop.y;
      }
      cur = out;
    }
    return cur;
  }

  function smoothClosed(pts, iterations) {
    let cur = pts;
    for (let it = 0; it < iterations; it++) {
      const n = cur.length;
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = cur[(i + n - 1) % n], b = cur[i], c = cur[(i + 1) % n];
        out[i] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 };
      }
      cur = out;
    }
    return cur;
  }

  // The turn at index i: the angle between the chords reaching `span` of
  // arc back and forward (one noisy vertex can't fake a corner), and the
  // side it turns to.
  function turnAt(pts, i, span) {
    const n = pts.length;
    let back = (i + n - 1) % n, db = V.dist(pts[i], pts[back]);
    while (db < span && back !== i) {
      const nb = (back + n - 1) % n;
      if (nb === i) break;
      db += V.dist(pts[back], pts[nb]);
      back = nb;
    }
    let fwd = (i + 1) % n, df = V.dist(pts[i], pts[fwd]);
    while (df < span && fwd !== i) {
      const nf = (fwd + 1) % n;
      if (nf === i) break;
      df += V.dist(pts[fwd], pts[nf]);
      fwd = nf;
    }
    const v1 = V.norm(V.sub(pts[i], pts[back]));
    const v2 = V.norm(V.sub(pts[fwd], pts[i]));
    return { turn: Math.acos(ST.clamp(V.dot(v1, v2), -1, 1)), cross: v1.x * v2.y - v1.y * v2.x };
  }

  // Corner detection with support: directions are measured over minSpan of
  // arc on each side, and clusters of flagged vertices collapse to the
  // sharpest one. Concave turns (into the shape) may use their own, lower
  // threshold: where two strokes meet, the inside corner is always sharp.
  function findCorners(pts, cornerRad, minSpan, concaveRad, area) {
    const n = pts.length;
    const span = Math.max(3, minSpan || 3);
    const turns = new Float64Array(n);
    const flagged = [];
    for (let i = 0; i < n; i++) {
      const t = turnAt(pts, i, span);
      turns[i] = t.turn;
      const concave = area && t.cross * area < 0;
      const thr = concave && concaveRad != null ? concaveRad : cornerRad;
      if (t.turn > thr) flagged.push(i);
    }
    // collect maxima above threshold, suppressing neighbors within the span
    if (!flagged.length) return [];
    const corners = [];
    let cluster = [flagged[0]];
    const flush = () => {
      let best = cluster[0];
      for (const i of cluster) if (turns[i] > turns[best]) best = i;
      corners.push(best);
    };
    for (let k = 1; k < flagged.length; k++) {
      let gap = 0;
      for (let j = cluster[cluster.length - 1]; j !== flagged[k]; j = (j + 1) % n) {
        gap += V.dist(pts[j], pts[(j + 1) % n]);
      }
      if (gap <= span * 1.5) cluster.push(flagged[k]);
      else { flush(); cluster = [flagged[k]]; }
    }
    flush();
    // wrap-around: first and last cluster may be the same corner
    if (corners.length > 1) {
      let gap = 0;
      for (let j = corners[corners.length - 1]; j !== corners[0]; j = (j + 1) % n) {
        gap += V.dist(pts[j], pts[(j + 1) % n]);
      }
      if (gap <= span * 1.5) {
        if (turns[corners[0]] >= turns[corners[corners.length - 1]]) corners.pop();
        else corners.shift();
      }
    }
    return corners;
  }

  // Loop tangent at index i, measured across ±span of arc (noise guard).
  function centralTangent(pts, i, span) {
    const n = pts.length;
    let b = (i + n - 1) % n, db = V.dist(pts[i], pts[b]);
    let f = (i + 1) % n, df = V.dist(pts[i], pts[f]);
    while (db < span && b !== f) { const nb = (b + n - 1) % n; db += V.dist(pts[b], pts[nb]); b = nb; }
    while (df < span && f !== b) { const nf = (f + 1) % n; df += V.dist(pts[f], pts[nf]); f = nf; }
    return V.norm(V.sub(pts[f], pts[b]));
  }

  // From corner i, walk `dir` (±1) out of the curved region onto the
  // straight edge beyond it: the first point where the boundary runs
  // straight (small local turn over ±s0) for `straightLen` of arc. Returns
  // the tangent point and the edge's direction, pointing away from the
  // corner — or null when no straight edge shows up within maxWalk.
  function edgeBeyond(pts, i, dir, s0, maxWalk, straightLen) {
    const n = pts.length;
    const straight = (k) => turnAt(pts, k, s0).turn < 0.14; // ~8°
    let j = i, arc = 0;
    while (arc < maxWalk) {
      const nj = (j + dir + n) % n;
      arc += V.dist(pts[j], pts[nj]);
      j = nj;
      if (j === i || !straight(j)) continue;
      let k = j, len = 0, ok = true;
      while (len < straightLen) {
        const nk = (k + dir + n) % n;
        len += V.dist(pts[k], pts[nk]);
        k = nk;
        if (k === i || !straight(k)) { ok = false; break; }
      }
      if (!ok) continue;
      return { idx: j, p: pts[j], dir: V.norm(V.sub(pts[k], pts[j])) };
    }
    return null;
  }

  // Put the point back on the corners. Smoothing blunts every corner, and a
  // closing's fillet rounds inside corners off by up to several stroke
  // widths; but the two edges that meet there are straight, so where both
  // can be found the corner is their intersection. The curved stretch
  // between the tangent points is replaced by that vertex.
  function sharpenCorners(pts, corners, sw) {
    const n = pts.length;
    const s0 = Math.max(2.5, sw * 0.12);
    const maxWalk = 3.5 * sw, straightLen = Math.max(6, sw * 0.5);
    const fixes = [];
    for (const i of corners) {
      const back = edgeBeyond(pts, i, -1, s0, maxWalk, straightLen);
      const fwd = edgeBeyond(pts, i, 1, s0, maxWalk, straightLen);
      if (!back || !fwd) continue;
      const d1 = back.dir, d2 = fwd.dir;
      const den = d1.x * d2.y - d1.y * d2.x;
      const ang = Math.acos(ST.clamp(V.dot(d1, d2), -1, 1));
      if (Math.abs(den) < 1e-6 || ang < 0.3 || ang > 2.8) continue; // 17°..160° between the edges
      const dx = fwd.p.x - back.p.x, dy = fwd.p.y - back.p.y;
      const t = (dx * d2.y - dy * d2.x) / den;
      const vtx = { x: back.p.x + d1.x * t, y: back.p.y + d1.y * t };
      const u = (vtx.x - fwd.p.x) * d2.x + (vtx.y - fwd.p.y) * d2.y;
      if (t > 0 || u > 0) continue;                 // the edges must converge toward the corner
      if (V.dist(vtx, pts[i]) > maxWalk) continue;
      fixes.push({ i, back: back.idx, fwd: fwd.idx, vtx });
    }
    if (!fixes.length) return pts;
    // the stretch (back, fwd) of each fix is dropped and its vertex put in;
    // stretches may not overlap another fix
    const skip = new Uint8Array(n), insertAt = new Map();
    const marks = new Uint8Array(n);
    for (const f of fixes) { marks[f.i] = 1; marks[f.back] = 1; marks[f.fwd] = 1; }
    for (const f of fixes) {
      const range = [];
      let ok = true;
      for (let k = (f.back + 1) % n; k !== f.fwd; k = (k + 1) % n) {
        if ((marks[k] && k !== f.i) || skip[k]) { ok = false; break; }
        range.push(k);
        if (range.length > n) { ok = false; break; }
      }
      if (!ok) continue;
      for (const k of range) skip[k] = 1;
      insertAt.set(f.back, f.vtx);
    }
    if (!insertAt.size) return pts;
    const out = [];
    for (let k = 0; k < n; k++) {
      if (!skip[k]) out.push(pts[k]);
      if (insertAt.has(k)) out.push(insertAt.get(k));
    }
    return out.length >= 3 ? out : pts;
  }

  function fitLoop(pts, cornerRad, fitErr, cornerSpan, tanSpan, opts) {
    const o = opts || {};
    if (pts.length < 3) return null;
    const span = cornerSpan || 3;
    const tspan = tanSpan || span;
    let corners = findCorners(pts, cornerRad, span, o.concaveRad, o.area);
    if (o.sharpen && corners.length) {
      const sharpened = sharpenCorners(pts, corners, o.sw);
      if (sharpened !== pts) {
        pts = sharpened;
        corners = findCorners(pts, cornerRad, span, o.concaveRad, o.area);
      }
    }
    const n = pts.length;
    const cubics = [];
    if (corners.length >= 2) {
      for (let k = 0; k < corners.length; k++) {
        const a = corners[k], b = corners[(k + 1) % corners.length];
        const run = [];
        let i = a;
        while (true) {
          run.push(pts[i]);
          if (i === b && run.length > 1) break;
          i = (i + 1) % n;
          if (run.length > n + 1) break;
        }
        if (run.length < 2) continue;
        cubics.push(...ST.fitCubics(run, null, null, fitErr, tspan));
      }
    } else if (corners.length === 1) {
      // One corner: open the loop there, fit as a single run back to itself.
      const a = corners[0];
      const run = [];
      for (let k = 0; k <= n; k++) run.push(pts[(a + k) % n]);
      cubics.push(...ST.fitCubics(run, null, null, fitErr, tspan));
    } else {
      // Fully smooth loop: split at two far-apart points with G1 joins.
      const mid = Math.floor(n / 2);
      const t0 = centralTangent(pts, 0, tspan), tm = centralTangent(pts, mid, tspan);
      const runA = [], runB = [];
      for (let k = 0; k <= mid; k++) runA.push(pts[k]);
      for (let k = mid; k <= n; k++) runB.push(pts[k % n]);
      cubics.push(...ST.fitCubics(runA, t0, V.neg(tm), fitErr, tspan));
      cubics.push(...ST.fitCubics(runB, tm, V.neg(t0), fitErr, tspan));
    }
    return cubics.length ? cubics : null;
  }

  /**
   * Full vectorize: mask → [{cubics, area}]
   * opts: { minArea (px², drop specks), smoothIter, rdpEps, cornerDeg, fitErr,
   *         autoScale }
   * autoScale (default on) grows the smoothing tolerances with each contour's
   * size: photo-texture wobble on a 900px letterform is many pixels wide, so
   * fixed pixel tolerances tuned for small shapes leave big traces jagged.
   * Tolerances stay ~0.5–0.9% of the contour's long side; small shapes are
   * unaffected (the multiplier bottoms out at 1).
   */
  trace.vectorize = function (mask, w, h, opts) {
    const o = Object.assign(
      { minArea: 26, minHoleArea: 22, smoothIter: 2, rdpEps: 1.2, cornerDeg: 62, fitErr: 1.6, autoScale: true },
      opts || {}
    );
    const loops = trace.maskToLoops(mask, w, h);
    // the stroke width bounds every size-scaled tolerance below: a round
    // cap is only a half-stroke across, and a window or span wider than
    // that flattens it or reads it as a corner
    const sw = o.strokeWidth != null ? o.strokeWidth
      : (ST.raster && ST.raster.strokeWidth ? ST.raster.strokeWidth(mask, w, h) : 0);
    const out = [];
    for (const loop of loops) {
      const area = V.signedArea(loop); // >0 outer, <0 hole (mask convention)
      if (area >= 0 && area < o.minArea) continue;
      if (area < 0 && -area < o.minHoleArea) continue;
      let fitErr = o.fitErr;
      let cornerSpan = o.rdpEps * 2.5, tanSpan = o.rdpEps * 2.5;
      let pts;
      const bb = V.bounds(loop);
      const size = Math.max(bb.w, bb.h);
      if (o.autoScale && size > 260) {
        // Photo captures carry boundary wobble that scales with size and
        // sits at wavelengths (tens of px) that neither 1px vertex
        // averaging nor RDP can remove — coarse RDP even aliases it into
        // zigzags no fit tolerance survives. So: resample the boundary
        // uniformly, low-pass with a box window ~2% of the contour (two
        // passes), keep simplification fine, scale the fit tolerance
        // (~1% of size), and measure corners/tangents across a span so a
        // single vertex never dictates a split — each capped by the stroke
        // width so thin strokes keep their round ends.
        const step = Math.max(1.5, size * 0.004);
        let pp = resampleClosed(loop, step);
        let boxArc = size * 0.02;
        if (sw > 0) boxArc = Math.min(boxArc, sw * 0.3);
        const rad = Math.max(1, Math.round(boxArc / step));
        pp = boxSmoothClosed(pp, rad, 2);
        // The fitter gets the DENSE points. Simplifying first strips a
        // straight stretch down to its two ends, and a fit checked only at
        // two or three points can bow out by a third of the stretch with
        // nobody noticing; with a point every couple of pixels the error
        // check sees every bulge.
        pts = pp;
        fitErr = o.fitErr * Math.max(1, size * 0.0065);
        if (sw > 0) fitErr = Math.min(fitErr, Math.max(o.fitErr, sw * 0.1));
        cornerSpan = Math.max(cornerSpan, size * 0.02);
        tanSpan = Math.max(tanSpan, size * 0.045);
        if (sw > 0) {
          cornerSpan = Math.max(o.rdpEps * 2.5, Math.min(cornerSpan, sw * 0.35));
          tanSpan = Math.max(o.rdpEps * 2.5, Math.min(tanSpan, sw * 0.6));
        }
      } else {
        pts = smoothClosed(loop, o.smoothIter); // dense, for the same reason
      }
      if (pts.length < 3) continue;
      const big = o.autoScale && size > 260 && sw > 0;
      const cubics = fitLoop(pts, (o.cornerDeg * Math.PI) / 180, fitErr, cornerSpan, tanSpan, {
        area,
        sw,
        // inside corners of stroke unions are always sharp: flag them sooner
        concaveRad: big ? (50 * Math.PI) / 180 : undefined,
        sharpen: big,
      });
      if (cubics) out.push({ cubics, area });
    }
    return out;
  };

  // Flatten a set of contours for measuring (bounds, profiles).
  trace.flattenAll = function (contours, maxSeg) {
    return contours.map((c) => V.flattenContour(c.cubics || c, maxSeg || 5));
  };

  trace.boundsOf = function (contours) {
    let bb = null;
    for (const poly of trace.flattenAll(contours)) {
      const b = V.bounds(poly);
      if (!bb) bb = b;
      else {
        bb.x0 = Math.min(bb.x0, b.x0); bb.y0 = Math.min(bb.y0, b.y0);
        bb.x1 = Math.max(bb.x1, b.x1); bb.y1 = Math.max(bb.y1, b.y1);
      }
    }
    if (bb) { bb.w = bb.x1 - bb.x0; bb.h = bb.y1 - bb.y0; }
    return bb;
  };
})(typeof window !== 'undefined' ? window : globalThis);
