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

  function findCorners(pts, cornerRad) {
    const n = pts.length;
    const corners = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      const v1 = V.norm(V.sub(b, a)), v2 = V.norm(V.sub(c, b));
      const dot = ST.clamp(V.dot(v1, v2), -1, 1);
      if (Math.acos(dot) > cornerRad) corners.push(i);
    }
    return corners;
  }

  function centralTangent(pts, i) {
    const n = pts.length;
    return V.norm(V.sub(pts[(i + 1) % n], pts[(i + n - 1) % n]));
  }

  function fitLoop(pts, cornerRad, fitErr) {
    const n = pts.length;
    if (n < 3) return null;
    const corners = findCorners(pts, cornerRad);
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
        cubics.push(...ST.fitCubics(run, null, null, fitErr));
      }
    } else if (corners.length === 1) {
      // One corner: open the loop there, fit as a single run back to itself.
      const a = corners[0];
      const run = [];
      for (let k = 0; k <= n; k++) run.push(pts[(a + k) % n]);
      cubics.push(...ST.fitCubics(run, null, null, fitErr));
    } else {
      // Fully smooth loop: split at two far-apart points with G1 joins.
      const mid = Math.floor(n / 2);
      const t0 = centralTangent(pts, 0), tm = centralTangent(pts, mid);
      const runA = [], runB = [];
      for (let k = 0; k <= mid; k++) runA.push(pts[k]);
      for (let k = mid; k <= n; k++) runB.push(pts[k % n]);
      cubics.push(...ST.fitCubics(runA, t0, V.neg(tm), fitErr));
      cubics.push(...ST.fitCubics(runB, tm, V.neg(t0), fitErr));
    }
    return cubics.length ? cubics : null;
  }

  /**
   * Full vectorize: mask → [{cubics, area}]
   * opts: { minArea (px², drop specks), smoothIter, rdpEps, cornerDeg, fitErr }
   */
  trace.vectorize = function (mask, w, h, opts) {
    const o = Object.assign(
      { minArea: 26, minHoleArea: 22, smoothIter: 2, rdpEps: 1.2, cornerDeg: 62, fitErr: 1.6 },
      opts || {}
    );
    const loops = trace.maskToLoops(mask, w, h);
    const out = [];
    for (const loop of loops) {
      const area = V.signedArea(loop); // >0 outer, <0 hole (mask convention)
      if (area >= 0 && area < o.minArea) continue;
      if (area < 0 && -area < o.minHoleArea) continue;
      let pts = smoothClosed(loop, o.smoothIter);
      pts = V.rdpClosed(pts, o.rdpEps);
      if (pts.length < 3) continue;
      const cubics = fitLoop(pts, (o.cornerDeg * Math.PI) / 180, o.fitErr);
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
