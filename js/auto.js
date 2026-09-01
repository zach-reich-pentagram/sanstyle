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

  // Estimate the dominant tilt of stroke edges from gradient orientations.
  // Returns degrees in (-25, 25); positive = image content tilts clockwise.
  auto.estimateSkewAngle = function (grayRaw, w, h) {
    const gray = boxBlur(grayRaw, w, h, 3);
    const bins = new Float64Array(51); // -25..25 degrees, 1° bins
    let considered = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
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
        if (Math.abs(ang) > 25) continue;
        bins[Math.round(ang) + 25] += mag;
        considered++;
      }
    }
    if (considered < 60) return 0;
    // smooth the histogram a touch, then take the modal deviation
    let best = 0, bestV = -1;
    for (let b = 1; b < 50; b++) {
      const v = bins[b - 1] * 0.5 + bins[b] + bins[b + 1] * 0.5;
      if (v > bestV) { bestV = v; best = b - 25; }
    }
    return best;
  };

  function rotateCanvas(src, deg) {
    const rad = (-deg * Math.PI) / 180;
    const s = Math.abs(Math.sin(rad)), c = Math.abs(Math.cos(rad));
    const W = Math.round(src.width * c + src.height * s);
    const H = Math.round(src.width * s + src.height * c);
    const out = g.document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
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

  // Chromatic paint detection: if the image carries a clearly colored
  // cluster against a mostly-gray wall, build the mask from color distance
  // to that paint instead of luminance. Returns a mask or null.
  function chromaticMask(data, W, H) {
    const sat = ST.raster.saturation(data, W, H);
    const hist = new Uint32Array(256);
    for (let i = 0; i < sat.length; i++) hist[sat[i]]++;
    const pct = (p) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * sat.length) return v; }
      return 255;
    };
    const wallSat = pct(0.5), topSat = pct(0.97);
    if (!(topSat > 60 && topSat - wallSat > 35)) return null;
    const cut = wallSat + (topSat - wallSat) * 0.5;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0, p = 0; i < sat.length; i++, p += 4) {
      if (sat[i] >= cut) { r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
    }
    if (n < 200) return null;
    const seed = { r: r / n, g: g / n, b: b / n };
    const field = ST.raster.blur(ST.raster.colorDistMap(data, W, H, [seed]), W, H, 2);
    // Otsu on the (compressed) distance field separates paint from wall
    const q = new Uint8Array(W * H);
    for (let i = 0; i < q.length; i++) q[i] = Math.min(255, Math.round(field[i] * 0.6));
    const t = ST.raster.otsu(q, null);
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < q.length; i++) if (q[i] < t) mask[i] = 1;
    return mask;
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

    let angle = 0;
    let ctx = work.getContext('2d');
    let img = ctx.getImageData(0, 0, work.width, work.height);
    let gray = ST.raster.luma(img.data, work.width, work.height);

    if (o.deskew) {
      angle = auto.estimateSkewAngle(gray, work.width, work.height);
      if (Math.abs(angle) >= 1.5 && Math.abs(angle) <= 22) {
        work = rotateCanvas(work, angle);
        ctx = work.getContext('2d');
        img = ctx.getImageData(0, 0, work.width, work.height);
        gray = ST.raster.luma(img.data, work.width, work.height);
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

    // colored paint on a gray wall → chroma beats luminance; otherwise
    // bright wall → paint is probably dark, with the other polarity as fallback
    let first = null;
    const chroma = chromaticMask(img.data, W, H);
    if (chroma) {
      const m = ST.raster.open(chroma, W, H, 1);
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
    return { canvas: work, angle, candidates };
  };
})(typeof window !== 'undefined' ? window : globalThis);
