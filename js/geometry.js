/* SANSTYLE — geometry.js
 * 2D vector helpers, polygon utilities, Ramer-Douglas-Peucker simplification,
 * and the homography solve used for perspective flattening.
 * Points are plain {x, y} objects. Image space is y-down; font space is y-up.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const geom = (ST.geom = {});

  geom.add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
  geom.sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  geom.scale = (a, s) => ({ x: a.x * s, y: a.y * s });
  geom.dot = (a, b) => a.x * b.x + a.y * b.y;
  geom.cross = (a, b) => a.x * b.y - a.y * b.x;
  geom.len = (a) => Math.hypot(a.x, a.y);
  geom.dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  geom.norm = function (a) {
    const l = Math.hypot(a.x, a.y);
    return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
  };
  geom.neg = (a) => ({ x: -a.x, y: -a.y });

  // Shoelace signed area. Positive = counter-clockwise in y-up coords
  // (which is clockwise as drawn on a y-down canvas).
  geom.signedArea = function (pts) {
    let s = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  };

  geom.bounds = function (pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  };

  geom.pointInPoly = function (pt, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if ((yi > pt.y) !== (yj > pt.y) &&
          pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  // Perpendicular distance from point p to segment ab.
  geom.segDist = function (p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) return geom.dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };

  // Ramer-Douglas-Peucker on an open polyline (iterative, keeps endpoints).
  geom.rdp = function (pts, eps) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = geom.segDist(pts[i], pts[a], pts[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out;
  };

  // RDP for a closed loop: anchor at two far-apart vertices, simplify both arcs.
  geom.rdpClosed = function (pts, eps) {
    const n = pts.length;
    if (n < 4) return pts.slice();
    let far = 0, maxD = -1;
    for (let i = 1; i < n; i++) {
      const d = geom.dist(pts[0], pts[i]);
      if (d > maxD) { maxD = d; far = i; }
    }
    const a = pts.slice(0, far + 1);
    const b = pts.slice(far).concat([pts[0]]);
    const ra = geom.rdp(a, eps);
    const rb = geom.rdp(b, eps);
    // Drop duplicated join points (end of ra == start of rb, end of rb == start of ra).
    return ra.slice(0, -1).concat(rb.slice(0, -1));
  };

  // --- Homography -----------------------------------------------------------
  // Solve the 3x3 projective transform H mapping 4 source points to 4 dest
  // points (both arrays of {x,y}). Returns [h0..h7] with h8 = 1, or null when
  // the quad is degenerate.
  geom.homography = function (src, dst) {
    // 8 equations A * h = b
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i];
      const { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    // Gaussian elimination with partial pivoting.
    for (let c = 0; c < 8; c++) {
      let piv = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-10) return null;
      if (piv !== c) { [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]]; }
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        if (f === 0) continue;
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = new Array(8);
    for (let i = 0; i < 8; i++) h[i] = b[i] / A[i][i];
    return h;
  };

  geom.applyH = function (h, x, y) {
    const w = h[6] * x + h[7] * y + 1;
    return {
      x: (h[0] * x + h[1] * y + h[2]) / w,
      y: (h[3] * x + h[4] * y + h[5]) / w,
    };
  };

  // --- Cubic Bézier helpers -------------------------------------------------
  // A cubic is [p0, c1, c2, p3] of {x,y}.
  geom.cubicAt = function (cu, t) {
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return {
      x: a * cu[0].x + b * cu[1].x + c * cu[2].x + d * cu[3].x,
      y: a * cu[0].y + b * cu[1].y + c * cu[2].y + d * cu[3].y,
    };
  };

  geom.flattenCubic = function (cu, out, steps) {
    const n = Math.max(2, steps | 0);
    for (let i = 1; i <= n; i++) out.push(geom.cubicAt(cu, i / n));
  };

  // Flatten a closed contour of cubics into a polygon (starts at first anchor).
  geom.flattenContour = function (cubics, maxSeg) {
    const out = [{ x: cubics[0][0].x, y: cubics[0][0].y }];
    for (const cu of cubics) {
      const approxLen = geom.dist(cu[0], cu[1]) + geom.dist(cu[1], cu[2]) + geom.dist(cu[2], cu[3]);
      geom.flattenCubic(cu, out, Math.ceil(approxLen / (maxSeg || 6)) + 1);
    }
    // Last point duplicates the first for a closed contour; drop it.
    if (out.length > 1 && geom.dist(out[0], out[out.length - 1]) < 1e-6) out.pop();
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
