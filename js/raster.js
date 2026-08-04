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

  // --- Morphology (disk structuring element) --------------------------------
  function diskOffsets(r) {
    const off = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + 0.5) off.push([dx, dy]);
      }
    }
    return off;
  }

  function morph(mask, w, h, r, isDilate) {
    if (r <= 0) return mask;
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

  raster.dilate = (m, w, h, r) => morph(m, w, h, r, true);
  raster.erode = (m, w, h, r) => morph(m, w, h, r, false);
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
