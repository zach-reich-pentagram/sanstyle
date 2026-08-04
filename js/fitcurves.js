/* SANSTYLE — fitcurves.js
 * Piecewise cubic Bézier fitting of digitized points, after Philip J.
 * Schneider ("An Algorithm for Automatically Fitting Digitized Curves",
 * Graphics Gems 1990). Least-squares fit with Newton-Raphson
 * reparameterization; splits at the max-error point when tolerance is missed.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const V = ST.geom;

  const B0 = (u) => { const t = 1 - u; return t * t * t; };
  const B1 = (u) => { const t = 1 - u; return 3 * u * t * t; };
  const B2 = (u) => { const t = 1 - u; return 3 * u * u * t; };
  const B3 = (u) => u * u * u;

  function chordLengthParameterize(pts, first, last) {
    const u = [0];
    for (let i = first + 1; i <= last; i++) {
      u.push(u[i - first - 1] + V.dist(pts[i], pts[i - 1]));
    }
    const total = u[u.length - 1] || 1;
    for (let i = 0; i < u.length; i++) u[i] /= total;
    return u;
  }

  function generateBezier(pts, first, last, uPrime, tHat1, tHat2) {
    const nPts = last - first + 1;
    const A = [];
    for (let i = 0; i < nPts; i++) {
      A.push([V.scale(tHat1, B1(uPrime[i])), V.scale(tHat2, B2(uPrime[i]))]);
    }
    const C = [[0, 0], [0, 0]];
    const X = [0, 0];
    const p0 = pts[first], p3 = pts[last];
    for (let i = 0; i < nPts; i++) {
      C[0][0] += V.dot(A[i][0], A[i][0]);
      C[0][1] += V.dot(A[i][0], A[i][1]);
      C[1][0] = C[0][1];
      C[1][1] += V.dot(A[i][1], A[i][1]);
      const u = uPrime[i];
      const tmp = V.sub(
        pts[first + i],
        V.add(
          V.scale(p0, B0(u) + B1(u)),
          V.scale(p3, B2(u) + B3(u))
        )
      );
      X[0] += V.dot(A[i][0], tmp);
      X[1] += V.dot(A[i][1], tmp);
    }
    const detC0C1 = C[0][0] * C[1][1] - C[1][0] * C[0][1];
    const detC0X = C[0][0] * X[1] - C[1][0] * X[0];
    const detXC1 = X[0] * C[1][1] - X[1] * C[0][1];
    let alphaL = detC0C1 === 0 ? 0 : detXC1 / detC0C1;
    let alphaR = detC0C1 === 0 ? 0 : detC0X / detC0C1;

    const segLength = V.dist(p0, p3);
    const epsilon = 1e-6 * segLength;
    if (alphaL < epsilon || alphaR < epsilon || !isFinite(alphaL) || !isFinite(alphaR)) {
      // Wu/Barsky heuristic fallback.
      const dist = segLength / 3;
      alphaL = alphaR = dist;
    }
    // Guard against wild control arms on noisy data.
    const maxAlpha = segLength * 2.5;
    if (alphaL > maxAlpha) alphaL = maxAlpha;
    if (alphaR > maxAlpha) alphaR = maxAlpha;

    return [
      p0,
      V.add(p0, V.scale(tHat1, alphaL)),
      V.add(p3, V.scale(tHat2, alphaR)),
      p3,
    ];
  }

  function computeMaxError(pts, first, last, bez, u) {
    let maxDist = 0;
    let splitPoint = (last - first + 1) >> 1;
    for (let i = first + 1; i < last; i++) {
      const p = V.cubicAt(bez, u[i - first]);
      const d = (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2;
      if (d >= maxDist) { maxDist = d; splitPoint = i; }
    }
    return { maxDist, splitPoint };
  }

  function newtonRaphsonRootFind(bez, p, u) {
    const d = V.sub(V.cubicAt(bez, u), p);
    // First and second derivative control nets.
    const q1 = [], q2 = [];
    for (let i = 0; i < 3; i++) {
      q1.push({ x: (bez[i + 1].x - bez[i].x) * 3, y: (bez[i + 1].y - bez[i].y) * 3 });
    }
    for (let i = 0; i < 2; i++) {
      q2.push({ x: (q1[i + 1].x - q1[i].x) * 2, y: (q1[i + 1].y - q1[i].y) * 2 });
    }
    const mt = 1 - u;
    const q1u = {
      x: mt * mt * q1[0].x + 2 * mt * u * q1[1].x + u * u * q1[2].x,
      y: mt * mt * q1[0].y + 2 * mt * u * q1[1].y + u * u * q1[2].y,
    };
    const q2u = { x: mt * q2[0].x + u * q2[1].x, y: mt * q2[0].y + u * q2[1].y };
    const numerator = d.x * q1u.x + d.y * q1u.y;
    const denominator = q1u.x * q1u.x + q1u.y * q1u.y + d.x * q2u.x + d.y * q2u.y;
    if (Math.abs(denominator) < 1e-12) return u;
    return u - numerator / denominator;
  }

  function reparameterize(pts, first, last, u, bez) {
    const out = [];
    for (let i = first; i <= last; i++) {
      let nu = newtonRaphsonRootFind(bez, pts[i], u[i - first]);
      if (!isFinite(nu)) nu = u[i - first];
      out.push(ST.clamp(nu, 0, 1));
    }
    return out;
  }

  function computeCenterTangent(pts, center) {
    const v1 = V.sub(pts[center - 1], pts[center]);
    const v2 = V.sub(pts[center], pts[center + 1]);
    return V.norm({ x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 });
  }

  function fitCubic(pts, first, last, tHat1, tHat2, errSq, out, depth) {
    const nPts = last - first + 1;
    if (nPts === 2) {
      const dist = V.dist(pts[first], pts[last]) / 3;
      out.push([
        pts[first],
        V.add(pts[first], V.scale(tHat1, dist)),
        V.add(pts[last], V.scale(tHat2, dist)),
        pts[last],
      ]);
      return;
    }
    let u = chordLengthParameterize(pts, first, last);
    let bez = generateBezier(pts, first, last, u, tHat1, tHat2);
    let { maxDist, splitPoint } = computeMaxError(pts, first, last, bez, u);
    if (maxDist < errSq) { out.push(bez); return; }

    if (maxDist < errSq * 16) {
      for (let i = 0; i < 5; i++) {
        u = reparameterize(pts, first, last, u, bez);
        bez = generateBezier(pts, first, last, u, tHat1, tHat2);
        const r = computeMaxError(pts, first, last, bez, u);
        maxDist = r.maxDist; splitPoint = r.splitPoint;
        if (maxDist < errSq) { out.push(bez); return; }
      }
    }

    if (depth > 24 || splitPoint <= first || splitPoint >= last) {
      out.push(bez);
      return;
    }
    const tHatCenter = computeCenterTangent(pts, splitPoint);
    fitCubic(pts, first, splitPoint, tHat1, tHatCenter, errSq, out, depth + 1);
    fitCubic(pts, splitPoint, last, V.neg(tHatCenter), tHat2, errSq, out, depth + 1);
  }

  /**
   * Fit an open polyline with cubic Béziers.
   * @param pts   points [{x,y}...] (deduped)
   * @param tanL  unit tangent leaving pts[0] (or null → auto from first edge)
   * @param tanR  unit tangent arriving at last point, pointing backwards
   *              (or null → auto)
   * @param err   max deviation in the same units as pts
   */
  ST.fitCubics = function (pts, tanL, tanR, err) {
    const clean = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (V.dist(pts[i], clean[clean.length - 1]) > 1e-9) clean.push(pts[i]);
    }
    if (clean.length < 2) return [];
    const t1 = tanL || V.norm(V.sub(clean[1], clean[0]));
    const t2 = tanR || V.norm(V.sub(clean[clean.length - 2], clean[clean.length - 1]));
    const out = [];
    fitCubic(clean, 0, clean.length - 1, t1, t2, err * err, out, 0);
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
