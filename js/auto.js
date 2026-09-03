/* SANSTYLE — auto.js
 * The hands-free lane: image in → auto-straighten → find letter-sized paint
 * blobs → trace each → guess its character. Everything lands in a review
 * queue; nothing enters the typeface without a human yes.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const auto = (ST.auto = {});

  // ---------- deskew (pure, Node-testable) ----------
  function boxBlur(gray, w, h, r) {
    // two-pass box blur; softens hard staircases so Sobel reads true angles
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) acc += gray[row + ST.clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        acc += gray[row + ST.clamp(x + r + 1, 0, w - 1)] - gray[row + ST.clamp(x - r, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[ST.clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / win;
        acc += tmp[ST.clamp(y + r + 1, 0, h - 1) * w + x] - tmp[ST.clamp(y - r, 0, h - 1) * w + x];
      }
    }
    return out;
  }

  // Estimate the dominant tilt of stroke edges from gradient orientations,
  // optionally only inside `zone` (the paint's own edges — the wall's
  // bricks, a panel's frame or a paper's edge must not straighten the
  // letter). Returns degrees in (-25, 25), 0 when no tilt clearly
  // dominates; positive = image content tilts clockwise.
  //
  // Stems and bars are read separately: the near-vertical edges say how
  // far the letter leans, the near-horizontal ones how far its bars tilt.
  // In a rolled photo both agree; when a piece leans on purpose the stems
  // win, because an upright letter is what the typeface wants. Each
  // population's tilt is the energy-weighted mean of the cluster around
  // its mode, trusted only when that cluster holds a clear share of the
  // population (a curvy handstyle spreads its edges over every angle and
  // is left alone).
  auto.estimateSkewAngle = function (grayRaw, w, h, zone) {
    const gray = boxBlur(grayRaw, w, h, 3);
    const binsV = new Float64Array(51), binsH = new Float64Array(51); // -25..25°, 1° bins
    let nV = 0, nH = 0, totV = 0, totH = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (zone && !zone[i]) continue;
        const gx =
          gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] -
          gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
        const gy =
          gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] -
          gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
        const mag = Math.abs(gx) + Math.abs(gy);
        if (mag < 110) continue;
        let ang = (Math.atan2(gy, gx) * 180) / Math.PI; // edge normal
        // Fold onto deviation from the nearest axis (0 or 90).
        ang = ((ang % 90) + 90) % 90;      // 0..90
        if (ang > 45) ang -= 90;           // -45..45
        const vertical = Math.abs(gx) >= Math.abs(gy); // horizontal normal = a stem's edge
        if (vertical) totV += mag; else totH += mag;
        if (Math.abs(ang) > 25) continue;
        if (vertical) { binsV[Math.round(ang) + 25] += mag; nV++; } else { binsH[Math.round(ang) + 25] += mag; nH++; }
      }
    }
    const cluster = (bins, total, n) => {
      if (n < 60 || total <= 0) return null;
      let best = 0, bestV = -1;
      for (let b = 2; b < 49; b++) {
        const v = bins[b - 2] * 0.25 + bins[b - 1] * 0.5 + bins[b] + bins[b + 1] * 0.5 + bins[b + 2] * 0.25;
        if (v > bestV) { bestV = v; best = b; }
      }
      let e = 0, m = 0;
      for (let b = Math.max(0, best - 3); b <= Math.min(50, best + 3); b++) { e += bins[b]; m += bins[b] * (b - 25); }
      return e / total >= 0.35 ? { angle: m / e, energy: e } : null;
    };
    const cv = cluster(binsV, totV, nV), chz = cluster(binsH, totH, nH);
    let angle = 0;
    if (cv && chz) {
      angle = Math.abs(cv.angle - chz.angle) <= 3
        ? (cv.angle * cv.energy + chz.angle * chz.energy) / (cv.energy + chz.energy)
        : cv.angle;
    } else if (cv) angle = cv.angle;
    else if (chz) angle = chz.angle;
    return Math.round(angle * 10) / 10;
  };

  // The paint's edge zone: a band around the paint's boundary.
  function edgeZone(paint, w, h) {
    const out = ST.raster.dilate(paint, w, h, 3);
    const inner = ST.raster.erode(paint, w, h, 3);
    for (let i = 0; i < out.length; i++) if (inner[i]) out[i] = 0;
    return out;
  }

  // Rotate onto a canvas big enough to hold the whole photo. The corners
  // the photo no longer covers are filled with its background color, not
  // left transparent (black): black corners would otherwise read as the
  // strongest "paint" in the frame.
  function rotateCanvas(src, deg) {
    const rad = (-deg * Math.PI) / 180;
    const s = Math.abs(Math.sin(rad)), c = Math.abs(Math.cos(rad));
    const W = Math.round(src.width * c + src.height * s);
    const H = Math.round(src.width * s + src.height * c);
    const out = g.document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    let fill = { r: 128, g: 128, b: 128 };
    try {
      const d = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
      const bg = ST.extract ? ST.extract.backgroundColor(d, src.width, src.height) : null;
      if (bg) fill = bg;
    } catch (e) { /* tainted canvas: gray corners */ }
    ctx.fillStyle = `rgb(${Math.round(fill.r)},${Math.round(fill.g)},${Math.round(fill.b)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rad);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return out;
  }
  auto.rotateCanvas = rotateCanvas; // also used by the manual rotate controls

  // ---------- candidate detection ----------
  function detectCandidates(mask, w, h, imgArea) {
    const { labels, sizes } = ST.raster.components(mask, w, h);
    const minArea = Math.max(420, imgArea * 0.0018);
    const comps = [];
    for (let i = 1; i < sizes.length; i++) {
      if (sizes[i] < minArea) continue;
      comps.push({ label: i, area: sizes[i], x0: w, y0: h, x1: 0, y1: 0 });
    }
    if (!comps.length) return [];
    const byLabel = new Map(comps.map((c) => [c.label, c]));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = byLabel.get(labels[y * w + x]);
        if (!c) continue;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      }
    }
    // Filters stay permissive: tight-cropped, thin-stroked handstyles fill
    // most of the frame and have low solidity — both are legitimate.
    let kept = comps.filter((c) => {
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      if (bw * bh > imgArea * 0.96) return false;              // the whole wall
      if (c.area / (bw * bh) < 0.02) return false;             // pure wisp
      const touchL = c.x0 <= 1, touchR = c.x1 >= w - 2, touchT = c.y0 <= 1, touchB = c.y1 >= h - 2;
      if ((touchL + touchR + touchT + touchB) >= 3) return false; // frame-edge junk
      return true;
    });
    kept.sort((a, b) => b.area - a.area);
    kept = kept.slice(0, 10);

    // merge detached satellites (i-dots, split strokes) into their main body
    const groups = [];
    for (const c of kept) {
      let host = null;
      for (const gr of groups) {
        const ovl = Math.min(c.x1, gr.x1) - Math.max(c.x0, gr.x0);
        const minW = Math.min(c.x1 - c.x0, gr.x1 - gr.x0) + 1;
        const gap = Math.max(0, Math.max(c.y0, gr.y0) - Math.min(c.y1, gr.y1));
        const tall = Math.max(gr.y1 - gr.y0, c.y1 - c.y0) + 1;
        if (ovl > 0.5 * minW && gap < 0.4 * tall) { host = gr; break; }
      }
      if (host) {
        host.labels.push(c.label);
        host.x0 = Math.min(host.x0, c.x0); host.y0 = Math.min(host.y0, c.y0);
        host.x1 = Math.max(host.x1, c.x1); host.y1 = Math.max(host.y1, c.y1);
        host.area += c.area;
      } else {
        groups.push({ labels: [c.label], x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, area: c.area });
      }
    }
    // most prominent first — the main letterform, not a stray tick
    groups.sort((a, b) => b.area - a.area);
    return { groups, labels };
  }

  function meanWhere(data, field, pred) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0, p = 0; i < field.length; i++, p += 4) {
      if (pred(field[i])) { r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
    }
    return n >= 200 ? { r: r / n, g: g / n, b: b / n } : null;
  }

  // Paint detection relative to the background. The wall/paper is the
  // dominant color of the frame's border; paint is whatever contrasts most
  // with it. The paint reference is the mean of the strongest-contrast
  // pixels — a marker's dense core, not its bleed halo — refined once
  // (k-means step), and the mask threshold sits where the boundary is
  // sharpest, never past the paint↔background midpoint. Works for dark on
  // light, light on dark, colored on gray, and red on pink paper alike.
  // Returns a mask, or null when nothing contrasts with the background.
  function paintMask(data, W, H) {
    const R = ST.raster;
    if (!ST.extract) return null;
    const bg = ST.extract.backgroundColor(data, W, H);
    if (!bg) return null;
    const dbg = R.colorDistMap(data, W, H, [bg]);
    // robust maximum contrast (99.9th percentile); the paint core is
    // everything within 75% of it
    const hist = new Uint32Array(1024);
    for (let i = 0; i < dbg.length; i++) hist[Math.min(1023, dbg[i] | 0)]++;
    let acc = 0, top = 0;
    for (let v = 0; v < 1024; v++) { acc += hist[v]; if (acc >= dbg.length * 0.999) { top = v; break; } }
    if (top < 70) return null;
    let seed = meanWhere(data, dbg, (d) => d >= top * 0.75);
    if (!seed) return null;
    let field = R.colorDistMap(data, W, H, [seed]);
    let sep = R.colorDist(seed.r, seed.g, seed.b, bg.r, bg.g, bg.b);
    const refined = meanWhere(data, field, (d) => d < sep * 0.5);
    if (refined) {
      seed = refined;
      field = R.colorDistMap(data, W, H, [seed]);
      sep = R.colorDist(seed.r, seed.g, seed.b, bg.r, bg.g, bg.b);
    }
    if (sep < 60) return null;
    // along the wall→paint axis: metallic/glossy paint shading past the
    // paint color still counts (see raster.axisDistMap)
    field = R.blur(R.axisDistMap(data, W, H, seed, bg), W, H, 2);
    const cands = [14, 20, 28, 38, 50, 65, 82, 100, 125, 155, 190, 230]
      .filter((t) => t <= Math.max(40, sep * 0.55));
    const best = R.edgeOptimalThreshold(field, W, H, cands, 0.002, 0.5);
    if (!best) return null;
    // pocks, cracks and dirt inside the paint read as paint
    const wall = ST.extract.wallMask(data, W, H, bg, ST.extract.wallTolerance(data, W, H, bg));
    return ST.extract.absorbDefects(best.mask, wall, W, H);
  }

  /**
   * Run the automatic pipeline on a canvas.
   * Returns { canvas (deskewed), angle, candidates: [{crop, paths, mask, w, h,
   *   guess, confidence, ranked }] }
   */
  auto.processImage = function (srcCanvas, opts) {
    const o = Object.assign({ maxEdge: 1400, fillHoles: 0.05, deskew: true }, opts || {});
    // working copy
    let work = srcCanvas;
    const s = Math.min(1, o.maxEdge / Math.max(work.width, work.height));
    if (s < 1) {
      const c = g.document.createElement('canvas');
      c.width = Math.round(work.width * s);
      c.height = Math.round(work.height * s);
      c.getContext('2d').drawImage(work, 0, 0, c.width, c.height);
      work = c;
    }

    let angle = o.angle || 0;
    let ctx = work.getContext('2d');
    let img = ctx.getImageData(0, 0, work.width, work.height);
    let gray = ST.raster.luma(img.data, work.width, work.height);

    // paint first, then straighten by the PAINT's own edges: the letter's
    // stems define upright, not the wall's bricks or the paper's edge
    let paint = paintMask(img.data, work.width, work.height);
    if (o.deskew) {
      const zone = paint ? edgeZone(paint, work.width, work.height) : null;
      angle = auto.estimateSkewAngle(gray, work.width, work.height, zone);
      if (Math.abs(angle) >= 1.5 && Math.abs(angle) <= 20) {
        work = rotateCanvas(work, angle);
        ctx = work.getContext('2d');
        img = ctx.getImageData(0, 0, work.width, work.height);
        gray = ST.raster.luma(img.data, work.width, work.height);
        paint = paintMask(img.data, work.width, work.height);
      } else {
        angle = 0;
      }
    }

    const W = work.width, H = work.height, area = W * H;
    // pre-blur the field so broken/chalky paint textures threshold cleanly
    const blurred = ST.raster.blur(gray, W, H, 2);
    gray = new Uint8Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, Math.round(blurred[i])));
    const t = ST.raster.otsu(gray, null);
    let mean = 0;
    for (let i = 0; i < gray.length; i++) mean += gray[i];
    mean /= gray.length;

    const tryPolarity = (invert) => {
      let mask = ST.raster.maskFromLuma(gray, null, t, invert);
      mask = ST.raster.open(mask, W, H, 1);
      const det = detectCandidates(mask, W, H, area);
      return { mask, det, n: det.groups ? det.groups.length : 0 };
    };

    // paint vs. background by color contrast first; luminance polarity
    // guesses only as the fallback when nothing contrasts with the border
    let first = null;
    if (paint) {
      // gap jumping (see extract.seeded): streaky strokes read as one
      const sm = o.smoothing != null ? o.smoothing : 4;
      const g = Math.round(Math.min(ST.raster.strokeWidth(paint, W, H) * 0.45, Math.max(W, H) * 0.02) * (sm / 4));
      const m = ST.raster.open(g >= 2 ? ST.raster.close(paint, W, H, g) : paint, W, H, 1);
      const det = detectCandidates(m, W, H, area);
      if (det.groups && det.groups.length) first = { mask: m, det, n: det.groups.length };
    }
    if (!first) first = tryPolarity(mean <= 128);
    if (!first.n) {
      const second = tryPolarity(mean > 128);
      if (second.n) first = second;
    }
    const { mask, det } = first;
    const candidates = [];
    if (det.groups) {
      for (const grp of det.groups) {
        const pad = 10;
        const cx0 = Math.max(0, grp.x0 - pad), cy0 = Math.max(0, grp.y0 - pad);
        const cx1 = Math.min(W, grp.x1 + 1 + pad), cy1 = Math.min(H, grp.y1 + 1 + pad);
        const cw = cx1 - cx0, ch = cy1 - cy0;
        const sub = new Uint8Array(cw * ch);
        const want = new Set(grp.labels);
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            const gi = (y + cy0) * W + (x + cx0);
            if (mask[gi] && want.has(det.labels[gi])) sub[y * cw + x] = 1;
          }
        }
        // same stroke-width-capped clean-up as click-to-trace and the studio
        const clean = ST.extract
          ? ST.extract.cleanMask(sub, cw, ch, o.smoothing != null ? o.smoothing : 4)
          : ST.raster.fillHoles(ST.raster.close(sub, cw, ch, 1), cw, ch, o.fillHoles);
        const paths = ST.trace.vectorize(clean, cw, ch, {});
        if (!paths.length) continue;
        candidates.push({
          crop: { x: cx0, y: cy0, w: cw, h: ch },
          mask: clean, w: cw, h: ch,
          paths,
        });
      }
    }
    // Standardize detail: a letter photographed from far away is small in
    // pixels, and every smoothing radius, cap and tolerance scales with
    // pixels — so bring the main letter up to ~520 px tall and run again.
    // The photo taken up close and the one taken from across the street
    // then get the same treatment.
    if (!o.noUpscale && candidates.length) {
      let tallest = 0;
      for (const c of candidates) tallest = Math.max(tallest, Math.max(c.crop.h, c.crop.w * 0.8));
      const k = Math.min(2.5, 520 / Math.max(1, tallest));
      if (k > 1.15) {
        const up = g.document.createElement('canvas');
        up.width = Math.round(W * k); up.height = Math.round(H * k);
        const uc = up.getContext('2d');
        uc.imageSmoothingEnabled = true;
        uc.imageSmoothingQuality = 'high';
        uc.drawImage(work, 0, 0, up.width, up.height);
        const again = auto.processImage(up, Object.assign({}, o, { deskew: false, noUpscale: true, angle, maxEdge: 1e9 }));
        if (again.candidates.length) return again;
      }
    }
    return { canvas: work, angle, candidates };
  };
})(typeof window !== 'undefined' ? window : globalThis);
