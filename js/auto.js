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
      const fill = c.area / (bw * bh);
      if (fill < 0.02) return false;                           // pure wisp
      const touchL = c.x0 <= fr.x0 + 1, touchR = c.x1 >= fr.x1 - 1, touchT = c.y0 <= fr.y0 + 1, touchB = c.y1 >= fr.y1 - 1;
      const touches = touchL + touchR + touchT + touchB;
      // spanning the frame, solid: the wall itself, a band across it (a
      // letter shot close spans it too, but as strokes)
      if ((touches >= 4 || bw * bh > imgArea * 0.96) && fill > 0.5) return false;
      // three edges: frame-edge junk (a pole, a doorframe) — or a letter
      // photographed close; the recognizer can tell them apart, so with it
      // they stay (ranked by how letter-like they read)
      if (touches === 3 && !(ST.recognize && ST.recognize.ready())) return false;
      return true;
    });
    kept.sort((a, b) => b.area - a.area);
    kept = kept.slice(0, 6);

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

  /**
   * Run the automatic pipeline on a canvas: the photo shrunk to a working
   * size, its light evened out, its paints read and judged (see
   * auto.inks), the photo flattened by its wall's own lines (rectify.js —
   * never the letters' strokes), and the letters found in the paints that
   * look like letters.
   * Returns { canvas (flattened), angle, rect, candidates: [{crop, paths,
   *   mask, w, h, read, score, kind, lean}] best first }
   */
  auto.processImage = function (srcCanvas, opts) {
    const o = Object.assign({ maxEdge: 800, deskew: true }, opts || {});
    let work = srcCanvas;
    const s = Math.min(1, o.maxEdge / Math.max(work.width, work.height));
    if (s < 1) {
      const c = ST.makeCanvas(Math.round(work.width * s), Math.round(work.height * s));
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(work, 0, 0, c.width, c.height);
      scaleInPhoto(work, c);
      work = c;
    }
    let W = work.width, H = work.height;
    // the photo's pixels with the wall's light evened out (extract.flatField)
    let flat = ST.extract.flatData(work);
    let read = auto.inks(flat.data, W, H, { inPhoto: work._inPhoto || null });
    // flattened: the wall's own lines made parallel and square (only on a
    // photo not flattened before — a re-read or a crop comes in flat)
    let rect = null;
    if (o.deskew && ST.rectify && read) {
      // (the letters' own strokes never vote: every shape of every paint
      // that looks like strokes is kept out — not the paints' other shapes,
      // a sky, a sign's print, a panel)
      const exclude = new Uint8Array(W * H);
      for (const ink of read.inks) {
        // (a strip from one side of the photo to the other — a post's metal
        // edge, a pipe — is the wall's, however stroke-like)
        const keep = new Set(ink.comps.filter((c) => c.score >= 0.3 && c.touch < 2).map((c) => c.L));
        if (!keep.size) continue;
        for (let i = 0; i < exclude.length; i++) {
          if (ink.raw[i] && keep.has(ink.shapeLabels[((i / W | 0) >> 1) * ink.shapeW + ((i % W) >> 1)])) exclude[i] = 1;
        }
      }
      rect = ST.rectify.estimate(flat.data, W, H, { exclude: ST.raster.dilate(exclude, W, H, Math.round(0.012 * Math.max(W, H))) });
      if (rect) {
        rect.srcW = W; rect.srcH = H;
        work = ST.rectify.warp(work, rect, read.bg);
        W = work.width; H = work.height;
        flat = ST.extract.flatData(work);
        read = auto.inks(flat.data, W, H, { inPhoto: work._inPhoto || null });
      }
    }
    const env = { img: { data: flat.data, width: W, height: H }, W, H, area: W * H, work, o };
    // the paints that look like letters (a halo, an outline or a 3D shadow
    // hugging another paint's strokes is that paint's, and not read alone)
    let candidates = [];
    if (read && read.inks.length) {
      // a paint inside another's outline is the same letter (a throw-up:
      // its fill and the outline round it)
      const top = read.inks.slice(0, 4);
      for (const A of top) {
        if (A.merged) continue;
        // (an outline with a break in it — a glint across it — still rings
        // what it rings)
        const closed = ST.raster.fillHoles(ST.raster.close(A.raw, W, H, Math.max(2, Math.round(0.02 * Math.max(W, H)))), W, H, 1);
        for (const B of top) {
          if (B === A || B.merged) continue;
          let n = 0, inn = 0, nA = 0;
          for (let i = 0; i < B.raw.length; i++) { if (A.raw[i]) nA++; if (B.raw[i]) { n++; if (closed[i] && !A.raw[i]) inn++; } }
          // (a fill of its own: not a sliver, and not a tone between the
          // outline's paint and the wall — that is the outline's soft edge —
          // nor a paint far stronger than the "outline": then the outline is
          // that paint's bleed halo, a pale ring round a marker stroke, and
          // the stroke is the letter)
          const ax = A.seed.r - A.bg.r, ay = A.seed.g - A.bg.g, az = A.seed.b - A.bg.b;
          const u = ((B.seed.r - A.bg.r) * ax + (B.seed.g - A.bg.g) * ay + (B.seed.b - A.bg.b) * az) / (ax * ax + ay * ay + az * az || 1);
          if (n < 0.05 * nA || (u > 0.15 && u < 0.85) || u > 1.3) continue;
          if (n && inn >= 0.8 * n) {
            for (let i = 0; i < B.raw.length; i++) if (B.raw[i]) A.raw[i] = 1;
            B.merged = true;
            A.outlined = true; // a throw-up: its counters show the wall (see build)
          }
        }
      }
      read.inks = read.inks.filter((k) => !k.merged);
      const best = read.inks[0].score;
      const kept = [];
      // (of two paints that hug, the paler — a shade between the wall and
      // the other, its bleed halo — gives way, whichever scored higher: a
      // halo's long ring looks like strokes too)
      const paler = (P, Q) => {
        const ax = Q.seed.r - Q.bg.r, ay = Q.seed.g - Q.bg.g, az = Q.seed.b - Q.bg.b;
        const u = ((P.seed.r - Q.bg.r) * ax + (P.seed.g - Q.bg.g) * ay + (P.seed.b - Q.bg.b) * az) / (ax * ax + ay * ay + az * az || 1);
        return u > -0.1 && u < 0.6;
      };
      for (const ink of read.inks) {
        if (kept.length >= 3 || ink.score < Math.max(0.2, 0.3 * best)) continue;
        const k = kept.findIndex((q) => hugShare(ink.raw, q, W, H) >= HUG || hugShare(q.raw, ink, W, H) >= HUG);
        if (k >= 0) { if (paler(kept[k], ink)) kept[k] = ink; continue; }
        kept.push(ink);
      }
      for (const ink of kept) {
        // pocks, cracks and dirt inside the paint read as paint
        ink.filled = ST.extract.absorbDefects(ink.raw, ink.wall, W, H);
        candidates = candidates.concat(shapesOf(ink, env));
      }
    }
    if (!candidates.length) {
      // nothing reads as paint on a wall: dark on light, or light on dark
      const gray = ST.raster.luma(flat.data, W, H);
      const blurred = ST.raster.blur(gray, W, H, 2);
      const g8 = new Uint8Array(W * H);
      let mean = 0;
      for (let i = 0; i < g8.length; i++) { g8[i] = Math.max(0, Math.min(255, Math.round(blurred[i]))); mean += g8[i]; }
      mean /= g8.length;
      const t = ST.raster.otsu(g8, null);
      const tryPolarity = (invert) => {
        const mask = ST.raster.open(ST.raster.maskFromLuma(g8, null, t, invert), W, H, 1);
        return build({ mask, det: detectCandidates(mask, W, H, W * H) }, env);
      };
      candidates = tryPolarity(mean <= 128);
      if (!candidates.length) candidates = tryPolarity(mean > 128);
    }
    const shapes = candidates.slice();
    if (!o.noLetters) {
      candidates = findLetters(candidates, W, H);
      for (const c of candidates) delete c._found; // stroke models are big: not kept with the queue
    }
    return { canvas: work, angle: rect ? rect.tilt : 0, rect: rect ? { tilt: rect.tilt, keystone: rect.keystone, H: rect.H, srcW: rect.srcW, srcH: rect.srcH } : null, candidates, shapes, backdrop: read ? read.backdrop : null };
  };

  /**
   * A click on a thin stroke, traced as a line: the pixels brighter (or
   * darker) than what is round them and narrower than a couple of percent
   * of the photo (a top-hat), whatever their color, joined across the
   * small gaps a scratchy marker leaves, from the stroke under the click.
   * A tag in a marker whose color wanders along the stroke — dim and
   * tinged where it is thin, white where it is thick — is one line to the
   * eye, and one here; a color flood stops where the color turns, or leaks
   * into a wall of that color. → { mask, crop, w, h } (the whole stroke
   * shape, cleaned) or null when no line runs under the click.
   */
  auto.clickStroke = function (data, W, H, x, y, backdrop) {
    const R = ST.raster, N = W * H;
    const rr = Math.max(3, Math.round(0.012 * Math.max(W, H)));
    const Lm = new Float32Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) Lm[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    const cx = Math.round(x), cy = Math.round(y);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;
    // which way the line stands out: the stronger at the click
    const opened = R.maxFilter(R.minFilter(Lm, W, H, rr), W, H, rr);
    const closedL = R.minFilter(R.maxFilter(Lm, W, H, rr), W, H, rr);
    // (a click meant for a thin stroke lands a few pixels off it as often
    // as on it)
    const reach = Math.max(6, Math.round(0.015 * Math.max(W, H)));
    let bb = 0, bd = 0;
    for (let yy = Math.max(0, cy - reach); yy <= Math.min(H - 1, cy + reach); yy++) {
      for (let xx = Math.max(0, cx - reach); xx <= Math.min(W - 1, cx + reach); xx++) {
        const i = yy * W + xx;
        bb = Math.max(bb, Lm[i] - opened[i]); bd = Math.max(bd, closedL[i] - Lm[i]);
      }
    }
    const bright = bb >= bd, peak = Math.max(bb, bd);
    if (peak < 25) return null;
    const th = new Float32Array(N);
    for (let i = 0; i < N; i++) th[i] = bright ? Lm[i] - opened[i] : closedL[i] - Lm[i];
    // the level: well down from how strongly the clicked line stands out —
    // and fainter still where the line goes on from there (hysteresis: a
    // marker running thin for a stretch is the same stroke, a faint fleck
    // on its own is nothing)
    const T = Math.max(14, 0.3 * peak), Tlow = Math.max(9, 0.14 * peak);
    let m = new Uint8Array(N);
    const weak = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (th[i] > T) m[i] = 1; else if (th[i] > Tlow) weak[i] = 1;
    }
    // (a panel's edge, a sign's border, a pipe: a dead-straight line across
    // much of the photo is the wall's, not a hand's — cut along it)
    if (ST.rectify) {
      const D = Math.max(W, H);
      for (const q of ST.rectify.segments(R.blur(Lm, W, H, 1), W, H, { minLen: 0.4 * D })) {
        const L = Math.hypot(q.x2 - q.x1, q.y2 - q.y1), n = Math.ceil(L), rad = Math.max(2, Math.round(0.8 * rr));
        for (let k = 0; k <= n; k++) {
          const px = Math.round(q.x1 + ((q.x2 - q.x1) * k) / n), py = Math.round(q.y1 + ((q.y2 - q.y1) * k) / n);
          for (let yy = Math.max(0, py - rad); yy <= Math.min(H - 1, py + rad); yy++) {
            for (let xx = Math.max(0, px - rad); xx <= Math.min(W - 1, px + rad); xx++) { const i = yy * W + xx; m[i] = 0; weak[i] = 0; }
          }
        }
      }
    }
    // (and one running frame to frame — a panel's ragged top edge, a sign's
    // border: rows or columns of line reaching both sides of the photo)
    // (judged at one level for the whole photo, whatever was clicked: a
    // fainter click must not find more of the wall's edge a line)
    {
      const hist = new Uint32Array(256);
      for (let i = 0; i < N; i++) hist[Math.max(0, Math.min(255, th[i] | 0))]++;
      let acc = 0, p99 = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.99 * N) { p99 = v; break; } }
      const Tb = Math.max(12, 0.14 * p99);
      const edge = Math.max(3, Math.round(0.03 * Math.max(W, H)));
      const rowBand = new Uint8Array(H), colBand = new Uint8Array(W);
      for (let y = 0; y < H; y++) {
        let n = 0, lo = W, hi = -1;
        for (let x = 0; x < W; x++) if (th[y * W + x] > Tb) { n++; if (x < lo) lo = x; hi = x; }
        if (n >= 0.45 * W && lo <= edge && hi >= W - 1 - edge) rowBand[y] = 1;
      }
      for (let x = 0; x < W; x++) {
        let n = 0, lo = H, hi = -1;
        for (let y = 0; y < H; y++) if (th[y * W + x] > Tb) { n++; if (y < lo) lo = y; hi = y; }
        if (n >= 0.45 * H && lo <= edge && hi >= H - 1 - edge) colBand[x] = 1;
      }
      const pad = Math.max(2, Math.round(rr / 2));
      const grow = (band, len) => { const o = new Uint8Array(len); for (let k = 0; k < len; k++) if (band[k]) for (let d = -pad; d <= pad; d++) if (k + d >= 0 && k + d < len) o[k + d] = 1; return o; };
      const rb = grow(rowBand, H), cb = grow(colBand, W);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rb[y] || cb[x]) { m[y * W + x] = 0; weak[y * W + x] = 0; }
    }
    m = R.open(m, W, H, 1);
    {
      const q = new Int32Array(N);
      let qh = 0, qt = 0;
      for (let i = 0; i < N; i++) if (m[i]) q[qt++] = i;
      while (qh < qt) {
        const i = q[qh++], x0 = i % W;
        for (const j of [x0 > 0 ? i - 1 : -1, x0 < W - 1 ? i + 1 : -1, i - W, i + W]) {
          if (j < 0 || j >= N || !weak[j] || m[j]) continue;
          m[j] = 1; q[qt++] = j;
        }
      }
    }
    // a scratchy marker's breaks
    const joined = R.close(m, W, H, Math.max(2, Math.round(rr / 3)));
    let at = -1, best = Infinity;
    for (let yy = Math.max(0, cy - 2 * reach); yy <= Math.min(H - 1, cy + 2 * reach); yy++) {
      for (let xx = Math.max(0, cx - 2 * reach); xx <= Math.min(W - 1, cx + 2 * reach); xx++) {
        const i = yy * W + xx;
        if (!joined[i]) continue;
        const d = (xx - cx) * (xx - cx) + (yy - cy) * (yy - cy);
        if (d < best) { best = d; at = i; }
      }
    }
    if (at < 0) return null;
    const piece = R.floodFrom(W, H, at % W, (at / W) | 0, (i) => joined[i] === 1);
    if (piece.count < 0.001 * N || piece.count > 0.25 * N) return null;
    const bbx = R.maskBounds(piece.mask, W, H);
    const pad = 10;
    const crop = { x: Math.max(0, bbx.x0 - pad), y: Math.max(0, bbx.y0 - pad) };
    crop.w = Math.min(W, bbx.x1 + 1 + pad) - crop.x; crop.h = Math.min(H, bbx.y1 + 1 + pad) - crop.y;
    const sub = new Uint8Array(crop.w * crop.h);
    for (let yy = 0; yy < crop.h; yy++) for (let xx = 0; xx < crop.w; xx++) sub[yy * crop.w + xx] = piece.mask[(yy + crop.y) * W + xx + crop.x];
    const clean = ST.extract.cleanMask(sub, crop.w, crop.h, 4);
    const paths = ST.trace.vectorize(clean, crop.w, crop.h, {});
    if (!paths.length) return null;
    return { crop, mask: clean, w: crop.w, h: crop.h, paths, kind: 'whole' };
  };

  // The letter in a shape that holds the stroke at (x, y) (photo px): its
  // neighbors fused on taken off (letters.find) → [letter?, whole]
  function lettersAt(c, x, y) {
    const at = { x: x - c.crop.x, y: y - c.crop.y };
    const out = [];
    const whole = { crop: c.crop, mask: c.mask, w: c.w, h: c.h, paths: c.paths, kind: 'whole' };
    if (ST.letters && ST.recognize && ST.recognize.ready()) {
      // (a click names the stroke the search starts from: a shape in many
      // pieces — a tag with a ragged panel edge fused onto it — is fine)
      const found = ST.letters.find(c.mask, c.w, c.h, { center: at, must: at, budget: 150, maxPieces: 90 });
      const lt = found && found.letters[0];
      const wholeRead = found ? { ranked: found.whole.top, letterness: found.whole.letterness } : null;
      // (a click says which letter: what it leaves need not read as letters
      // too, when the letter reads plainly and the whole shape doesn't — a
      // smear it touches, a panel's edge)
      const plain = lt && ST.letters.clarity(lt.read) >= 0.6 && ST.letters.clarity(wholeRead) < 0.5;
      if (lt && lt.set.size < found.sc.n && (lt.explained || plain) && lt.inside < INSIDE && ST.letters.better(lt.read, wholeRead)) {
        const sub = recrop(ST.letters.render(found, c.mask, c.w, c.h, lt), c, 10 + Math.round(0.25 * found.sc.sw));
        if (sub) {
          sub.paths = ST.trace.vectorize(sub.mask, sub.w, sub.h, {});
          if (sub.paths.length) { sub.kind = 'letter'; sub.read = lt.read; out.push(sub); }
        }
      }
      whole.read = wholeRead || (() => { const r = ST.recognize.classify(c.mask, c.w, c.h); return r && { ranked: r.ranked, letterness: r.letterness }; })();
    }
    out.push(whole);
    for (const k of out) k.lean = ST.letters ? ST.letters.lean(k.mask, k.w, k.h) : 0;
    return out;
  }

  /**
   * A click on the photo, answered from its analysis (the shapes the
   * automatic pass already found, cleaned and traced): the shape under the
   * click (or the nearest within reach), and in it the letter that holds
   * the stroke clicked — its neighbors fused on taken off. No regrowing:
   * the click only says which shape and which stroke.
   * → { candidates: [letter?, whole], click } or null (no shape there: the
   * caller grows one from the click instead, see extract.seeded)
   */
  auto.clickLetter = function (shapes, W, H, x, y, data, backdrop) {
    const reach = Math.max(8, Math.round(0.02 * Math.max(W, H)));
    let best = null, bd = Infinity;
    for (const c of shapes || []) {
      const lx = Math.round(x - c.crop.x), ly = Math.round(y - c.crop.y);
      if (lx < -reach || ly < -reach || lx >= c.w + reach || ly >= c.h + reach) continue;
      for (let yy = Math.max(0, ly - reach); yy <= Math.min(c.h - 1, ly + reach); yy++) {
        for (let xx = Math.max(0, lx - reach); xx <= Math.min(c.w - 1, lx + reach); xx++) {
          if (!c.mask[yy * c.w + xx]) continue;
          const d = (xx - lx) * (xx - lx) + (yy - ly) * (yy - ly);
          if (d < bd) { bd = d; best = { c, x: xx + c.crop.x, y: yy + c.crop.y }; }
        }
      }
    }
    // and the stroke under the click traced as a line (a thin marker tag
    // the analysis read in bits, or not at all)
    const line = data ? auto.clickStroke(data, W, H, x, y, backdrop) : null;
    if (!best && !line) return null;
    const cover = (big, small) => {
      // how much of `small` lies in `big`
      let n = 0, inn = 0;
      for (let yy = 0; yy < small.h; yy++) {
        for (let xx = 0; xx < small.w; xx++) {
          if (!small.mask[yy * small.w + xx]) continue;
          n++;
          const bx = xx + small.crop.x - big.crop.x, by = yy + small.crop.y - big.crop.y;
          if (bx >= 0 && by >= 0 && bx < big.w && by < big.h && big.mask[by * big.w + bx]) inn++;
        }
      }
      return n ? inn / n : 0;
    };
    const area = (c) => c.crop.w * c.crop.h;
    let out;
    // the line wins when it holds the analysis's shape and reaches well past
    // it (the shape was a bit of the tag); else the shape comes first
    if (line && (!best || (area(line) >= 1.3 * area(best.c) && cover(line, best.c) >= 0.6))) {
      out = lettersAt(line, x, y);
      if (best) out = out.concat(lettersAt(best.c, best.x, best.y));
    } else {
      out = lettersAt(best.c, best.x, best.y);
      if (line && cover(best.c, line) < 0.8) out = out.concat(lettersAt(line, x, y));
    }
    return { candidates: out, click: best ? { x: best.x, y: best.y } : { x: Math.round(x), y: Math.round(y) } };
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
    return build({ mask: m, det, P, MW, MH, tubes, sw, paintRaw: pm.raw, cls, outlined: !!pm.outlined }, env);
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
        sub = ST.complete.fillHiddenHoles(sub, cw, ch, ST.complete.sampler(cls, W, H), crop.x, crop.y, { data: env.img.data, W, H });
      }
      if (cls && first.outlined) {
        // a hole that shows bare wall, bigger than a stroke is wide, is a
        // counter: the clean-up must not fill it (a throw-up's counters, its
        // outline read as one paint with its fill)
        const sw0 = first.sw || ST.raster.strokeWidth(sub, cw, ch);
        const inv = new Uint8Array(cw * ch);
        for (let i = 0; i < inv.length; i++) inv[i] = sub[i] ? 0 : 1;
        const hc = ST.raster.components(inv, cw, ch);
        const edge = new Uint8Array(hc.sizes.length), wallN = new Int32Array(hc.sizes.length);
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            const L = hc.labels[y * cw + x];
            if (!L) continue;
            if (x === 0 || y === 0 || x === cw - 1 || y === ch - 1) edge[L] = 1;
            const px = x + crop.x, py = y + crop.y;
            if (px >= 0 && py >= 0 && px < W && py < H && cls[py * W + px] === ST.complete.WALL) wallN[L]++;
          }
        }
        const minA = Math.pow(0.4 * sw0, 2);
        for (let L = 1; L < hc.sizes.length; L++) {
          if (edge[L] || hc.sizes[L] < minA || wallN[L] < 0.6 * hc.sizes[L]) continue;
          if (!counters) counters = new Uint8Array(cw * ch);
          for (let i = 0; i < inv.length; i++) if (hc.labels[i] === L) counters[i] = 1;
        }
      }
      // same stroke-width-capped clean-up as click-to-trace and the studio
      let clean = ST.extract
        ? ST.extract.cleanMask(sub, cw, ch, o.smoothing != null ? o.smoothing : 4)
        : ST.raster.fillHoles(ST.raster.close(sub, cw, ch, 1), cw, ch, o.fillHoles);
      if (counters) for (let i = 0; i < clean.length; i++) if (counters[i]) clean[i] = 0;
      clean = dropBlobs(clean, cw, ch);
      if (dbg) { dbg.filled = sub.slice(); dbg.clean = clean; (o.debug.stages || (o.debug.stages = [])).push(dbg); }
      const paths = ST.trace.vectorize(clean, cw, ch, {});
      if (!paths.length) continue;
      candidates.push({ crop, mask: clean, w: cw, h: ch, paths });
    }
    return candidates;
  }

  // Blobs off a letter drawn in strokes: a pool of paint where a drip
  // landed, a splat, a sticker in the same color — a part far wider than
  // the pen that drew the rest. An opening wider than the pen keeps only
  // such parts; one hanging off the shape (not most of it) is taken off,
  // and what held the letter stays whole. A fat letter (a throw-up, a
  // bubble letter) is all "blob" and left as it is.
  function dropBlobs(mask, w, h) {
    const R = ST.raster;
    // (the pen's width read the way the clean-up reads it: a pocked or
    // crinkled stroke — silver — with its pocks filled)
    const rib = R.strokeWidth(mask, w, h), sol = ST.extract.solidWidth(mask, w, h);
    const sw = rib < 0.5 * sol ? 0.9 * sol : rib;
    const bb = R.maskBounds(mask, w, h);
    if (!(sw > 3) || !bb || sw > 0.15 * Math.max(bb.w, bb.h)) return mask;
    const opened = R.open(mask, w, h, Math.round(1.1 * sw));
    const total = R.count(mask);
    const core = R.count(opened);
    if (!core || core > 0.4 * total) return mask;
    // the blob with its rim, within the shape
    const blob = R.dilate(opened, w, h, Math.max(2, Math.round(0.3 * sw)));
    const rest = new Uint8Array(mask.length);
    for (let i = 0; i < rest.length; i++) rest[i] = mask[i] && !blob[i] ? 1 : 0;
    const { labels, sizes } = R.components(rest, w, h);
    let big = 0;
    for (let L = 1; L < sizes.length; L++) if (sizes[L] > sizes[big] || !big) big = L;
    if (!big || sizes[big] < 0.55 * total) return mask;
    // (the letter: its biggest piece and the pieces that were its own — not
    // only held on through the blob)
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < out.length; i++) if (labels[i] === big) out[i] = 1;
    // a blob hangs off the letter: taking it off opens no hole in it
    const holes = (m) => { const inv = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1; return R.components(inv, w, h).sizes.length; };
    if (holes(out) > holes(mask)) return mask;
    return out;
  }

  // How much of a second paint lies right along the first (within one and a
  // half of its stroke widths): ~1 for its halo, outline or 3D shadow, far
  // less for a letter of its own beside or across it.
  const HUG = 0.85;
  function hugShare(second, pm, W, H) {
    const R = ST.raster;
    const reach = Math.max(6, 1.5 * R.strokeWidth(pm.raw, W, H));
    const off = new Uint8Array(W * H);
    for (let i = 0; i < off.length; i++) off[i] = pm.raw[i] ? 0 : 1;
    const dist = R.distanceTransform(off, W, H, { borderInk: true }); // → nearest first-paint pixel
    let n = 0, near = 0;
    for (let i = 0; i < second.length; i++) if (second[i]) { n++; if (dist[i] <= reach) near++; }
    return n ? near / n : 0;
  }

  // ---------- the paints on the wall ----------
  // A photo of graffiti holds several paints — the tag, the letters it was
  // written over, a sticker, the pocks of the concrete, a sign — and the
  // one that stands out most is often not the letters (dark pocks on pale
  // concrete contrast more than red paint does). So every paint is read,
  // and the ones whose shapes look like letters go on:
  //
  //   1. what is not wall is clustered by color (k-means), and clusters that
  //      are one paint's shades — lying along one line from the wall's color,
  //      a spray's thin edge, silver's glint and shade — are one paint;
  //   2. each paint's mask is its distance along the wall→paint axis,
  //      thresholded where its edges are sharpest; a pixel two paints both
  //      claim goes to the nearer;
  //   3. each mask is judged on its shapes: strokes (long for their width),
  //      letter-sized, neither a solid patch (a sticker, a sign) nor a sprawl
  //      off the edges (a wall's other shade, a door, the sky).
  //
  // → { bg, wall, wallTol, local, inks: [{ seed, raw, filled, t, score,
  //   comps }] best first } or null
  function kmeans(pts, k, iters) {
    const n = pts.length / 3;
    if (n < k) return null;
    const C = new Float64Array(k * 3);
    // k-means++: spread the first centers over the colors present
    const d2 = new Float64Array(n).fill(Infinity);
    let pick = 0;
    for (let c = 0; c < k; c++) {
      C[c * 3] = pts[pick * 3]; C[c * 3 + 1] = pts[pick * 3 + 1]; C[c * 3 + 2] = pts[pick * 3 + 2];
      let tot = 0;
      for (let i = 0; i < n; i++) {
        const dx = pts[i * 3] - C[c * 3], dy = pts[i * 3 + 1] - C[c * 3 + 1], dz = pts[i * 3 + 2] - C[c * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < d2[i]) d2[i] = d;
        tot += d2[i];
      }
      // deterministic: the point at the tot/2 mark of the cumulative spread
      let acc = 0, want = tot * (0.37 + 0.13 * c) % tot;
      for (let i = 0; i < n; i++) { acc += d2[i]; if (acc >= want) { pick = i; break; } }
    }
    const lab = new Uint8Array(n), cnt = new Float64Array(k), S = new Float64Array(k * 3);
    for (let it = 0; it < iters; it++) {
      cnt.fill(0); S.fill(0);
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const dx = pts[i * 3] - C[c * 3], dy = pts[i * 3 + 1] - C[c * 3 + 1], dz = pts[i * 3 + 2] - C[c * 3 + 2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = c; }
        }
        lab[i] = best; cnt[best]++;
        S[best * 3] += pts[i * 3]; S[best * 3 + 1] += pts[i * 3 + 1]; S[best * 3 + 2] += pts[i * 3 + 2];
      }
      for (let c = 0; c < k; c++) if (cnt[c]) { C[c * 3] = S[c * 3] / cnt[c]; C[c * 3 + 1] = S[c * 3 + 1] / cnt[c]; C[c * 3 + 2] = S[c * 3 + 2] / cnt[c]; }
    }
    return { C, cnt };
  }
  // A color's hue in degrees, or null when it has too little color to
  // have one (white, black, grays, silver)
  function hueOf(c) {
    const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b), d = mx - mn;
    if (d < 40 && d < 0.35 * mx) return null;
    let h;
    if (mx === c.r) h = ((c.g - c.b) / d) % 6;
    else if (mx === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }
  // (weights of the redmean distance, about mid-gray: Euclidean distance in
  // this space is close to raster.colorDist)
  const WR = 1.5, WG = 2, WB = 1.6;

  // The stroke-likeness of a mask's shapes, read at half size: per shape
  // its area, outline, box — and from those its stroke width (twice the
  // area over the outline), its length (area over width), how long it is
  // for its width, and how much of its box it fills.
  function shapeStats(mask, W, H) {
    const w = Math.ceil(W / 2), h = Math.ceil(H / 2);
    const raw = new Uint8Array(w * h);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) raw[(y >> 1) * w + (x >> 1)] = 1;
    // scratchy, streaky paint reads as the strokes it makes
    const m = ST.raster.close(raw, w, h, 2);
    const { labels, sizes } = ST.raster.components(m, w, h);
    // the stroke's width from inside it (the distance to its edge), which a
    // ragged outline doesn't fool: a ribbon's mean distance is a quarter of
    // its width
    const dt = ST.raster.distanceTransform(m, w, h);
    const n = sizes.length;
    const dsum = new Float64Array(n), rawN = new Int32Array(n);
    const x0 = new Int32Array(n).fill(w), y0 = new Int32Array(n).fill(h), x1 = new Int32Array(n).fill(-1), y1 = new Int32Array(n).fill(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, L = labels[i];
        if (!L) continue;
        dsum[L] += dt[i];
        if (raw[i]) rawN[L]++;
        if (x < x0[L]) x0[L] = x; if (x > x1[L]) x1[L] = x;
        if (y < y0[L]) y0[L] = y; if (y > y1[L]) y1[L] = y;
      }
    }
    const D = Math.max(w, h);
    const out = [];
    for (let L = 1; L < n; L++) {
      const area = sizes[L];
      if (area < 0.0006 * w * h) continue;
      const bw = x1[L] - x0[L] + 1, bh = y1[L] - y0[L] + 1;
      const sw = Math.max(1, (4 * dsum[L]) / area);
      const len = area / sw;
      const touch = (x0[L] <= 0) + (y0[L] <= 0) + (x1[L] >= w - 1) + (y1[L] >= h - 1);
      out.push({ L, area: area * 4, sw: sw * 2, len: len * 2, elong: len / sw, size: Math.max(bw, bh) / D, fill: area / (bw * bh), touch,
        // how much of the shape is paint, not the gaps between specks the
        // closing bridged: an overspray's mist or a wall's grain is sparse
        density: rawN[L] / area,
        box: { x0: x0[L] * 2, y0: y0[L] * 2, x1: x1[L] * 2 + 1, y1: y1[L] * 2 + 1 } });
    }
    out.labels = labels; out.w = w; out.h = h; // (which half-size pixel is which shape)
    return out;
  }
  // How much one shape looks like a letter's strokes (0..1)
  function strokeScore(s) {
    const ramp = (v, a, b) => Math.max(0, Math.min(1, (v - a) / (b - a)));
    const elong = ramp(s.elong, 2.5, 8);
    const size = ramp(s.size, 0.05, 0.22) * (s.size > 1.05 ? 0.5 : 1);
    const fill = s.fill > 0.5 ? Math.max(0, (0.85 - s.fill) / 0.35) : 1;
    const touch = [1, 0.85, 0.5, 0.15, 0][s.touch];
    const dense = ramp(s.density, 0.5, 0.8);
    return elong * size * fill * touch * dense;
  }
  auto.strokeScore = strokeScore;

  auto.inks = function (data, W, H, opts) {
    const o = opts || {};
    const R = ST.raster, X = ST.extract;
    const inPhoto = o.inPhoto || null;
    const N = W * H;
    // 1. the photo's colors, all of them — walls, panels, the sky, paints
    const step = Math.max(1, Math.round(Math.sqrt(N / 40000)));
    const pts = [];
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const i = y * W + x;
        if (inPhoto && !inPhoto[i]) continue;
        const p = i * 4;
        pts.push(data[p] * WR, data[p + 1] * WG, data[p + 2] * WB);
      }
    }
    const K = 8;
    const km = kmeans(Float64Array.from(pts), K, 10);
    if (!km) return null;
    // shades of one color are one color (a wall lit unevenly, a paint's
    // glint and its body)
    const par = Array.from({ length: K }, (_, k) => k);
    const find = (k) => { while (par[k] !== k) k = par[k] = par[par[k]]; return k; };
    const cdist = (a, b) => Math.hypot(km.C[a * 3] - km.C[b * 3], km.C[a * 3 + 1] - km.C[b * 3 + 1], km.C[a * 3 + 2] - km.C[b * 3 + 2]);
    for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) if (km.cnt[a] && km.cnt[b] && cdist(a, b) < 48) par[find(a)] = find(b);
    // every pixel to its nearest color
    const lab = new Uint8Array(N).fill(255);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      if (inPhoto && !inPhoto[i]) continue;
      const r = data[p] * WR, g2 = data[p + 1] * WG, b = data[p + 2] * WB;
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        if (!km.cnt[k]) continue;
        const d = (r - km.C[k * 3]) ** 2 + (g2 - km.C[k * 3 + 1]) ** 2 + (b - km.C[k * 3 + 2]) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      lab[i] = find(best);
    }
    // colors that are one surface's shades — near each other and woven
    // together (brick and its mortar, a wall in and out of shadow): a
    // color shares a long border with its other shades, where two paints,
    // or a paint and its wall, meet only along the paint's edge
    {
      const tb = new Map(), tot = new Map(), q = 2;
      for (let y = q; y < H; y += q) {
        for (let x = q; x < W; x += q) {
          const a = lab[y * W + x];
          if (a === 255) continue;
          for (const b of [lab[y * W + x - q], lab[(y - q) * W + x]]) {
            if (b === 255) continue;
            if (a === b) continue;
            tot.set(a, (tot.get(a) || 0) + 1); tot.set(b, (tot.get(b) || 0) + 1);
            const k = Math.min(a, b) * 256 + Math.max(a, b);
            tb.set(k, (tb.get(k) || 0) + 1);
          }
        }
      }
      let merged = false;
      for (const [k, n] of tb) {
        const a = k >> 8, b = k & 255;
        if (find(a) === find(b) || cdist(a, b) >= 72) continue;
        // (the share of either color's border that it shares with the other)
        if (n >= 0.3 * Math.min(tot.get(a) || 1, tot.get(b) || 1)) { par[find(a)] = find(b); merged = true; }
      }
      if (merged) for (let i = 0; i < N; i++) if (lab[i] !== 255) lab[i] = find(lab[i]);
    }
    // the groups: their mean color, share of the photo and of its border
    const G = new Map();
    const m = Math.max(3, Math.round(Math.min(W, H) * 0.06));
    let total = 0, ringTotal = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, L = lab[i];
        if (L === 255) continue;
        let gr = G.get(L);
        if (!gr) { gr = { id: L, n: 0, r: 0, g: 0, b: 0, ring: 0 }; G.set(L, gr); }
        const p = i * 4;
        gr.n++; gr.r += data[p]; gr.g += data[p + 1]; gr.b += data[p + 2];
        total++;
        if (x < m || y < m || x >= W - m || y >= H - m) { gr.ring++; ringTotal++; }
      }
    }
    const groups = Array.from(G.values()).filter((gr) => gr.n > 0);
    for (const gr of groups) {
      gr.color = { r: gr.r / gr.n, g: gr.g / gr.n, b: gr.b / gr.n };
      gr.share = gr.n / Math.max(1, total);
      gr.ringShare = gr.ring / Math.max(1, ringTotal);
    }
    // 2. which are surfaces: big, and not stroke-shaped (or most of the
    // photo's border) — the rest may be paint
    const maskOf = (id) => { const mk = new Uint8Array(N); for (let i = 0; i < N; i++) if (lab[i] === id) mk[i] = 1; return mk; };
    for (const gr of groups) {
      if (gr.share < 0.06) { gr.surface = false; continue; }
      const st = shapeStats(maskOf(gr.id), W, H);
      let top = 0, big = null;
      for (const c of st) { top = Math.max(top, strokeScore(c)); if (!big || c.area > big.area) big = c; }
      gr.strokey = top;
      gr.stats = st;
      // (a panel the letters on it cut holes in still fills its box)
      // (a surface runs off the photo: a color wholly inside the frame is
      // something on the wall — a throw-up's solid letter, a sticker — and
      // judged by its shape as paint; a panel meets the edge, and fills its
      // box however many letters are cut out of it)
      const edge = st.some((c) => c.touch >= 1 && c.area >= 0.3 * gr.n);
      gr.surface = gr.ringShare >= 0.3 || (edge && (top < 0.4 || (big && big.fill >= 0.55 && big.size >= 0.3)));
    }
    if (!groups.some((gr) => gr.surface)) groups.reduce((a, b) => (b.ringShare > a.ringShare ? b : a)).surface = true;
    const surfaces = groups.filter((gr) => gr.surface);
    const main = surfaces.reduce((a, b) => (b.ringShare + b.share > a.ringShare + a.share ? b : a));
    // which surface each color lies on: the one it borders most (read at
    // quarter size)
    const touch = new Map();
    const q = 3;
    for (let y = q; y < H; y += q) {
      for (let x = q; x < W; x += q) {
        const a = lab[y * W + x];
        for (const b of [lab[y * W + x - q], lab[(y - q) * W + x]]) {
          if (a === b || a === 255 || b === 255) continue;
          const k1 = a * 256 + b, k2 = b * 256 + a;
          touch.set(k1, (touch.get(k1) || 0) + 1); touch.set(k2, (touch.get(k2) || 0) + 1);
        }
      }
    }
    const surfaceOf = (gr, not) => {
      let best = null, bn = 0;
      for (const s of surfaces) { if (s === not) continue; const n = touch.get(gr.id * 256 + s.id) || 0; if (n > bn) { bn = n; best = s; } }
      return best || (main !== not ? main : surfaces.find((s) => s !== not) || main);
    };
    // each surface's own spread: its tolerance as wall
    const tolOf = new Map();
    const wallTolOf = (s) => {
      if (tolOf.has(s.id)) return tolOf.get(s.id);
      const vals = [];
      for (let i = 0; i < N; i += 7) if (lab[i] === s.id) { const p = i * 4; vals.push(R.colorDist(data[p], data[p + 1], data[p + 2], s.color.r, s.color.g, s.color.b)); }
      vals.sort((a, b) => a - b);
      const t = vals.length ? Math.max(25, 1.3 * vals[Math.floor(vals.length * 0.9)]) : 40;
      tolOf.set(s.id, t);
      return t;
    };
    // 3. the paints: every color that is no surface, its shades merged —
    // colors on one surface lying along one line out from it, or close to
    // each other (a stroke's dense core and its thin edge, silver's glint
    // and shade, a grainy red) — read by the commonest of them
    // (a surface's color can be a letter's too — a yellow B beside a yellow
    // curb strip, white letters beside a white sign: the shapes of that
    // color that are strokes, apart from the surface's own big one, are
    // paint)
    // (a surface is its big regions — the brick wall, the panel; the same
    // color in small patches elsewhere, on another surface, is not that
    // surface: a gray stroke on a black panel beside gray-green brick)
    const cands = groups.filter((gr) => !gr.surface && gr.share >= 0.0015);
    for (const gr of groups) {
      if (!gr.surface || !gr.stats) continue;
      const parts = new Set(), body = new Set();
      let n = 0;
      for (const c of gr.stats) {
        if (c.area >= 0.25 * gr.n || c.size >= 0.5 || (c.touch >= 1 && c.area >= 0.05 * gr.n)) body.add(c.L);
        else { parts.add(c.L); n += c.area; }
      }
      gr.body = { set: body, labels: gr.stats.labels, w: gr.stats.w };
      if (parts.size && n >= 0.0015 * total) cands.push({ id: gr.id, part: { set: parts, labels: gr.stats.labels, w: gr.stats.w }, color: gr.color, share: n / total, surface: false, self: gr });
    }
    const paints = [];
    for (const P of cands.sort((a, b) => b.share - a.share)) {
      P.on = P.self ? surfaceOf(P.self, P.self) : surfaceOf(P);
      const dir = (c, s) => { const v = [(c.r - s.r) * WR, (c.g - s.g) * WG, (c.b - s.b) * WB]; const L = Math.hypot(...v) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
      const dp = dir(P.color, P.on.color);
      // (how far along the host's surface→paint axis a color lies: a shade
      // short of halfway is its halo, overspray, the thin edge of a spray —
      // never the paint)
      const along = (c, M) => {
        const ax = (M.color.r - M.on.color.r) * WR, ay = (M.color.g - M.on.color.g) * WG, az = (M.color.b - M.on.color.b) * WB;
        return ((c.r - M.on.color.r) * WR * ax + (c.g - M.on.color.g) * WG * ay + (c.b - M.on.color.b) * WB * az) / (ax * ax + ay * ay + az * az || 1);
      };
      const host = paints.find((M) => {
        const near = R.colorDist(M.color.r, M.color.g, M.color.b, P.color.r, P.color.g, P.color.b);
        if (M.on !== P.on) return near < 60;
        if (along(P.color, M) < 0.55) return false;
        if (near < 85) return true;
        // (against a pale wall every dark color points the same way — navy
        // paint and a gray pipe's shadow: shades of one paint share its hue
        // too, or have none)
        const hp = hueOf(P.color), hm = hueOf(M.color);
        if ((hp == null) !== (hm == null)) return false;
        if (hp != null && Math.min(Math.abs(hp - hm), 360 - Math.abs(hp - hm)) > 35) return false;
        const dm = dir(M.color, M.on.color);
        return dp[0] * dm[0] + dp[1] * dm[1] + dp[2] * dm[2] > Math.cos((22 * Math.PI) / 180);
      });
      const member = P.part ? { id: P.id, part: P.part } : { id: P.id };
      if (host) { host.share += P.share; host.members.push(member); }
      else paints.push({ id: P.id, members: [member], color: P.color, share: P.share, on: P.on });
    }
    // the wall behind every pixel: the nearest surface (a white tag's
    // pixels lie on the black panel round them, not on the brick the paint
    // touches elsewhere)
    const sIdx = new Map(surfaces.map((S, k) => [S.id, k]));
    const near = new Int8Array(N).fill(-1);
    const queue = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let i = 0; i < N; i++) {
      const k = sIdx.get(lab[i]);
      if (k == null) continue;
      const b = surfaces[k].body;
      if (b && !b.set.has(b.labels[((i / W | 0) >> 1) * b.w + ((i % W) >> 1)])) continue; // a patch of its color, not it
      near[i] = k; queue[qt++] = i;
    }
    while (qh < qt) {
      const i = queue[qh++], k = near[i], x = i % W;
      if (x > 0 && near[i - 1] < 0) { near[i - 1] = k; queue[qt++] = i - 1; }
      if (x < W - 1 && near[i + 1] < 0) { near[i + 1] = k; queue[qt++] = i + 1; }
      if (i >= W && near[i - W] < 0) { near[i - W] = k; queue[qt++] = i - W; }
      if (i + W < N && near[i + W] < 0) { near[i + W] = k; queue[qt++] = i + W; }
    }
    // each paint's mask: the pixels nearest its colors, the grain of the
    // assignment smoothed (a pinhole filled, a lone fleck dropped)
    const inks = [];
    for (const P of paints.slice(0, 6)) {
      const sep = R.colorDist(P.color.r, P.color.g, P.color.b, P.on.color.r, P.on.color.g, P.on.color.b);
      if (sep < 40) continue;
      const ids = new Set(), parts = new Map();
      for (const mb of P.members) { if (mb.part) parts.set(mb.id, mb.part); else ids.add(mb.id); }
      // (and a pixel of its colors closer to the wall behind it than to the
      // paint is the stroke's soft edge, not the stroke)
      const axes = surfaces.map((Sf) => {
        const S = Sf.color;
        const ax = (P.color.r - S.r) * WR, ay = (P.color.g - S.g) * WG, az = (P.color.b - S.b) * WB;
        return { S, ax, ay, az, a2: ax * ax + ay * ay + az * az || 1 };
      });
      let raw = new Uint8Array(N);
      for (let i = 0, p = 0; i < N; i++, p += 4) {
        if (!ids.has(lab[i])) {
          const pt = parts.get(lab[i]);
          if (!pt) continue;
          const x = i % W, y = (i / W) | 0;
          if (!pt.set.has(pt.labels[(y >> 1) * pt.w + (x >> 1)])) continue;
        }
        const A = axes[near[i] >= 0 ? near[i] : 0], S = A.S;
        const u = ((data[p] - S.r) * WR * A.ax + (data[p + 1] - S.g) * WG * A.ay + (data[p + 2] - S.b) * WB * A.az) / A.a2;
        if (u >= 0.45) raw[i] = 1;
      }
      raw = R.open(R.close(raw, W, H, 1), W, H, 1);
      if (inPhoto) for (let i = 0; i < N; i++) if (!inPhoto[i]) raw[i] = 0;
      inks.push({ seed: P.color, bg: P.on.color, surface: P.on, sep, raw });
    }
    // thin strokes, whatever their color: brighter (or darker) than what
    // is round them, and narrower than a couple of percent of the photo
    // (a top-hat). A marker tag's color wanders along its stroke — dim and
    // tinged where it is thin, white where it is thick — and on a dark
    // panel it is still one bright line to the eye; a wide smear, a wall's
    // shading, are no lines at all
    if (o.strokes) {
      const Lm = new Float32Array(N);
      for (let i = 0, p = 0; i < N; i++, p += 4) Lm[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      const rr = Math.max(3, Math.round(0.012 * Math.max(W, H)));
      const opened = R.maxFilter(R.minFilter(Lm, W, H, rr), W, H, rr);
      const closedL = R.minFilter(R.maxFilter(Lm, W, H, rr), W, H, rr);
      for (const bright of [true, false]) {
        const th = new Float32Array(N);
        const hist = new Uint32Array(256);
        let cnt = 0;
        for (let i = 0; i < N; i++) {
          if (inPhoto && !inPhoto[i]) continue;
          const v = bright ? Lm[i] - opened[i] : closedL[i] - Lm[i];
          th[i] = v; hist[Math.max(0, Math.min(255, v | 0))]++; cnt++;
        }
        let acc = 0, p99 = 0;
        for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.99 * cnt) { p99 = v; break; } }
        if (p99 < 40) continue; // nothing stands out as a line
        const T = Math.max(20, 0.3 * p99);
        let m = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (th[i] > T) m[i] = 1;
        m = R.open(m, W, H, 1);
        let n = 0;
        for (let i = 0; i < N; i++) n += m[i];
        if (n < 0.002 * N) continue;
        // (strokes a paint's color already holds are that paint's)
        if (inks.some((ink) => { let both = 0; for (let i = 0; i < N; i++) if (m[i] && ink.raw[i]) both++; return both >= 0.7 * n; })) continue;
        let sr = 0, sg = 0, sb = 0;
        const on = new Int32Array(surfaces.length);
        for (let i = 0, p = 0; i < N; i++, p += 4) if (m[i]) { sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; if (near[i] >= 0) on[near[i]]++; }
        let sk = 0;
        for (let k = 1; k < on.length; k++) if (on[k] > on[sk]) sk = k;
        const seed = { r: sr / n, g: sg / n, b: sb / n }, S = surfaces[sk];
        inks.push({ seed, bg: S.color, surface: S, sep: R.colorDist(seed.r, seed.g, seed.b, S.color.r, S.color.g, S.color.b), raw: m, lines: bright ? 'light' : 'dark' });
      }
    }
    const walls = new Map();
    const wallFor = (S) => {
      if (!walls.has(S.id)) walls.set(S.id, X.wallMask(data, W, H, S.color, wallTolOf(S)));
      return walls.get(S.id);
    };
    inks.forEach((ink) => {
      const comps = shapeStats(ink.raw, W, H);
      for (const c of comps) c.score = strokeScore(c);
      ink.shapeLabels = comps.labels; ink.shapeW = comps.w;
      comps.sort((a, b) => b.score - a.score);
      ink.comps = comps.slice(0, 6);
      const top = comps.slice(0, 3).map((c) => c.score);
      ink.score = (top[0] || 0) + 0.35 * (top[1] || 0) + 0.15 * (top[2] || 0);
    });
    inks.sort((a, b) => b.score - a.score);
    // every surface is wall — visible, never hidden ground a stroke runs on
    // under (the black panel a white tag is on, the brick round the panel)
    let wallAll = null;
    for (const S of surfaces) {
      const wm = wallFor(S);
      if (!wallAll) wallAll = Uint8Array.from(wm);
      else for (let i = 0; i < N; i++) if (wm[i]) wallAll[i] = 1;
    }
    for (const ink of inks) {
      ink.wall = wallAll;
      ink.wallTol = wallTolOf(ink.surface);
    }
    if (o.debug) o.debug.groups = groups.map((gr) => ({ id: gr.id, c: [gr.color.r, gr.color.g, gr.color.b].map(Math.round), share: +gr.share.toFixed(3), ring: +gr.ringShare.toFixed(2), strokey: gr.strokey != null ? +gr.strokey.toFixed(2) : null, surface: gr.surface }));
    if (o.debug) o.debug.paints = paints.map((P) => ({ c: [P.color.r, P.color.g, P.color.b].map(Math.round), members: P.members.map((m) => m.id + (m.part ? 'p' : '')), share: +P.share.toFixed(3), on: P.on.id }));
    // (the wall behind every pixel, for clicks: a stroke clicked is grown
    // against the surface it is on)
    const backdrop = { W, H, near, colors: surfaces.map((S) => S.color), tols: surfaces.map(wallTolOf) };
    return { bg: main.color, wall: wallAll || wallFor(main), wallTol: wallTolOf(main), inks, surfaces: surfaces.map((s) => s.color), labels: lab, backdrop };
  };

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
      // (a lone stroke reads confidently as an l, an i, a 1 or a ! — and on
      // a wall it is nearly always a piece of a letter, a drip, a scratch:
      // it goes behind the letters)
      const lone = /^[lIi1!|jJ\/\\.,'-]$/.test(read.ranked[0].ch) ? 0.45 : 1;
      return clear * size * central * (touches ? 0.75 : 1) * lone;
    };
    const out = [];
    // the four biggest shapes are read (a shape read before keeps its reading)
    const byArea = cands.map((c) => ({ c, n: ST.raster.count(c.mask) })).sort((a, b) => b.n - a.n);
    byArea.forEach(({ c: cand }, k) => {
      // (the three biggest shapes are taken apart; the rest are read whole)
      if (k >= 6) { cand.score = 0; out.push(cand); return; }
      // a shape that reads plainly as one letter is that letter: nothing to
      // take apart (the stroke-by-stroke search is most of the work)
      const plain = cand._whole || (cand._whole = ST.recognize.classify(cand.mask, cand.w, cand.h));
      // (never the biggest: a T through an O reads plainly as a P)
      const plainly = k > 0 && plain && plain.letterness >= 0.85 && ST.letters.clarity({ ranked: plain.ranked, letterness: plain.letterness }) >= 0.75;
      if (cand._found === undefined) {
        cand._found = k >= 3 || plainly ? null : ST.letters.find(cand.mask, cand.w, cand.h, {
          center: { x: W / 2 - cand.crop.x, y: H / 2 - cand.crop.y },
          frame: { x0: -cand.crop.x, y0: -cand.crop.y, x1: W - 1 - cand.crop.x, y1: H - 1 - cand.crop.y },
          budget: [120, 120, 60][k],
        });
      }
      const found = cand._found;
      const whole = found ? found.whole : plain;
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
