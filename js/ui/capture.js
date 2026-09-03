/* SANSTYLE — ui/capture.js
 * The capture studio: photo in → flattened → lassoed (freehand or polygon) →
 * ink found (with hole filling and occlusion block-out/bridge) → traced →
 * fitted → submitted. Owns the stage canvas, step cards, and preview column.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const V = ST.geom;
  const $ = ST.$;

  const MAX_EDGE = 1800;
  const CROP_PAD = 10;

  const cap = (ST.capture = {
    step: 'wall',             // wall | flatten | lasso | ink
    tool: 'lasso',            // lasso | poly | hand
    img: null,
    imgBeforeFlatten: null,
    view: { scale: 1, tx: 0, ty: 0 },
    quad: null,
    lasso: [],
    lassoLive: null,
    polyPts: null,            // in-progress polygon lasso
    polyCursor: null,
    blocks: [],               // block-out brush circles {x, y, r} image coords
    blockArmed: false,
    blockR: 16,
    ink: {
      mode: 'luma', threshOffset: 0, tol: 30, invert: false, invertAuto: true,
      smoothing: 4, despeckle: 5, detail: 1.2, fill: 6, bridge: 14, seeds: [],
    },
    eyedrop: false,
    extract: null,
    record: null,
    demoIdx: 0,
    lastDemo: null,
  });

  let stage, ctx, wrap, hintEl, preview, pctx;
  let dragging = null;
  let spaceHeld = false;
  let raf = 0;

  // ---------- view helpers ----------
  const toScreen = (p) => ({ x: p.x * cap.view.scale + cap.view.tx, y: p.y * cap.view.scale + cap.view.ty });
  const toImage = (p) => ({ x: (p.x - cap.view.tx) / cap.view.scale, y: (p.y - cap.view.ty) / cap.view.scale });
  cap.toScreen = toScreen; cap.toImage = toImage;

  function fitView() {
    if (!cap.img) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    const s = Math.min(W / cap.img.width, H / cap.img.height) * 0.94;
    cap.view.scale = s;
    cap.view.tx = (W - cap.img.width * s) / 2;
    cap.view.ty = (H - cap.img.height * s) / 2;
    requestDraw();
  }

  // ---------- steps ----------
  const STEP_ORDER = ['wall', 'flatten', 'lasso', 'ink'];
  function setStep(step) {
    cap.step = step;
    for (const s of STEP_ORDER) {
      const el = $('#step-' + s);
      if (!el) continue;
      el.classList.toggle('active', s === step);
      el.classList.toggle('done', STEP_ORDER.indexOf(s) < STEP_ORDER.indexOf(step));
      el.classList.toggle('locked', !cap.img && s !== 'wall');
    }
    $('#step-tag').classList.toggle('active', !!(cap.extract && cap.extract.paths.length));
    $('#step-tag').classList.toggle('locked', !(cap.extract && cap.extract.paths.length));
    const hints = {
      wall: 'Drop a photo here — or load a demo wall.',
      flatten: 'Drag the corners onto the wall plane, then apply. Skip if it’s straight-on.',
      lasso: 'Loop one letterform: drag to draw, or use the polygon tool and click points. Scroll zooms, space pans.',
      ink: 'Dial in the paint, then tag the character on the right.',
    };
    setHint(hints[step] || '');
    requestDraw();
  }

  function setHint(msg) { if (hintEl) hintEl.textContent = msg; }

  // ---------- image loading ----------
  function useBitmap(source, w, h) {
    const c = g.document.createElement('canvas');
    const s = Math.min(1, MAX_EDGE / Math.max(w, h));
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    cap.img = c;
    cap.rotSource = c;
    cap.rotDeg = 0;
    const rot = $('#rotRange'); if (rot) rot.value = 0;
    cap.imgBeforeFlatten = null;
    cap.lasso = [];
    cap.polyPts = null;
    cap.blocks = [];
    cap.extract = null;
    cap.record = null;
    cap.ink.seeds = [];
    cap.quad = defaultQuad();
    fitView();
    setStep('flatten');
    updatePreview();
  }
  cap.useBitmap = useBitmap;

  function defaultQuad() {
    if (!cap.img) return null;
    const w = cap.img.width, h = cap.img.height, ix = w * 0.14, iy = h * 0.14;
    return [{ x: ix, y: iy }, { x: w - ix, y: iy }, { x: w - ix, y: h - iy }, { x: ix, y: h - iy }];
  }

  cap.loadFile = function (file) {
    const finish = (bmp, w, h) => {
      useBitmap(bmp, w, h);
      if (ST.sync && ST.sync.storeUploadsEnabled()) {
        ST.sync.uploadCanvas(cap.img, file.name)
          .then((id) => {
            if (id) { ST.sync.markProcessed(id); ST.toast('Photo stored in the Drive inbox.'); }
          })
          .catch(() => ST.toast('Could not store the photo in Drive.', 'warn'));
      }
    };
    if (ST.heic && ST.heic.looksHeic(file)) {
      // Safari can decode natively; everyone else gets the vendored decoder.
      const native = g.createImageBitmap ? g.createImageBitmap(file, { imageOrientation: 'from-image' }) : Promise.reject();
      Promise.resolve(native)
        .then((bmp) => finish(bmp, bmp.width, bmp.height))
        .catch(() => ST.heic.decode(file)
          .then((cnv) => finish(cnv, cnv.width, cnv.height))
          .catch((err) => ST.toast('HEIC: ' + err.message, 'warn')));
      return;
    }
    if (g.createImageBitmap) {
      g.createImageBitmap(file, { imageOrientation: 'from-image' })
        .then((bmp) => finish(bmp, bmp.width, bmp.height))
        .catch(() => loadViaImg(file, finish));
    } else loadViaImg(file, finish);
  };

  function loadViaImg(file, cb) {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { cb(im, im.naturalWidth, im.naturalHeight); URL.revokeObjectURL(url); };
    im.onerror = () => { ST.toast('Could not read that image.', 'warn'); URL.revokeObjectURL(url); };
    im.src = url;
  }

  cap.loadDemo = function (letter) {
    const letters = ST.demo.letters;
    const ch = letter || letters[cap.demoIdx % letters.length];
    cap.demoIdx++; // every wall gets a fresh seed, so recaptures differ
    const wall = ST.demo.makeWall(ch, 1234 + cap.demoIdx * 77 + ch.charCodeAt(0));
    cap.lastDemo = wall;
    useBitmap(wall.canvas, wall.canvas.width, wall.canvas.height);
    $('#charInput').value = ch;
    setHint(`Demo wall loaded — a sprayed “${ch}”. Flatten or skip, then lasso it.`);
    return wall;
  };

  // ---------- perspective ----------
  cap.applyFlatten = function () {
    if (!cap.img || !cap.quad) return;
    const q = cap.quad;
    const topLen = V.dist(q[0], q[1]), botLen = V.dist(q[3], q[2]);
    const leftLen = V.dist(q[0], q[3]), rightLen = V.dist(q[1], q[2]);
    let W = Math.round((topLen + botLen) / 2), H = Math.round((leftLen + rightLen) / 2);
    const s = Math.min(1, MAX_EDGE / Math.max(W, H));
    W = Math.max(8, Math.round(W * s)); H = Math.max(8, Math.round(H * s));
    const h = V.homography(
      [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }],
      q
    );
    if (!h) { ST.toast('That quad is too twisted — move the corners.', 'warn'); return; }
    const src = cap.img.getContext('2d').getImageData(0, 0, cap.img.width, cap.img.height);
    const out = new ImageData(W, H);
    const sd = src.data, od = out.data, sw = cap.img.width, sh = cap.img.height;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = V.applyH(h, x + 0.5, y + 0.5);
        const sx = p.x - 0.5, sy = p.y - 0.5;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        const cx0 = ST.clamp(x0, 0, sw - 1), cx1 = ST.clamp(x0 + 1, 0, sw - 1);
        const cy0 = ST.clamp(y0, 0, sh - 1), cy1 = ST.clamp(y0 + 1, 0, sh - 1);
        const i00 = (cy0 * sw + cx0) * 4, i10 = (cy0 * sw + cx1) * 4;
        const i01 = (cy1 * sw + cx0) * 4, i11 = (cy1 * sw + cx1) * 4;
        const o = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
          const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
          od[o + c] = top * (1 - fy) + bot * fy;
        }
        od[o + 3] = 255;
      }
    }
    const c = g.document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').putImageData(out, 0, 0);
    cap.imgBeforeFlatten = cap.img;
    cap.img = c;
    cap.lasso = [];
    cap.polyPts = null;
    cap.blocks = [];
    cap.extract = null;
    fitView();
    setStep('lasso');
    ST.toast('Flattened. Now lasso a letterform.');
  };

  cap.resetFlatten = function () {
    if (cap.imgBeforeFlatten) {
      cap.img = cap.imgBeforeFlatten;
      cap.imgBeforeFlatten = null;
      cap.quad = defaultQuad();
      fitView();
    }
    setStep('flatten');
  };

  cap.skipFlatten = function () { setStep('lasso'); };

  // ---------- rotation ----------
  function afterRotate() {
    cap.lasso = [];
    cap.polyPts = null;
    cap.blocks = [];
    cap.extract = null;
    cap.record = null;
    cap.quad = defaultQuad();
    fitView();
    updatePreview();
    requestDraw();
  }

  cap.setRotation = function (deg) {
    if (!cap.rotSource) return;
    cap.rotDeg = ST.clamp(deg, -25, 25);
    cap.img = cap.rotDeg === 0 ? cap.rotSource : ST.auto.rotateCanvas(cap.rotSource, cap.rotDeg);
    const rot = $('#rotRange'); if (rot) rot.value = cap.rotDeg;
    afterRotate();
  };

  cap.quarterTurn = function (dir) {
    if (!cap.rotSource) return;
    cap.rotSource = ST.auto.rotateCanvas(cap.rotSource, dir * 90);
    cap.setRotation(cap.rotDeg);
  };

  cap.autoStraighten = function () {
    if (!cap.rotSource) return;
    const base = cap.rotSource;
    const s = Math.min(1, 900 / Math.max(base.width, base.height));
    const small = g.document.createElement('canvas');
    small.width = Math.round(base.width * s);
    small.height = Math.round(base.height * s);
    small.getContext('2d').drawImage(base, 0, 0, small.width, small.height);
    const data = small.getContext('2d').getImageData(0, 0, small.width, small.height);
    const gray = ST.raster.luma(data.data, small.width, small.height);
    const angle = ST.auto.estimateSkewAngle(gray, small.width, small.height);
    if (Math.abs(angle) < 0.75) {
      ST.toast('Already straight (within a degree).');
      return;
    }
    cap.setRotation(angle);
    ST.toast(`Straightened by ${angle > 0 ? '−' : '+'}${Math.abs(angle)}°.`);
  };

  // ---------- lasso (freehand + polygon) ----------
  function closeLasso() {
    if (!cap.lassoLive || cap.lassoLive.length < 8) {
      cap.lassoLive = null;
      requestDraw();
      return;
    }
    cap.lasso = V.rdp(cap.lassoLive, 1.2 / cap.view.scale);
    cap.lassoLive = null;
    finishLasso();
  }

  function closePoly() {
    if (!cap.polyPts || cap.polyPts.length < 3) { cancelPoly(); return; }
    cap.lasso = cap.polyPts.slice();
    cancelPoly();
    finishLasso();
  }

  function cancelPoly() {
    cap.polyPts = null;
    cap.polyCursor = null;
    requestDraw();
  }

  function finishLasso() {
    const bb = V.bounds(cap.lasso);
    if (bb.w < 8 || bb.h < 8) {
      cap.lasso = [];
      ST.toast('That selection is tiny — zoom in and try again.', 'warn');
      requestDraw();
      return;
    }
    runExtraction(true);
  }

  cap.clearLasso = function () {
    cap.lasso = [];
    cap.lassoLive = null;
    cap.polyPts = null;
    cap.extract = null;
    cap.record = null;
    cap.eyedrop = false;
    const eb = $('#eyedropBtn'); if (eb) eb.classList.remove('on');
    if (cap.img) setStep('lasso');
    updatePreview();
    requestDraw();
  };

  cap.clearBlocks = function () {
    cap.blocks = [];
    if (cap.lasso.length) runExtraction(false);
    requestDraw();
  };

  function cropRegion() {
    const bb = V.bounds(cap.lasso);
    const x0 = ST.clamp(Math.floor(bb.x0 - CROP_PAD), 0, cap.img.width - 1);
    const y0 = ST.clamp(Math.floor(bb.y0 - CROP_PAD), 0, cap.img.height - 1);
    const x1 = ST.clamp(Math.ceil(bb.x1 + CROP_PAD), 1, cap.img.width);
    const y1 = ST.clamp(Math.ceil(bb.y1 + CROP_PAD), 1, cap.img.height);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---------- extraction ----------
  // One Smoothing knob drives the whole clean-up chain, all scale-aware:
  //  1. pre-blur the decision field (luma / color distance) so chalky,
  //     broken-texture edges stop flickering across the threshold;
  //  2. structural smoothing — morphological close∘open at a radius that
  //     grows with the crop but is capped by the measured stroke width, so
  //     ragged fingers get shaved without ever erasing thin strokes.
  function runExtraction(autoTune) {
    if (!cap.img || cap.lasso.length < 3) return;
    const crop = cropRegion();
    const data = cap.img.getContext('2d').getImageData(crop.x, crop.y, crop.w, crop.h);
    const local = cap.lasso.map((p) => ({ x: p.x - crop.x, y: p.y - crop.y }));
    const roi = ST.raster.fillPoly(crop.w, crop.h, local);
    const ink = cap.ink;
    const nPix = crop.w * crop.h;
    const preBlur = Math.max(0, Math.round(ink.smoothing * 0.5));

    let mask;
    if (ink.mode === 'color' && ink.seeds.length) {
      let field = ST.raster.colorDistMap(data.data, crop.w, crop.h, ink.seeds);
      if (preBlur) field = ST.raster.blur(field, crop.w, crop.h, preBlur);
      const maxD = 8 + ink.tol * 3.4;
      mask = new Uint8Array(nPix);
      for (let i = 0; i < nPix; i++) {
        if (roi[i] && field[i] <= maxD) mask[i] = 1;
      }
    } else {
      const rawLuma = ST.raster.luma(data.data, crop.w, crop.h);
      let lumaU8 = rawLuma;
      if (preBlur) {
        const f = ST.raster.blur(rawLuma, crop.w, crop.h, preBlur);
        lumaU8 = new Uint8Array(nPix);
        for (let i = 0; i < nPix; i++) lumaU8[i] = ST.clamp(Math.round(f[i]), 0, 255);
      }
      const base = ST.raster.otsu(lumaU8, roi);
      const t = ST.clamp(base + ink.threshOffset, 2, 253);
      if (autoTune && ink.invertAuto) {
        ink.invert = ST.raster.guessInvert(lumaU8, roi, t);
        const inv = $('#inkInvert'); if (inv) inv.checked = ink.invert;
      }
      mask = ST.raster.maskFromLuma(lumaU8, roi, t, ink.invert);
    }

    if (ink.smoothing > 0) {
      // clear speckle first so the stroke-width estimate isn't polluted
      mask = ST.raster.despeckle(mask, crop.w, crop.h, 0.04, 24);
      const sw = ST.raster.strokeWidth(mask, crop.w, crop.h);
      const rBase = ink.smoothing * 1.2 * (Math.max(crop.w, crop.h) / 700);
      const r = Math.max(0, Math.min(Math.round(rBase), Math.floor(sw * 0.33)));
      if (r > 0) {
        mask = ST.raster.close(mask, crop.w, crop.h, r);
        mask = ST.raster.open(mask, crop.w, crop.h, r);
      }
    }

    // occlusion block-out: erase the intruding letter, bridge our stroke through
    let blockMask = null;
    const localBlocks = cap.blocks.filter((b) =>
      b.x + b.r > crop.x && b.x - b.r < crop.x + crop.w &&
      b.y + b.r > crop.y && b.y - b.r < crop.y + crop.h);
    if (localBlocks.length) {
      blockMask = new Uint8Array(crop.w * crop.h);
      for (const b of localBlocks) {
        const bx = b.x - crop.x, by = b.y - crop.y, r = b.r, r2 = r * r;
        const x0 = Math.max(0, Math.floor(bx - r)), x1 = Math.min(crop.w - 1, Math.ceil(bx + r));
        const y0 = Math.max(0, Math.floor(by - r)), y1 = Math.min(crop.h - 1, Math.ceil(by + r));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if ((x - bx) ** 2 + (y - by) ** 2 <= r2) blockMask[y * crop.w + x] = 1;
          }
        }
      }
      mask = ST.raster.bridgeThrough(mask, blockMask, crop.w, crop.h, ink.bridge);
    }

    if (ink.fill > 0) mask = ST.raster.fillHoles(mask, crop.w, crop.h, ink.fill / 100);
    mask = ST.raster.despeckle(mask, crop.w, crop.h, ink.despeckle / 100, 30);

    const paths = ST.trace.vectorize(mask, crop.w, crop.h, { rdpEps: ink.detail });
    const inkCount = ST.raster.count(mask);

    const overlay = g.document.createElement('canvas');
    overlay.width = crop.w; overlay.height = crop.h;
    const od = overlay.getContext('2d');
    const oimg = od.createImageData(crop.w, crop.h);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        oimg.data[i * 4] = 255; oimg.data[i * 4 + 1] = 72; oimg.data[i * 4 + 2] = 40;
        oimg.data[i * 4 + 3] = 132;
      }
    }
    od.putImageData(oimg, 0, 0);

    cap.extract = { crop, mask, w: crop.w, h: crop.h, paths, overlay, inkCount };
    if (!paths.length) {
      setHint('No paint found in the loop — adjust the threshold, invert, or pick the paint color.');
    }
    setStep('ink');
    updatePreview();
    requestDraw();
  }
  cap.runExtraction = runExtraction;

  // ---------- preview column ----------
  function updatePreview() {
    const chInput = $('#charInput');
    const ch = (chInput && chInput.value) ? chInput.value.slice(-1) : 'A';
    if (chInput && chInput.value.length > 1) chInput.value = ch;
    cap.record = null;
    if (cap.extract && cap.extract.paths.length && ch && ch !== ' ') {
      cap.record = ST.metrics.buildRecord(ch, cap.extract.paths);
    }
    drawPreview(ch);
    const btn = $('#submitBtn');
    if (btn) btn.disabled = !cap.record;
    const info = $('#fitInfo');
    if (info) {
      if (cap.record) {
        const r = cap.record;
        const os = (r.osTop || r.osBot) ? ` · overshoot +${r.osTop}/−${r.osBot}` : '';
        info.textContent = `Fit: ${r.clsName} · left ${r.lsb} · right ${r.rsb} · advance ${r.advance}${os}`;
      } else if (cap.extract && !cap.extract.paths.length) {
        info.textContent = 'No shape traced yet.';
      } else {
        info.textContent = '';
      }
    }
  }
  cap.updatePreview = updatePreview;

  function drawPreview(ch) {
    if (!pctx) return;
    const W = preview.width, H = preview.height;
    pctx.clearRect(0, 0, W, H);

    const top = ST.metrics.ASC + 70, bottom = ST.metrics.DESC - 60;
    const span = top - bottom;
    const yOf = (fu) => ((top - fu) / span) * (H - 24) + 12;

    const lines = [
      [ST.metrics.ASC, 'asc'], [ST.metrics.CAP, 'cap'], [ST.metrics.XH, 'x'],
      [0, 'base'], [ST.metrics.DESC, 'desc'],
    ];
    pctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    for (const [fu, label] of lines) {
      const y = Math.round(yOf(fu)) + 0.5;
      pctx.strokeStyle = '#000';
      pctx.lineWidth = 1;
      pctx.beginPath(); pctx.moveTo(8, y); pctx.lineTo(W - 8, y); pctx.stroke();
      pctx.fillStyle = '#000';
      pctx.fillText(label, W - 34, fu === ST.metrics.CAP ? y + 11 : y - 4);
    }

    if (!cap.record) {
      pctx.fillStyle = '#e3e3e3';
      pctx.font = '400 120px "Helvetica Neue", Helvetica, Arial, sans-serif';
      pctx.textAlign = 'center';
      pctx.fillText(ch || 'A', W / 2, yOf(0));
      pctx.textAlign = 'start';
      return;
    }

    const fin = ST.metrics.finalizeVariant(cap.record);
    let s = (H - 24) / span;
    const maxW = W - 70;
    if (fin.advance * s > maxW) s = maxW / fin.advance;
    const originX = (W - fin.advance * s) / 2;
    const yGl = (fu) => yOf(0) - fu * s;

    pctx.strokeStyle = '#000';
    pctx.lineWidth = 1;
    for (const x of [originX, originX + fin.advance * s]) {
      const xr = Math.round(x) + 0.5;
      pctx.beginPath(); pctx.moveTo(xr, yOf(top) + 4); pctx.lineTo(xr, yOf(bottom) - 4); pctx.stroke();
    }

    const path = new Path2D();
    for (const c of fin.contours) {
      const cs = c.cubics;
      path.moveTo(originX + (cs[0][0].x + fin.lsb) * s, yGl(cs[0][0].y));
      for (const cu of cs) {
        path.bezierCurveTo(
          originX + (cu[1].x + fin.lsb) * s, yGl(cu[1].y),
          originX + (cu[2].x + fin.lsb) * s, yGl(cu[2].y),
          originX + (cu[3].x + fin.lsb) * s, yGl(cu[3].y)
        );
      }
      path.closePath();
    }
    pctx.fillStyle = '#000';
    pctx.fill(path, 'nonzero');
  }

  // ---------- submit ----------
  cap.submit = function () {
    const chInput = $('#charInput');
    const ch = ST.metrics.charKey(chInput ? chInput.value : '');
    if (!ch) { ST.toast('Type which character this is first.', 'warn'); return false; }
    if (!cap.extract || !cap.extract.paths.length) { ST.toast('Nothing traced yet.', 'warn'); return false; }
    const record = ST.metrics.buildRecord(ch, cap.extract.paths);
    if (!record) { ST.toast('Could not fit that shape.', 'warn'); return false; }
    record.thumb = makeThumb(record);
    ST.store.addVariant(ch, record);
    if (ST.sources && cap.img && cap.extract.crop) ST.sources.put(record.id, cap.sourceThumb(cap.img, cap.extract.crop));
    const n = ST.store.count();
    ST.toast(`“${ch}” added${ch.length > 1 ? ' as a ligature' : ''} — ${n} character${n === 1 ? '' : 's'} in ${ST.store.state.fontName}.`);
    if (ST.batch && ST.batch.onStudioSubmit) ST.batch.onStudioSubmit();
    cap.lasso = [];
    cap.extract = null;
    cap.record = null;
    cap.blocks = [];
    if (chInput) chInput.value = '';
    setStep('lasso');
    updatePreview();
    requestDraw();
    return true;
  };

  function makeThumb(record) {
    const size = 72;
    const c = g.document.createElement('canvas');
    c.width = size; c.height = size;
    const cx = c.getContext('2d');
    const fin = ST.metrics.finalizeVariant(record);
    const bb = fin.bbox;
    const s = Math.min((size - 10) / Math.max(bb.w, 1), (size - 10) / Math.max(bb.h, 1));
    const ox = (size - bb.w * s) / 2 - bb.x0 * s;
    const oy = (size + bb.h * s) / 2 + bb.y0 * s;
    const path = new Path2D();
    for (const cont of fin.contours) {
      const cs = cont.cubics;
      path.moveTo(ox + cs[0][0].x * s, oy - cs[0][0].y * s);
      for (const cu of cs) {
        path.bezierCurveTo(ox + cu[1].x * s, oy - cu[1].y * s,
          ox + cu[2].x * s, oy - cu[2].y * s, ox + cu[3].x * s, oy - cu[3].y * s);
      }
      path.closePath();
    }
    cx.fillStyle = '#000';
    cx.fill(path, 'nonzero');
    return c.toDataURL('image/png');
  }
  cap.makeThumb = makeThumb;

  // The bit of photo a letterform was cut from (crop plus a margin), as a
  // small JPEG data URL for the tester's hover popup.
  cap.sourceThumb = function (canvas, crop) {
    try {
      const pad = Math.round(Math.max(crop.w, crop.h) * 0.15);
      const x0 = Math.max(0, crop.x - pad), y0 = Math.max(0, crop.y - pad);
      const x1 = Math.min(canvas.width, crop.x + crop.w + pad), y1 = Math.min(canvas.height, crop.y + crop.h + pad);
      const sw = x1 - x0, sh = y1 - y0;
      if (sw < 1 || sh < 1) return null;
      const s = Math.min(1, 320 / Math.max(sw, sh));
      const c = g.document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
      c.getContext('2d').drawImage(canvas, x0, y0, sw, sh, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.75);
    } catch (e) { return null; }
  };

  // ---------- stage drawing ----------
  function requestDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }
  cap.requestDraw = requestDraw;

  function draw() {
    if (!ctx) return;
    const dpr = g.devicePixelRatio || 1;
    stage.width = stage.clientWidth * dpr;
    stage.height = stage.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);

    if (!cap.img) {
      ctx.fillStyle = '#bbb';
      ctx.font = '400 14px "Helvetica Neue", Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Drop a photo of graffiti here', stage.clientWidth / 2, stage.clientHeight / 2);
      ctx.textAlign = 'start';
      return;
    }

    const v = cap.view;
    ctx.save();
    ctx.translate(v.tx, v.ty);
    ctx.scale(v.scale, v.scale);
    ctx.imageSmoothingEnabled = v.scale < 3;
    ctx.drawImage(cap.img, 0, 0);

    if (cap.extract && cap.step !== 'flatten') {
      ctx.drawImage(cap.extract.overlay, cap.extract.crop.x, cap.extract.crop.y);
      ctx.lineWidth = 1.6 / v.scale;
      ctx.strokeStyle = '#d8ff3d';
      for (const p of cap.extract.paths) {
        ctx.beginPath();
        const cs = p.cubics;
        ctx.moveTo(cs[0][0].x + cap.extract.crop.x, cs[0][0].y + cap.extract.crop.y);
        for (const cu of cs) {
          ctx.bezierCurveTo(
            cu[1].x + cap.extract.crop.x, cu[1].y + cap.extract.crop.y,
            cu[2].x + cap.extract.crop.x, cu[2].y + cap.extract.crop.y,
            cu[3].x + cap.extract.crop.x, cu[3].y + cap.extract.crop.y
          );
        }
        ctx.closePath();
        ctx.stroke();
      }
    }

    // block-out strokes
    if (cap.blocks.length && cap.step !== 'flatten') {
      ctx.fillStyle = 'rgba(59,130,246,0.4)';
      for (const b of cap.blocks) {
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    // lasso overlays in screen space
    const lassoPts = cap.lassoLive || (cap.lasso.length ? cap.lasso : null);
    if (lassoPts && cap.step !== 'flatten') {
      ctx.lineWidth = 2;
      ctx.beginPath();
      lassoPts.forEach((p, i) => {
        const sp = toScreen(p);
        i ? ctx.lineTo(sp.x, sp.y) : ctx.moveTo(sp.x, sp.y);
      });
      if (!cap.lassoLive) ctx.closePath();
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.stroke();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // polygon-in-progress
    if (cap.polyPts && cap.polyPts.length) {
      const pts = cap.polyPts.map(toScreen);
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (cap.polyCursor) {
        const c = toScreen(cap.polyCursor);
        ctx.lineTo(c.x, c.y);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.stroke();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.setLineDash([]);
      pts.forEach((p, i) => {
        ctx.beginPath();
        ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7);
        ctx.fillStyle = i === 0 ? '#000' : '#fff';
        ctx.fill();
        ctx.strokeStyle = i === 0 ? '#fff' : '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }

    // block brush cursor
    if (cap.blockArmed && cap.polyCursor) {
      const c = toScreen(cap.polyCursor);
      ctx.beginPath();
      ctx.arc(c.x, c.y, cap.blockR * v.scale, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(59,130,246,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // perspective quad
    if (cap.step === 'flatten' && cap.quad) {
      const q = cap.quad.map(toScreen);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, stage.clientWidth, stage.clientHeight);
      ctx.moveTo(q[0].x, q[0].y);
      for (let i = 3; i >= 0; i--) ctx.lineTo(q[i].x, q[i].y);
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      for (const p of q) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // ---------- pointer interactions ----------
  function stagePos(ev) {
    const r = stage.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function onPointerDown(ev) {
    if (!cap.img) return;
    stage.setPointerCapture(ev.pointerId);
    const sp = stagePos(ev);
    const ip = toImage(sp);

    if (cap.step === 'flatten' && ev.button === 0) {
      for (let i = 0; i < 4; i++) {
        const hs = toScreen(cap.quad[i]);
        if (Math.hypot(hs.x - sp.x, hs.y - sp.y) < 14) {
          dragging = { kind: 'handle', idx: i };
          return;
        }
      }
    }
    if (cap.eyedrop && ev.button === 0) {
      // A click samples; a drag means the user wants a new lasso — don't
      // hold them hostage to the eyedropper.
      dragging = { kind: 'sample', sx: sp.x, sy: sp.y, ip };
      return;
    }
    const panButton = ev.button === 1 || ev.button === 2 || spaceHeld || cap.tool === 'hand';
    if (panButton) {
      dragging = { kind: 'pan', sx: sp.x, sy: sp.y, tx: cap.view.tx, ty: cap.view.ty };
      return;
    }
    if (ev.button !== 0 || cap.step === 'flatten') return;

    if (cap.tool === 'click') {
      if (ev.shiftKey) cap.addPart(ip); else cap.clickTrace(ip);
      return;
    }
    if (cap.blockArmed) {
      cap.blocks.push({ x: ip.x, y: ip.y, r: cap.blockR });
      dragging = { kind: 'block', last: ip };
      requestDraw();
      return;
    }
    if (cap.tool === 'poly') {
      if (!cap.polyPts) {
        cap.polyPts = [ip];
      } else {
        const startScreen = toScreen(cap.polyPts[0]);
        if (cap.polyPts.length >= 3 && Math.hypot(startScreen.x - sp.x, startScreen.y - sp.y) < 12) {
          closePoly();
          return;
        }
        cap.polyPts.push(ip);
      }
      cap.polyCursor = ip;
      requestDraw();
      return;
    }
    cap.lassoLive = [ip];
    dragging = { kind: 'lasso' };
    requestDraw();
  }

  function onPointerMove(ev) {
    const sp = stagePos(ev);
    const ip = toImage(sp);
    if (!dragging) {
      if ((cap.polyPts && cap.polyPts.length) || cap.blockArmed) {
        cap.polyCursor = ip;
        requestDraw();
      }
      return;
    }
    if (dragging.kind === 'sample') {
      if (Math.hypot(sp.x - dragging.sx, sp.y - dragging.sy) > 5) {
        cap.eyedrop = false;
        const eb = $('#eyedropBtn'); if (eb) eb.classList.remove('on');
        cap.lassoLive = [dragging.ip, ip];
        dragging = { kind: 'lasso' };
        setHint('Drawing a new loop — sampling switched off.');
      }
    } else if (dragging.kind === 'pan') {
      cap.view.tx = dragging.tx + sp.x - dragging.sx;
      cap.view.ty = dragging.ty + sp.y - dragging.sy;
    } else if (dragging.kind === 'handle') {
      cap.quad[dragging.idx] = ip;
    } else if (dragging.kind === 'lasso') {
      const last = cap.lassoLive[cap.lassoLive.length - 1];
      if (V.dist(ip, last) > 2 / cap.view.scale) cap.lassoLive.push(ip);
    } else if (dragging.kind === 'block') {
      if (V.dist(ip, dragging.last) > cap.blockR / 2) {
        cap.blocks.push({ x: ip.x, y: ip.y, r: cap.blockR });
        dragging.last = ip;
      }
      cap.polyCursor = ip;
    }
    requestDraw();
  }

  function onPointerUp(ev) {
    if (dragging && dragging.kind === 'sample') sampleInk(dragging.ip);
    if (dragging && dragging.kind === 'lasso') closeLasso();
    if (dragging && dragging.kind === 'block' && cap.lasso.length) runExtraction(false);
    dragging = null;
    try { stage.releasePointerCapture(ev.pointerId); } catch (e) { /* released */ }
  }

  function onWheel(ev) {
    if (!cap.img) return;
    ev.preventDefault();
    const sp = stagePos(ev);
    const factor = Math.pow(1.0016, -ev.deltaY);
    const ns = ST.clamp(cap.view.scale * factor, 0.04, 40);
    const ip = toImage(sp);
    cap.view.scale = ns;
    cap.view.tx = sp.x - ip.x * ns;
    cap.view.ty = sp.y - ip.y * ns;
    requestDraw();
  }

  function sampleInk(ip) {
    if (!cap.img) return;
    const x = ST.clamp(Math.round(ip.x), 0, cap.img.width - 1);
    const y = ST.clamp(Math.round(ip.y), 0, cap.img.height - 1);
    const d = cap.img.getContext('2d').getImageData(Math.max(0, x - 1), Math.max(0, y - 1), 3, 3).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    cap.ink.seeds.push({ r: r / n, g: gg / n, b: b / n });
    syncInkMode('color');
    updateSeedChips();
    if (cap.lasso.length) runExtraction(false);
    ST.toast(`Paint sampled (${cap.ink.seeds.length}). Click more spots to widen the range.`);
  }

  function updateSeedChips() {
    const box = $('#seedChips');
    if (!box) return;
    box.innerHTML = '';
    cap.ink.seeds.forEach((s, i) => {
      const chip = ST.el('button', {
        class: 'seed-chip', title: 'Remove this color',
        style: `background: rgb(${s.r | 0},${s.g | 0},${s.b | 0})`,
        onclick: () => {
          cap.ink.seeds.splice(i, 1);
          updateSeedChips();
          if (cap.lasso.length) runExtraction(false);
        },
      });
      box.appendChild(chip);
    });
    box.style.display = cap.ink.seeds.length ? 'flex' : 'none';
  }

  function syncInkMode(mode) {
    cap.ink.mode = mode;
    $('#inkModeAuto').classList.toggle('on', mode === 'luma');
    $('#inkModeColor').classList.toggle('on', mode === 'color');
    $('#lumaControls').style.display = mode === 'luma' ? '' : 'none';
    $('#colorControls').style.display = mode === 'color' ? '' : 'none';
  }

  function setTool(tool) {
    cap.tool = tool;
    if (tool !== 'poly') cancelPoly();
    cap.eyedrop = false;
    $('#eyedropBtn') && $('#eyedropBtn').classList.remove('on');
    for (const [id, t] of [['#toolClick', 'click'], ['#toolLasso', 'lasso'], ['#toolPoly', 'poly'], ['#toolHand', 'hand']]) {
      const el = $(id);
      if (el) el.classList.toggle('on', tool === t);
    }
    if (tool === 'click' && cap.img) setHint('Click the middle of a letterform to trace it. Shift-click adds another piece of it.');
  }
  cap.setTool = setTool;

  // Click-to-trace in the studio: seeded extraction becomes the current
  // selection, expressed through the normal ink pipeline (paint color +
  // calibrated range + a loop around the region) so every slider still works.
  cap.clickTrace = function (ip) {
    if (!cap.img) return false;
    const res = ST.extract.seeded(cap.img, ip.x, ip.y, { smoothing: cap.ink.smoothing });
    if (!res) {
      ST.toast('Nothing paint-like under that click — try the middle of a stroke.', 'warn');
      return false;
    }
    const r = res.region;
    cap.lasso = [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
    ];
    cap.polyPts = null;
    cap.ink.seeds = [res.seed];
    cap.ink.tol = ST.clamp(Math.round((res.tolerance - 8) / 3.4), 2, 90);
    const tolEl = $('#inkTol'); if (tolEl) tolEl.value = cap.ink.tol;
    syncInkMode('color');
    updateSeedChips();
    runExtraction(false);
    return true;
  };

  // Shift-click with the Click tool: scan another piece of the same
  // character. The loop grows to hold both pieces and the new piece's paint
  // color counts alongside the first.
  cap.addPart = function (ip) {
    if (!cap.img) return false;
    if (cap.lasso.length < 3) return cap.clickTrace(ip);
    const res = ST.extract.seeded(cap.img, ip.x, ip.y, { smoothing: cap.ink.smoothing });
    if (!res) {
      ST.toast('Nothing paint-like under that click — try the middle of the piece.', 'warn');
      return false;
    }
    const b = V.bounds(cap.lasso);
    const r = res.region;
    const x0 = Math.min(b.x0, r.x), y0 = Math.min(b.y0, r.y);
    const x1 = Math.max(b.x1, r.x + r.w), y1 = Math.max(b.y1, r.y + r.h);
    cap.lasso = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    cap.polyPts = null;
    const s = res.seed;
    const known = cap.ink.seeds.some((q) => ST.raster.colorDist(q.r, q.g, q.b, s.r, s.g, s.b) < 12);
    if (!known) cap.ink.seeds.push(s);
    syncInkMode('color');
    updateSeedChips();
    runExtraction(false);
    return true;
  };

  function setBlockArmed(on) {
    cap.blockArmed = on;
    $('#blockToggle').classList.toggle('on', on);
    setHint(on
      ? 'Paint over the intruding letter. The stroke underneath gets bridged back through.'
      : '');
    requestDraw();
  }

  // ---------- init ----------
  cap.init = function () {
    wrap = $('.stage-wrap');
    stage = $('#stage');
    ctx = stage.getContext('2d');
    hintEl = $('#stageHint');
    preview = $('#previewCanvas');
    pctx = preview.getContext('2d');

    new ResizeObserver(requestDraw).observe(stage);

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);
    stage.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (cap.tool === 'poly' && cap.polyPts) closePoly();
    });
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());

    g.addEventListener('keydown', (e) => {
      const typing = e.target.tagName === 'INPUT' || e.target.isContentEditable;
      if (e.code === 'Space' && !e.repeat && !typing) { spaceHeld = true; e.preventDefault(); }
      if (e.key === 'Escape') {
        if (cap.polyPts) cancelPoly();
        else if (cap.lassoLive) { cap.lassoLive = null; requestDraw(); }
        else if (cap.blockArmed) setBlockArmed(false);
      }
      if (e.key === 'Enter' && cap.tool === 'poly' && cap.polyPts && !typing) {
        e.preventDefault();
        closePoly();
      }
    });
    g.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });

    for (const ev of ['dragover', 'drop']) {
      wrap.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === 'drop' && e.dataTransfer.files[0]) cap.loadFile(e.dataTransfer.files[0]);
      });
    }
    $('#fileInput').addEventListener('change', (e) => {
      if (e.target.files[0]) cap.loadFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
    $('#demoBtn').addEventListener('click', () => cap.loadDemo());

    $('#flattenApply').addEventListener('click', cap.applyFlatten);
    $('#flattenSkip').addEventListener('click', cap.skipFlatten);
    $('#flattenReset').addEventListener('click', cap.resetFlatten);

    $('#rotRange').addEventListener('change', (e) => cap.setRotation(+e.target.value));
    $('#rotCCW').addEventListener('click', () => cap.quarterTurn(-1));
    $('#rotCW').addEventListener('click', () => cap.quarterTurn(1));
    $('#rotAuto').addEventListener('click', cap.autoStraighten);

    $('#lassoReset').addEventListener('click', cap.clearLasso);

    $('#toolFit').addEventListener('click', fitView);
    $('#toolHand').addEventListener('click', () => setTool(cap.tool === 'hand' ? 'lasso' : 'hand'));
    $('#toolClick').addEventListener('click', () => setTool('click'));
    $('#toolLasso').addEventListener('click', () => setTool('lasso'));
    $('#toolPoly').addEventListener('click', () => setTool('poly'));

    $('#inkModeAuto').addEventListener('click', () => { syncInkMode('luma'); if (cap.lasso.length) runExtraction(false); });
    $('#inkModeColor').addEventListener('click', () => syncInkMode('color'));
    $('#eyedropBtn').addEventListener('click', () => {
      cap.eyedrop = !cap.eyedrop;
      $('#eyedropBtn').classList.toggle('on', cap.eyedrop);
      setHint(cap.eyedrop ? 'Click the sprayed paint in the photo. Several clicks widen the match.' : '');
    });

    const rerun = ST.debounce(() => { if (cap.lasso.length) runExtraction(false); }, 140);
    const bindRange = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', () => { cap.ink[key] = +el.value; rerun(); });
    };
    bindRange('#inkThresh', 'threshOffset');
    bindRange('#inkTol', 'tol');
    bindRange('#inkSpeck', 'despeckle');
    bindRange('#inkDetail', 'detail');
    bindRange('#inkFill', 'fill');
    bindRange('#inkBridge', 'bridge');
    $('#inkInvert').addEventListener('change', (e) => {
      cap.ink.invert = e.target.checked;
      cap.ink.invertAuto = false;
      rerun();
    });

    $('#blockToggle').addEventListener('click', () => setBlockArmed(!cap.blockArmed));
    $('#blockSize').addEventListener('input', (e) => { cap.blockR = +e.target.value; requestDraw(); });
    $('#blockClear').addEventListener('click', cap.clearBlocks);

    $('#charInput').addEventListener('input', updatePreview);
    $('#charInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); cap.submit(); }
    });
    $('#submitBtn').addEventListener('click', cap.submit);

    syncInkMode('luma');
    setTool('lasso');
    setStep('wall');
    updatePreview();
    requestDraw();
  };
})(typeof window !== 'undefined' ? window : globalThis);
