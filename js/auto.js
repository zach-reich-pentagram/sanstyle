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
    const out = ST.makeCanvas(W, H);
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
    // where the photo itself lies: the corners filled in are not wall, they
    // are past the photo's edge, and a letter the photo cut off there is
    // finished past it like at any frame edge
    try {
      const m = ST.makeCanvas(W, H);
      const mc = m.getContext('2d');
      mc.translate(W / 2, H / 2);
      mc.rotate(rad);
      if (src._inPhoto) {
        // turning a photo that was turned before: its own edge still counts
        const pc = ST.makeCanvas(src.width, src.height);
        const px = pc.getContext('2d'), pd = px.createImageData(src.width, src.height);
        for (let i = 0; i < src._inPhoto.length; i++) if (src._inPhoto[i]) pd.data[i * 4 + 3] = 255;
        px.putImageData(pd, 0, 0);
        mc.drawImage(pc, -src.width / 2, -src.height / 2);
      } else {
        mc.fillStyle = '#fff';
        mc.fillRect(-src.width / 2 + 1, -src.height / 2 + 1, src.width - 2, src.height - 2);
      }
      const md = mc.getImageData(0, 0, W, H).data;
      const valid = new Uint8Array(W * H);
      for (let i = 0; i < valid.length; i++) valid[i] = md[i * 4 + 3] > 200 ? 1 : 0;
      out._inPhoto = valid;
    } catch (e) { /* no mask: the fill reads as wall, as before */ }
    return out;
  }
  // `canvas._inPhoto` scaled along with the canvas
  function scaleInPhoto(src, dst) {
    const v = src._inPhoto;
    if (!v) return;
    const sw = src.width, sh = src.height, dw = dst.width, dh = dst.height;
    const out = new Uint8Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
      for (let x = 0; x < dw; x++) out[y * dw + x] = v[sy * sw + Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw))];
    }
    dst._inPhoto = out;
  }
  auto.scaleInPhoto = scaleInPhoto;
  auto.rotateCanvas = rotateCanvas; // also used by the manual rotate controls

  // ---------- candidate detection ----------
  // `frame`: where the photo itself lies in the mask (a padded mask holds
  // letters completed past the photo's edge); default the whole mask
  function detectCandidates(mask, w, h, imgArea, frame) {
    const fr = frame || { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
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
      const touchL = c.x0 <= fr.x0 + 1, touchR = c.x1 >= fr.x1 - 1, touchT = c.y0 <= fr.y0 + 1, touchB = c.y1 >= fr.y1 - 1;
      const touches = touchL + touchR + touchT + touchB;
      if (touches >= 4) return false; // spans the frame: the wall itself, a band across it
      // three edges: frame-edge junk (a pole, a doorframe) — or a letter
      // photographed close; the recognizer can tell them apart, so with it
      // they stay (ranked by how letter-like they read)
      if (touches === 3 && !(ST.recognize && ST.recognize.ready())) return false;
      return true;
    });
    kept.sort((a, b) => b.area - a.area);
    kept = kept.slice(0, 10);

    // merge detached satellites (i-dots, split strokes) into their main body
    // — a satellite is small beside its host: two letter-sized shapes one
    // above the other (a sign's strip over the tag, a letter over another)
    // stay two shapes
    const groups = [];
    for (const c of kept) {
      let host = null;
      for (const gr of groups) {
        if (c.area > 0.35 * gr.area) continue;
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
      if (pred(field[i], i)) { r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
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
  // Thresholds for a paint mask over the whole photo. (A click grows further
  // — up to the midpoint however strong the contrast, see extract.js's
  // GROW_TOLERANCES — since it floods only what is joined to it and stops
  // at a leak; over the whole photo that would take in the sky and the
  // street round a dark pole along with the letter on it.)
  const PAINT_TOLERANCES = [14, 20, 28, 38, 50, 65, 82, 100, 125, 155, 190, 230];
  function paintMask(data, W, H) {
    const R = ST.raster;
    if (!ST.extract) return null;
    let bg = ST.extract.backgroundColor(data, W, H);
    if (!bg) return null;
    // the photo's border can be another surface than the one the letter is
    // on (a gray wall and white paper round a dark post in the middle):
    // when the border's color is all but absent from the middle of the
    // photo, the wall is the one round its center
    const local = ST.extract.localWall(data, W, H, W / 2, H / 2, bg, { look: 0.3, share: 0.1 });
    if (local) bg = local.bg;
    const dbg = R.colorDistMap(data, W, H, [bg]);
    // (on a wall of its own in the middle, the paint is looked for there
    // too: the other surfaces at the edges contrast with it as well)
    let mid = null;
    if (local) {
      mid = new Uint8Array(W * H);
      const mx0 = Math.round(W * 0.2), mx1 = Math.round(W * 0.8), my0 = Math.round(H * 0.2), my1 = Math.round(H * 0.8);
      for (let y = my0; y < my1; y++) mid.fill(1, y * W + mx0, y * W + mx1);
    }
    // robust maximum contrast (99.9th percentile); the paint core is
    // everything within 75% of it
    const hist = new Uint32Array(1024);
    let counted = 0;
    for (let i = 0; i < dbg.length; i++) { if (mid && !mid[i]) continue; hist[Math.min(1023, dbg[i] | 0)]++; counted++; }
    let acc = 0, top = 0;
    for (let v = 0; v < 1024; v++) { acc += hist[v]; if (acc >= counted * 0.999) { top = v; break; } }
    if (top < 70) return null;
    // (there, the commonest color that is not that wall: the most
    // contrasting one can be a white strip at the edge of the middle)
    let seed = local
      ? R.dominantColor(data, W, H, (x, y) => mid[y * W + x] === 1 && dbg[y * W + x] > Math.max(60, local.tol))
      : meanWhere(data, dbg, (d) => d >= top * 0.75);
    if (!seed) return null;
    let field = R.colorDistMap(data, W, H, [seed]);
    let sep = R.colorDist(seed.r, seed.g, seed.b, bg.r, bg.g, bg.b);
    const refined = meanWhere(data, field, (d, i) => d < sep * 0.5 && (!mid || mid[i]));
    if (refined) {
      seed = refined;
      field = R.colorDistMap(data, W, H, [seed]);
      sep = R.colorDist(seed.r, seed.g, seed.b, bg.r, bg.g, bg.b);
    }
    if (sep < 60) return null;
    // shaded or metallic paint: the strongest contrast is its darkest
    // streak, the paint itself is the most common tone along that axis
    const wallTol = local ? local.tol : ST.extract.wallTolerance(data, W, H, bg);
    const wall = ST.extract.wallMask(data, W, H, bg, wallTol);
    const nonWall = new Uint8Array(W * H);
    for (let i = 0; i < nonWall.length; i++) nonWall[i] = wall[i] || (mid && !mid[i]) ? 0 : 1;
    const dom = ST.extract.dominantAlongAxis(data, W, H, nonWall, seed, bg);
    if (dom) {
      const dsep = R.colorDist(dom.r, dom.g, dom.b, bg.r, bg.g, bg.b);
      if (dsep >= 60) { seed = dom; sep = dsep; }
    }
    // along the wall→paint axis: metallic/glossy paint shading past the
    // paint color still counts (see raster.axisDistMap)
    field = R.blur(R.axisDistMap(data, W, H, seed, bg), W, H, 2);
    const cands = PAINT_TOLERANCES.filter((t) => t <= Math.max(40, sep * 0.55));
    let best = R.edgeOptimalThreshold(field, W, H, cands, 0.002, 0.5);
    if (!best) return null;
    // metallic crinkle (see extract.seeded): at the pixel level the paint is
    // all notches and pocks; read again with the texture averaged out
    let softened = null;
    const solid = ST.extract.solidWidth(best.mask, W, H);
    if (solid > 16 && R.strokeWidth(best.mask, W, H) < 0.5 * solid) {
      // — at the same level, and only to heal: what the texture pocked or
      // notched is filled in, nothing the sharp reading had is lost (a
      // stroke in shade, or silver lit cool beside a warm one, can average
      // out below the level whole)
      const soft = R.blur(R.axisDistMap(data, W, H, seed, bg), W, H, Math.round(solid / 8));
      const mask = Uint8Array.from(best.mask);
      for (let i = 0; i < mask.length; i++) if (soft[i] <= best.t) mask[i] = 1;
      softened = { before: R.count(best.mask), after: R.count(mask) };
      best = { t: best.t, mask };
    }
    // pocks, cracks and dirt inside the paint read as paint (`filled`); the
    // classified paint itself (`raw`) is what the stroke-tube filter later
    // measures every fill against
    return { raw: best.mask, filled: ST.extract.absorbDefects(best.mask, wall, W, H), bg, seed, wall, local: !!local, softened };
  }
  auto._paintMask = paintMask; // for diagnostics
  auto._secondPaint = (data, W, H, pm) => {
    const seed = otherPaint(data, W, H, pm);
    const pm2 = seed ? paintFrom(data, W, H, seed, pm.bg, pm.wall, ST.raster.dilate(pm.raw, W, H, 2)) : null;
    return pm2 && { seed, pm: pm2, hug: hugShare(pm2.raw, pm, W, H) };
  };

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
      const c = ST.makeCanvas(Math.round(work.width * s), Math.round(work.height * s));
      c.getContext('2d').drawImage(work, 0, 0, c.width, c.height);
      scaleInPhoto(work, c);
      work = c;
    }

    let angle = o.angle || 0;
    let ctx = work.getContext('2d');
    let img = ctx.getImageData(0, 0, work.width, work.height);
    let gray = ST.raster.luma(img.data, work.width, work.height);

    // paint first, then straighten by the PAINT's own edges: the letter's
    // stems define upright, not the wall's bricks or the paper's edge
    let pm = paintMask(img.data, work.width, work.height);
    if (o.deskew) {
      const zone = pm ? edgeZone(pm.filled, work.width, work.height) : null;
      angle = auto.estimateSkewAngle(gray, work.width, work.height, zone);
      if (Math.abs(angle) >= 1.5 && Math.abs(angle) <= 20) {
        work = rotateCanvas(work, angle);
        ctx = work.getContext('2d');
        img = ctx.getImageData(0, 0, work.width, work.height);
        gray = ST.raster.luma(img.data, work.width, work.height);
        pm = paintMask(img.data, work.width, work.height);
      } else {
        angle = 0;
      }
    }
    const W = work.width, H = work.height, area = W * H;
    const env = { img, W, H, area, work, o };

    // paint vs. background by color contrast first; luminance polarity
    // guesses only as the fallback when nothing contrasts with the border
    let candidates = pm ? shapesOf(pm, env) : [];
    if (!candidates.length) {
      // pre-blur the field so broken/chalky paint textures threshold cleanly
      const blurred = ST.raster.blur(gray, W, H, 2);
      const g8 = new Uint8Array(W * H);
      let mean = 0;
      for (let i = 0; i < g8.length; i++) { g8[i] = Math.max(0, Math.min(255, Math.round(blurred[i]))); mean += g8[i]; }
      mean /= g8.length;
      const t = ST.raster.otsu(g8, null);
      const tryPolarity = (invert) => {
        const mask = ST.raster.open(ST.raster.maskFromLuma(g8, null, t, invert), W, H, 1);
        return build({ mask, det: detectCandidates(mask, W, H, area) }, env);
      };
      candidates = tryPolarity(mean <= 128);
      if (!candidates.length) candidates = tryPolarity(mean > 128);
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
        const up = ST.makeCanvas(Math.round(W * k), Math.round(H * k));
        const uc = up.getContext('2d');
        uc.imageSmoothingEnabled = true;
        uc.imageSmoothingQuality = 'high';
        uc.drawImage(work, 0, 0, up.width, up.height);
        scaleInPhoto(work, up);
        const again = auto.processImage(up, Object.assign({}, o, { deskew: false, noUpscale: true, angle, maxEdge: 1e9 }));
        if (again.candidates.length) return again;
      }
    }
    if (!o.noLetters) {
      let ranked = findLetters(candidates, W, H);
      // Nothing reads clearly as a letter in the paint that stands out most
      // (a sticker, a sign, a strip outshouting the tag)? Read the wall's
      // next paint too, and rank everything together.
      // (not when the letter's own wall was found in the middle of the
      // photo: the next "paint" is then one of the other surfaces round it)
      if (pm && !pm.local && !o.noSecondPaint) {
        const seed2 = otherPaint(img.data, W, H, pm);
        let pm2 = seed2 ? paintFrom(img.data, W, H, seed2, pm.bg, pm.wall, ST.raster.dilate(pm.raw, W, H, 2)) : null;
        // a paint that hugs the first — its bleed halo, outline or shadow —
        // belongs to the same letters, and read alone it is only their ghost
        if (pm2 && hugShare(pm2.raw, pm, W, H) >= HUG) pm2 = null;
        // read when the first paint gave no clear, central letter — or the
        // second covers a good part of what the first does (a big letter in
        // a second color is worth a look even beside a clear small one)
        const weak = !(ranked[0] && ranked[0].score >= 0.5);
        const sizable = pm2 && ST.raster.count(pm2.raw) >= 0.3 * ST.raster.count(pm.raw);
        const more = pm2 && (weak || sizable) ? shapesOf(pm2, env) : [];
        if (more.length) ranked = findLetters(candidates.concat(more), W, H);
      }
      candidates = ranked;
      for (const c of candidates) delete c._found; // stroke models are big: not kept with the queue
    }
    return { canvas: work, angle, candidates };
  };

  // The shapes one paint makes: gap-jumped, carried on under what hides it,
  // grouped, cleaned and traced.
  function shapesOf(pm, env) {
    const { img, W, H, area, work, o } = env;
    const paint = pm.filled;
    // gap jumping (see extract.seeded): streaky strokes read as one
    const sm = o.smoothing != null ? o.smoothing : 4;
    const sw = ST.raster.strokeWidth(paint, W, H);
    const g = Math.round(Math.min(sw * 0.45, Math.max(W, H) * 0.02) * (sm / 4));
    let m = ST.raster.open(g >= 2 ? ST.raster.close(paint, W, H, g) : paint, W, H, 1);
    // Occlusion: strokes carried on under what hides them — a pipe, a
    // crack, another color, the frame edge — so a letter split by a
    // drainpipe is one letter again, and one cut off by the photo's edge
    // is finished past it (see complete.js). The mask gains a margin
    // round the photo for that.
    let P = 0, MW = W, MH = H, tubes = null, cls = null;
    if (ST.complete && !o.noComplete) {
      cls = ST.complete.classify(img.data, W, H, { bg: pm.bg, seed: pm.seed, paint: pm.raw, wall: pm.wall, sw });
      if (work._inPhoto) for (let i = 0; i < cls.length; i++) if (!work._inPhoto[i]) cls[i] = ST.complete.FRAME;
      const done = ST.complete.complete(m, W, H, {
        at: ST.complete.sampler(cls, W, H),
        letterWidth: sw,
        minArea: Math.round(Math.max(420, area * 0.0018) / 3),
      });
      m = done.mask; tubes = done.tubes; P = done.P; MW = done.W2; MH = done.H2;
    }
    const det = detectCandidates(m, MW, MH, area, { x0: P, y0: P, x1: P + W - 1, y1: P + H - 1 });
    if (!det.groups || !det.groups.length) return [];
    return build({ mask: m, det, P, MW, MH, tubes, sw, paintRaw: pm.raw, cls }, env);
  }

  // Each group of a mask → a cleaned, traced candidate.
  function build(first, env) {
    const { W, H, o } = env;
    const { mask, det } = first;
    const P = first.P || 0, MW = first.MW || W, MH = first.MH || H, tubes = first.tubes || null;
    const paintRaw = first.paintRaw || null, cls = first.cls || null;
    const candidates = [];
    if (!det.groups) return candidates;
    const pad = 10 + Math.round(0.25 * (first.sw || 0));
    for (const grp of det.groups) {
      // in the (padded) mask's coordinates; the crop is the photo's
      const cx0 = Math.max(0, grp.x0 - pad), cy0 = Math.max(0, grp.y0 - pad);
      const cx1 = Math.min(MW, grp.x1 + 1 + pad), cy1 = Math.min(MH, grp.y1 + 1 + pad);
      const cw = cx1 - cx0, ch = cy1 - cy0;
      const crop = { x: cx0 - P, y: cy0 - P, w: cw, h: ch };
      let sub = new Uint8Array(cw * ch);
      const want = new Set(grp.labels);
      const tubeSub = tubes ? new Uint8Array(cw * ch) : null;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const gi = (y + cy0) * MW + (x + cx0);
          if (mask[gi] && want.has(det.labels[gi])) {
            sub[y * cw + x] = 1;
            if (tubeSub && tubes[gi]) tubeSub[y * cw + x] = 1;
          }
        }
      }
      const dbg = o.debug ? { crop, w: cw, h: ch, grouped: sub.slice() } : null;
      const rawSub = paintRaw ? ST.extract.cropAny(paintRaw, W, H, crop, 0) : null;
      if (rawSub) for (let i = 0; i < rawSub.length; i++) if (!sub[i]) rawSub[i] = 0;
      // the gap-jump closing's and the defect fill's bridges and pocks
      // stay; their webs over inside corners go (what completion drew is
      // set aside meanwhile)
      if (rawSub && ST.extract) {
        if (tubeSub) for (let i = 0; i < sub.length; i++) if (tubeSub[i] && !rawSub[i]) sub[i] = 0;
        sub = ST.extract.keepBridges(rawSub, sub, cw, ch);
        if (tubeSub) for (let i = 0; i < sub.length; i++) if (tubeSub[i]) sub[i] = 1;
      }
      if (dbg) dbg.bridged = sub.slice();
      let counters = null;
      if (cls) {
        // a throw-up's outline is the letter's; so is a hole showing no wall
        const ol = ST.complete.absorbOutline(sub, cw, ch, cls, W, H, crop.x, crop.y);
        sub = ol.mask; counters = ol.counters;
        sub = ST.complete.fillHiddenHoles(sub, cw, ch, ST.complete.sampler(cls, W, H), crop.x, crop.y);
      }
      // same stroke-width-capped clean-up as click-to-trace and the studio
      const clean = ST.extract
        ? ST.extract.cleanMask(sub, cw, ch, o.smoothing != null ? o.smoothing : 4)
        : ST.raster.fillHoles(ST.raster.close(sub, cw, ch, 1), cw, ch, o.fillHoles);
      if (counters) for (let i = 0; i < clean.length; i++) if (counters[i]) clean[i] = 0;
      if (dbg) { dbg.filled = sub.slice(); dbg.clean = clean; (o.debug.stages || (o.debug.stages = [])).push(dbg); }
      const paths = ST.trace.vectorize(clean, cw, ch, {});
      if (!paths.length) continue;
      candidates.push({ crop, mask: clean, w: cw, h: ch, paths });
    }
    return candidates;
  }

  // The wall's next paint: the most common color that is neither wall nor
  // the paint already read (a white tag beside a red one, a letter in a
  // second color). → its color, or null
  function otherPaint(data, W, H, pm) {
    const R = ST.raster;
    const near = R.dilate(pm.raw, W, H, 3); // the first paint and its rim
    const Q = 12, n = Q * Q * Q;
    const cnt = new Float64Array(n), sr = new Float64Array(n), sg = new Float64Array(n), sb = new Float64Array(n);
    for (let i = 0, p = 0; i < near.length; i++, p += 4) {
      if (pm.wall[i] || near[i]) continue;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const k = ((r * Q) >> 8) * Q * Q + ((g * Q) >> 8) * Q + ((b * Q) >> 8);
      cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
    }
    const minCount = W * H * 0.003;
    let best = null, bestN = 0;
    for (let k = 0; k < n; k++) {
      if (cnt[k] < minCount || cnt[k] <= bestN) continue;
      const c = { r: sr[k] / cnt[k], g: sg[k] / cnt[k], b: sb[k] / cnt[k] };
      if (R.colorDist(c.r, c.g, c.b, pm.bg.r, pm.bg.g, pm.bg.b) < 70) continue;
      if (R.colorDist(c.r, c.g, c.b, pm.seed.r, pm.seed.g, pm.seed.b) < 70) continue;
      best = c; bestN = cnt[k];
    }
    return best;
  }

  // How much of a second paint lies right along the first (within one and a
  // half of its stroke widths): ~1 for its halo, outline or 3D shadow, far
  // less for a letter of its own beside or across it.
  const HUG = 0.85;
  function hugShare(second, pm, W, H) {
    const R = ST.raster;
    const reach = Math.max(6, 1.5 * R.strokeWidth(pm.filled, W, H));
    const off = new Uint8Array(W * H);
    for (let i = 0; i < off.length; i++) off[i] = pm.raw[i] ? 0 : 1;
    const dist = R.distanceTransform(off, W, H, { borderInk: true }); // → nearest first-paint pixel
    let n = 0, near = 0;
    for (let i = 0; i < second.length; i++) if (second[i]) { n++; if (dist[i] <= reach) near++; }
    return n ? near / n : 0;
  }

  // A paint mask for a given paint color (see paintMask), leaving out `not`
  // (the paint already read: a blue letter also stands out from a beige
  // wall along a gray pipe's color axis, and must not come back fused to it).
  function paintFrom(data, W, H, seed, bg, wall, not) {
    const R = ST.raster;
    const sep = R.colorDist(seed.r, seed.g, seed.b, bg.r, bg.g, bg.b);
    if (sep < 60) return null;
    const field = R.blur(R.axisDistMap(data, W, H, seed, bg), W, H, 2);
    const cands = PAINT_TOLERANCES.filter((t) => t <= Math.max(40, sep * 0.55));
    const best = R.edgeOptimalThreshold(field, W, H, cands, 0.002, 0.5);
    if (!best) return null;
    const raw = best.mask;
    if (not) for (let i = 0; i < raw.length; i++) if (not[i]) raw[i] = 0;
    return { raw, filled: ST.extract.absorbDefects(raw, wall, W, H), bg, seed, wall };
  }

  // ---------- which letter is the photo about ----------
  // Each shape is split into its letters (letters.js: its strokes grouped
  // the way the recognizer reads them as single characters), and every
  // letter found is ranked: one that reads clearly as one character, is
  // big, sits near the middle of the photo and wasn't cut off by the frame
  // comes first. A fused word gives each of its letters; the whole shape
  // stays on offer behind them ("Try another shape").
  function recrop(mask, cand, pad) {
    const bb = ST.raster.maskBounds(mask, cand.w, cand.h);
    if (!bb) return null;
    const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
    const x1 = Math.min(cand.w, bb.x1 + 1 + pad), y1 = Math.min(cand.h, bb.y1 + 1 + pad);
    const w = x1 - x0, h = y1 - y0;
    const sub = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sub[y * w + x] = mask[(y + y0) * cand.w + (x + x0)];
    return { crop: { x: cand.crop.x + x0, y: cand.crop.y + y0, w, h }, mask: sub, w, h };
  }

  const INSIDE = 0.6; // see letters.find: a letter's rest this much inside its box is its own
  function findLetters(cands, W, H) {
    if (!cands.length || !ST.letters || !ST.recognize || !ST.recognize.ready()) return cands;

    const diag = Math.hypot(W, H);
    let maxArea = 1, maxTall = 1;
    for (const c of cands) {
      maxArea = Math.max(maxArea, ST.raster.count(c.mask));
      const bb = ST.raster.maskBounds(c.mask, c.w, c.h);
      if (bb) maxTall = Math.max(maxTall, bb.w, bb.h);
    }
    // one score across every shape in the photo (crop px → photo px)
    const rank = (read, mask, w, h, crop) => {
      const bb = ST.raster.maskBounds(mask, w, h);
      if (!bb || !read || !read.ranked.length) return 0;
      const clear = ST.letters.clarity(read);
      // big: ink beside the biggest shape's, and height beside the tallest
      const tall = Math.max(bb.w, bb.h);
      const size = Math.pow(ST.raster.count(mask) / maxArea, 0.3) * Math.pow(Math.min(1, tall / maxTall), 0.5);
      const cx = crop.x + (bb.x0 + bb.x1) / 2, cy = crop.y + (bb.y0 + bb.y1) / 2;
      const d = Math.hypot(cx - W / 2, cy - H / 2) / diag;
      const central = Math.exp(-(d * d) / (2 * 0.22 * 0.22));
      const touches = (crop.x + bb.x0 <= 1) + (crop.y + bb.y0 <= 1) + (crop.x + bb.x1 >= W - 2) + (crop.y + bb.y1 >= H - 2);
      return clear * size * central * (touches ? 0.75 : 1);
    };
    const out = [];
    // the four biggest shapes are read (a shape read before keeps its reading)
    const byArea = cands.map((c) => ({ c, n: ST.raster.count(c.mask) })).sort((a, b) => b.n - a.n);
    byArea.forEach(({ c: cand }, k) => {
      if (k >= 4) { cand.score = 0; out.push(cand); return; }
      if (cand._found === undefined) {
        cand._found = ST.letters.find(cand.mask, cand.w, cand.h, {
          center: { x: W / 2 - cand.crop.x, y: H / 2 - cand.crop.y },
          frame: { x0: -cand.crop.x, y0: -cand.crop.y, x1: W - 1 - cand.crop.x, y1: H - 1 - cand.crop.y },
        });
      }
      const found = cand._found;
      const whole = found ? found.whole : ST.recognize.classify(cand.mask, cand.w, cand.h);
      const wholeRead = whole && { ranked: whole.ranked || whole.top, junk: whole.junk, letterness: whole.letterness };
      // split only when the shape reads as several letters (or none), or a
      // letter inside it reads clearly better than the whole does
      const proper = found ? found.letters.filter((lt) => lt.set.size < found.sc.n) : [];
      // (and not when what it would leave lies inside the letter's own
      // bounds: that is the letter's, however well the rest reads alone)
      const split = proper.some((lt) => lt.explained && lt.inside < INSIDE && ST.letters.better(lt.read, wholeRead));
      if (split) {
        const pad = 10 + Math.round(0.25 * found.sc.sw);
        const top = found.letters.length ? found.letters[0].score : 0;
        for (const lt of found.letters) {
          if (lt.score < 0.12 * top) continue; // too far behind ever to be offered
          const sub = recrop(ST.letters.render(found, cand.mask, cand.w, cand.h, lt), cand, pad);
          if (!sub) continue;
          const paths = ST.trace.vectorize(sub.mask, sub.w, sub.h, {});
          if (!paths.length) continue;
          sub.paths = paths;
          sub.kind = 'letter';
          sub.read = lt.read;
          sub.score = rank(lt.read, sub.mask, sub.w, sub.h, sub.crop);
          out.push(sub);
        }
      }
      cand.read = wholeRead;
      cand.score = rank(wholeRead, cand.mask, cand.w, cand.h, cand.crop) * (split ? 0.5 : 1);
      out.push(cand);
    });
    out.sort((a, b) => b.score - a.score);
    // how far each front runner leans, to stand it up
    for (const c of out.slice(0, 4)) if (c.lean == null) c.lean = ST.letters.lean(c.mask, c.w, c.h);
    return out;
  }
})(typeof window !== 'undefined' ? window : globalThis);
