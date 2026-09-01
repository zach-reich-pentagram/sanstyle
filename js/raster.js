/* SANSTYLE — raster.js
 * Pixel-level ink detection: luminance + Otsu auto threshold, spray-color
 * matching (redmean distance), binary morphology, connected-component
 * cleanup, and polygon → mask rasterization for the lasso.
 * Masks are Uint8Array(w*h), 1 = ink.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const raster = (ST.raster = {});

  // rgba Uint8ClampedArray → Uint8Array luminance.
  raster.luma = function (data, w, h) {
    const out = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = (data[p] * 54 + data[p + 1] * 183 + data[p + 2] * 19) >> 8;
    }
    return out;
  };

  raster.otsu = function (luma, roi) {
    const hist = new Float64Array(256);
    let total = 0;
    for (let i = 0; i < luma.length; i++) {
      if (!roi || roi[i]) { hist[luma[i]]++; total++; }
    }
    if (!total) return 128;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, best = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; best = t; }
    }
    // +1 so "luma < threshold" captures the darker class inclusively.
    return best + 1;
  };

  // Threshold luminance inside the roi. invert=false → dark pixels are ink.
  raster.maskFromLuma = function (luma, roi, thresh, invert) {
    const out = new Uint8Array(luma.length);
    for (let i = 0; i < luma.length; i++) {
      if (roi && !roi[i]) continue;
      const dark = luma[i] < thresh;
      out[i] = (dark !== !!invert) ? 1 : 0;
    }
    return out;
  };

  // Guess which side of the threshold is the letterform: within a lasso the
  // ink is usually the minority of pixels.
  raster.guessInvert = function (luma, roi, thresh) {
    let dark = 0, total = 0;
    for (let i = 0; i < luma.length; i++) {
      if (roi && !roi[i]) continue;
      total++;
      if (luma[i] < thresh) dark++;
    }
    return dark > total / 2; // majority dark → ink is probably the light side
  };

  // "redmean" perceptual-ish RGB distance, 0..~765.
  function colorDist(r1, g1, b1, r2, g2, b2) {
    const rm = (r1 + r2) / 2;
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt(
      (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db
    );
  }

  // Two-pass box blur over any numeric array → Float32Array. Blurring the
  // FIELD (luminance or color distance) before thresholding is what tames
  // chalky/textured paint: partial-coverage speckle at the edge averages
  // toward its neighborhood instead of flickering across the threshold.
  raster.blur = function (src, w, h, r) {
    if (!r || r <= 0) return Float32Array.from(src);
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const win = 2 * r + 1;
    const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[row + cl(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        acc += src[row + cl(x + r + 1, 0, w - 1)] - src[row + cl(x - r, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[cl(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / win;
        acc += tmp[cl(y + r + 1, 0, h - 1) * w + x] - tmp[cl(y - r, 0, h - 1) * w + x];
      }
    }
    return out;
  };

  // Min redmean distance to any seed color, per pixel → Float32Array.
  raster.colorDistMap = function (data, w, h, seeds) {
    const out = new Float32Array(w * h);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      let best = 1e9;
      for (let s = 0; s < seeds.length; s++) {
        const sd = seeds[s];
        const d = colorDist(data[p], data[p + 1], data[p + 2], sd.r, sd.g, sd.b);
        if (d < best) best = d;
      }
      out[i] = best;
    }
    return out;
  };

  // Per-pixel chroma (max−min of RGB): spray and marker are chromatic,
  // walls are mostly gray — a far more reliable separator than luminance
  // whenever the paint has any color at all.
  raster.saturation = function (data, w, h) {
    const out = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      out[i] = Math.max(r, g, b) - Math.min(r, g, b);
    }
    return out;
  };

  // Connected region (4-neighborhood) of the predicate containing (sx, sy).
  // pred(i) → truthy for pixels that belong. Returns {mask, count}.
  raster.floodFrom = function (w, h, sx, sy, pred) {
    const mask = new Uint8Array(w * h);
    const start = sy * w + sx;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h || !pred(start)) return { mask, count: 0 };
    const stack = new Int32Array(w * h);
    let sp = 0, count = 0;
    stack[sp++] = start;
    mask[start] = 1;
    while (sp) {
      const j = stack[--sp];
      count++;
      const x = j % w, y = (j / w) | 0;
      if (x > 0 && !mask[j - 1] && pred(j - 1)) { mask[j - 1] = 1; stack[sp++] = j - 1; }
      if (x < w - 1 && !mask[j + 1] && pred(j + 1)) { mask[j + 1] = 1; stack[sp++] = j + 1; }
      if (y > 0 && !mask[j - w] && pred(j - w)) { mask[j - w] = 1; stack[sp++] = j - w; }
      if (y < h - 1 && !mask[j + w] && pred(j + w)) { mask[j + w] = 1; stack[sp++] = j + w; }
    }
    return { mask, count };
  };

  // Geodesic reconstruction: grow `marker` by `iters` single-pixel dilations,
  // never leaving `limit`. Recovers a letter's full stroke width after an
  // opening has broken its contact with a touching neighbor.
  raster.reconstruct = function (marker, limit, w, h, iters) {
    let cur = marker;
    for (let k = 0; k < iters; k++) {
      const d = raster.dilate(cur, w, h, 1);
      const next = new Uint8Array(w * h);
      let changed = false;
      for (let i = 0; i < next.length; i++) {
        next[i] = d[i] && limit[i] ? 1 : 0;
        if (next[i] !== cur[i]) changed = true;
      }
      cur = next;
      if (!changed) break;
    }
    return cur;
  };

  // Ink pixels bordering background (4-neighborhood).
  raster.perimeter = function (mask, w, h) {
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
            !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) n++;
      }
    }
    return n;
  };

  // Ribbon-model stroke width ≈ 2·area/perimeter. Caps how hard structural
  // smoothing may push before it would erase genuine thin strokes.
  raster.strokeWidth = function (mask, w, h) {
    const area = raster.count(mask);
    if (!area) return 0;
    const per = raster.perimeter(mask, w, h);
    return per ? (2 * area) / per : 0;
  };

  // Ink = pixels within tol of ANY seed color. tol in 0..100 UI units.
  raster.maskFromColor = function (data, w, h, roi, seeds, tol) {
    const out = new Uint8Array(w * h);
    const maxD = 8 + tol * 3.4; // map UI 0..100 → distance 8..348
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      if (roi && !roi[i]) continue;
      const r = data[p], gg = data[p + 1], b = data[p + 2];
      for (let s = 0; s < seeds.length; s++) {
        const sd = seeds[s];
        if (colorDist(r, gg, b, sd.r, sd.g, sd.b) <= maxD) { out[i] = 1; break; }
      }
    }
    return out;
  };

  // --- Morphology ------------------------------------------------------------
  // Small radii use a true disk; larger radii switch to an O(n) separable box
  // (running distance-to-nearest scan per axis), which is what the occlusion
  // bridge needs for r up to ~40 without melting the CPU.
  function diskOffsets(r) {
    const off = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + 0.5) off.push([dx, dy]);
      }
    }
    return off;
  }

  function morphDisk(mask, w, h, r, isDilate) {
    const off = diskOffsets(r);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = isDilate ? 0 : 1;
        for (let k = 0; k < off.length; k++) {
          const nx = x + off[k][0], ny = y + off[k][1];
          const nv = (nx < 0 || ny < 0 || nx >= w || ny >= h) ? 0 : mask[ny * w + nx];
          if (isDilate) { if (nv) { v = 1; break; } }
          else if (!nv) { v = 0; break; }
        }
        out[i] = v;
      }
    }
    return out;
  }

  function dilateBox(mask, w, h, r) {
    const tmp = new Uint8Array(w * h);
    // horizontal: 1 if any ink within r columns
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let last = -1e9;
      for (let x = 0; x < w; x++) { if (mask[row + x]) last = x; if (x - last <= r) tmp[row + x] = 1; }
      last = 1e9;
      for (let x = w - 1; x >= 0; x--) { if (mask[row + x]) last = x; if (last - x <= r) tmp[row + x] = 1; }
    }
    const out = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
      let last = -1e9;
      for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
      last = 1e9;
      for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
    }
    return out;
  }

  function erodeBox(mask, w, h, r) {
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
    const d = dilateBox(inv, w, h, r);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) out[i] = d[i] ? 0 : 1;
    return out;
  }

  raster.dilate = (m, w, h, r) => (r <= 0 ? m : r <= 3 ? morphDisk(m, w, h, r, true) : dilateBox(m, w, h, r));
  raster.erode = (m, w, h, r) => (r <= 0 ? m : r <= 3 ? morphDisk(m, w, h, r, false) : erodeBox(m, w, h, r));
  raster.close = (m, w, h, r) => raster.erode(raster.dilate(m, w, h, r), w, h, r);
  raster.open = (m, w, h, r) => raster.dilate(raster.erode(m, w, h, r), w, h, r);

  // --- Connected components -------------------------------------------------
  // 4-connected flood labeling. Returns {labels: Int32Array, sizes: [..]}
  // where label 0 = background, component ids start at 1.
  raster.components = function (mask, w, h) {
    const labels = new Int32Array(w * h);
    const sizes = [0];
    const stack = new Int32Array(w * h);
    let next = 1;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || labels[i]) continue;
      let sp = 0, size = 0;
      stack[sp++] = i;
      labels[i] = next;
      while (sp) {
        const j = stack[--sp];
        size++;
        const x = j % w, y = (j / w) | 0;
        if (x > 0 && mask[j - 1] && !labels[j - 1]) { labels[j - 1] = next; stack[sp++] = j - 1; }
        if (x < w - 1 && mask[j + 1] && !labels[j + 1]) { labels[j + 1] = next; stack[sp++] = j + 1; }
        if (y > 0 && mask[j - w] && !labels[j - w]) { labels[j - w] = next; stack[sp++] = j - w; }
        if (y < h - 1 && mask[j + w] && !labels[j + w]) { labels[j + w] = next; stack[sp++] = j + w; }
      }
      sizes.push(size);
      next++;
    }
    return { labels, sizes };
  };

  // Drop components smaller than max(minAbs, minFrac * largest).
  raster.despeckle = function (mask, w, h, minFrac, minAbs) {
    const { labels, sizes } = raster.components(mask, w, h);
    if (sizes.length <= 1) return mask;
    let largest = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > largest) largest = sizes[i];
    const cut = Math.max(minAbs || 0, largest * (minFrac || 0));
    const keep = new Uint8Array(sizes.length);
    for (let i = 1; i < sizes.length; i++) keep[i] = sizes[i] >= cut ? 1 : 0;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) out[i] = keep[labels[i]];
    return out;
  };

  // Fill enclosed holes (spray-coverage gaps). A hole fills when it is at
  // most maxFrac of the TOTAL shape (ink + that hole) — measured this way,
  // spray gaps sit near 0 while an O's counter is ~50%, so the slider can
  // reach both regimes: small values heal infill, cranked values go solid.
  raster.fillHoles = function (mask, w, h, maxFrac) {
    if (!maxFrac || maxFrac <= 0) return mask;
    const inkArea = raster.count(mask);
    if (!inkArea) return mask;
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
    const { labels, sizes } = raster.components(inv, w, h);
    const touchesBorder = new Uint8Array(sizes.length);
    for (let x = 0; x < w; x++) {
      touchesBorder[labels[x]] = 1;
      touchesBorder[labels[(h - 1) * w + x]] = 1;
    }
    for (let y = 0; y < h; y++) {
      touchesBorder[labels[y * w]] = 1;
      touchesBorder[labels[y * w + w - 1]] = 1;
    }
    const fillLabel = new Uint8Array(sizes.length);
    for (let L = 1; L < sizes.length; L++) {
      if (touchesBorder[L]) continue;
      if (sizes[L] <= maxFrac * (inkArea + sizes[L])) fillLabel[L] = 1;
    }
    const out = Uint8Array.from(mask);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] && fillLabel[labels[i]]) out[i] = 1;
    }
    return out;
  };

  // Occlusion inference: X marks the intruding letter (block-out brush).
  // Remove A∩X, then bridge the surviving stroke back through X with a wide
  // morphological closing whose new pixels are only accepted inside X — a
  // geometric guess at where the hidden stroke continues.
  raster.bridgeThrough = function (maskA, maskX, w, h, r) {
    const base = new Uint8Array(w * h);
    for (let i = 0; i < maskA.length; i++) base[i] = maskA[i] && !maskX[i] ? 1 : 0;
    if (!r || r <= 0) return base;
    const closed = raster.close(base, w, h, r);
    const out = Uint8Array.from(base);
    for (let i = 0; i < out.length; i++) {
      if (closed[i] && maskX[i]) out[i] = 1;
    }
    return out;
  };

  // Scanline even-odd fill of a polygon into a mask (poly in mask coords).
  raster.fillPoly = function (w, h, pts) {
    const out = new Uint8Array(w * h);
    if (pts.length < 3) return out;
    for (let y = 0; y < h; y++) {
      const yc = y + 0.5;
      const xs = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j], b = pts[i];
        if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
          xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
        const x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = x0; x <= x1; x++) out[y * w + x] = 1;
      }
    }
    return out;
  };

  raster.maskBounds = function (mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };

  raster.count = function (mask) {
    let n = 0;
    for (let i = 0; i < mask.length; i++) n += mask[i];
    return n;
  };
})(typeof window !== 'undefined' ? window : globalThis);
