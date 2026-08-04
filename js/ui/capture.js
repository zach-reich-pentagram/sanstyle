/* SANSTYLE — ui/capture.js
 * The capture studio: photo in → flattened → lassoed → ink found → traced →
 * fitted → submitted to the library. Owns the main stage canvas, the step
 * cards, and the letterform preview column.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const V = ST.geom;
  const $ = ST.$;

  const MAX_EDGE = 1800;      // working-image long edge
  const CROP_PAD = 10;        // px around the lasso bbox

  const cap = (ST.capture = {
    step: 'wall',             // wall | flatten | lasso | ink
    tool: 'lasso',            // lasso | hand
    img: null,                // working canvas
    imgBeforeFlatten: null,
    view: { scale: 1, tx: 0, ty: 0 },
    quad: null,               // 4 perspective handles (image coords)
    lasso: [],                // closed polygon (image coords)
    lassoLive: null,          // while drawing
    ink: {
      mode: 'luma', threshOffset: 0, tol: 30, invert: false, invertAuto: true,
      smooth: 1, despeckle: 5, detail: 1.2, seeds: [],
    },
    eyedrop: false,
    extract: null,            // {crop, mask, w, h, paths, overlay}
    record: null,             // preview record for current char
    demoIdx: 0,
    lastDemo: null,
  });

  let stage, ctx, wrap, hintEl, preview, pctx;
  let dragging = null; // {kind: 'pan'|'handle'|'lasso', ...}
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
      wall: 'Drop a photo of a piece — or load a demo wall.',
      flatten: 'Drag the corners onto the wall plane to kill the camera angle. Apply, or skip if it’s straight-on.',
      lasso: 'Draw a loose loop around ONE letterform. Scroll to zoom · hold space to pan.',
      ink: 'Dial in the paint below, tag the character on the right, and add it to the typeface.',
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
    cap.imgBeforeFlatten = null;
    cap.lasso = [];
    cap.extract = null;
    cap.record = null;
    cap.ink.seeds = [];
    cap.quad = defaultQuad();
    fitView();
    setStep('flatten');
    updatePreview();
  }

  function defaultQuad() {
    if (!cap.img) return null;
    const w = cap.img.width, h = cap.img.height, ix = w * 0.14, iy = h * 0.14;
    return [{ x: ix, y: iy }, { x: w - ix, y: iy }, { x: w - ix, y: h - iy }, { x: ix, y: h - iy }];
  }

  cap.loadFile = function (file) {
    const finish = (bmp, w, h) => useBitmap(bmp, w, h);
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
    const ch = letter || letters[cap.demoIdx++ % letters.length];
    const wall = ST.demo.makeWall(ch, 1234 + cap.demoIdx * 77 + ch.charCodeAt(0));
    cap.lastDemo = wall;
    useBitmap(wall.canvas, wall.canvas.width, wall.canvas.height);
    $('#charInput').value = ch;
    setHint(`Demo wall loaded — a sprayed “${ch}”. Flatten (or skip) then lasso it.`);
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
    const srcCtx = cap.img.getContext('2d');
    const src = srcCtx.getImageData(0, 0, cap.img.width, cap.img.height);
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

  // ---------- lasso → extraction ----------
  function closeLasso() {
    if (!cap.lassoLive || cap.lassoLive.length < 8) {
      cap.lassoLive = null;
      requestDraw();
      return;
    }
    cap.lasso = V.rdp(cap.lassoLive, 1.2 / cap.view.scale);
    cap.lassoLive = null;
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
    cap.extract = null;
    cap.record = null;
    if (cap.img) setStep('lasso');
    updatePreview();
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

  function runExtraction(autoTune) {
    if (!cap.img || cap.lasso.length < 3) return;
    const crop = cropRegion();
    const ictx = cap.img.getContext('2d');
    const data = ictx.getImageData(crop.x, crop.y, crop.w, crop.h);
    const local = cap.lasso.map((p) => ({ x: p.x - crop.x, y: p.y - crop.y }));
    const roi = ST.raster.fillPoly(crop.w, crop.h, local);
    const luma = ST.raster.luma(data.data, crop.w, crop.h);
    const ink = cap.ink;

    let mask;
    if (ink.mode === 'color' && ink.seeds.length) {
      mask = ST.raster.maskFromColor(data.data, crop.w, crop.h, roi, ink.seeds, ink.tol);
    } else {
      const base = ST.raster.otsu(luma, roi);
      const t = ST.clamp(base + ink.threshOffset, 2, 253);
      if (autoTune && ink.invertAuto) {
        ink.invert = ST.raster.guessInvert(luma, roi, t);
        const inv = $('#inkInvert'); if (inv) inv.checked = ink.invert;
      }
      mask = ST.raster.maskFromLuma(luma, roi, t, ink.invert);
    }
    if (ink.smooth > 0) {
      mask = ST.raster.close(mask, crop.w, crop.h, ink.smooth);
      mask = ST.raster.open(mask, crop.w, crop.h, 1);
    }
    mask = ST.raster.despeckle(mask, crop.w, crop.h, ink.despeckle / 100, 30);

    const paths = ST.trace.vectorize(mask, crop.w, crop.h, { rdpEps: ink.detail });
    const inkCount = ST.raster.count(mask);

    // red overlay for the stage
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
      setHint('No paint found in the loop — adjust threshold / invert, or pick the paint color.');
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
        const os = (r.osTop || r.osBot)
          ? ` · overshoot +${r.osTop}/−${r.osBot}`
          : ' · flat fit';
        info.innerHTML =
          `<span class="chip">${r.clsName.toUpperCase()}</span>` +
          `<span>LSB ${r.lsb} · RSB ${r.rsb} · ADV ${r.advance}${os}</span>`;
      } else if (cap.extract && !cap.extract.paths.length) {
        info.innerHTML = '<span class="warn-text">No shape traced yet.</span>';
      } else {
        info.innerHTML = '<span class="dim">Lasso a letterform to see it fitted here.</span>';
      }
    }
  }
  cap.updatePreview = updatePreview;

  function drawPreview(ch) {
    if (!pctx) return;
    const W = preview.width, H = preview.height;
    pctx.clearRect(0, 0, W, H);

    // vertical span shown: DESC-60 .. ASC+70
    const top = ST.metrics.ASC + 70, bottom = ST.metrics.DESC - 60;
    const span = top - bottom;
    const yOf = (fu) => ((top - fu) / span) * (H - 24) + 12;

    const lines = [
      [ST.metrics.ASC, 'asc'], [ST.metrics.CAP, 'cap'], [ST.metrics.XH, 'x'],
      [0, 'base'], [ST.metrics.DESC, 'desc'],
    ];
    pctx.font = '9px ui-monospace, monospace';
    for (const [fu, label] of lines) {
      const y = yOf(fu);
      pctx.strokeStyle = fu === 0 ? 'rgba(255,92,31,0.75)' : 'rgba(255,255,255,0.16)';
      pctx.lineWidth = 1;
      pctx.beginPath(); pctx.moveTo(8, y); pctx.lineTo(W - 8, y); pctx.stroke();
      pctx.fillStyle = 'rgba(255,255,255,0.35)';
      // cap sits just under asc — put its label below the line so they don't collide
      pctx.fillText(label, W - 34, fu === ST.metrics.CAP ? y + 9 : y - 3);
    }

    if (!cap.record) {
      pctx.fillStyle = 'rgba(255,255,255,0.12)';
      pctx.font = '600 120px system-ui, sans-serif';
      pctx.textAlign = 'center';
      pctx.fillText(ch || 'A', W / 2, yOf(0));
      pctx.textAlign = 'start';
      return;
    }

    const fin = ST.metrics.finalizeVariant(cap.record);
    const sFit = (H - 24) / span;
    let s = sFit;
    const glyphW = fin.advance;
    const maxW = W - 70;
    if (glyphW * s > maxW) s = maxW / glyphW;
    const originX = (W - fin.advance * s) / 2;
    const yGl = (fu) => yOf(0) - fu * s;

    // sidebearing markers
    pctx.strokeStyle = 'rgba(255,92,31,0.5)';
    pctx.setLineDash([3, 3]);
    for (const x of [originX, originX + fin.advance * s]) {
      pctx.beginPath(); pctx.moveTo(x, yOf(top) + 6); pctx.lineTo(x, yOf(bottom) - 6); pctx.stroke();
    }
    pctx.setLineDash([]);

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
    pctx.fillStyle = '#f4f2ec';
    pctx.fill(path, 'nonzero');
  }

  // ---------- submit ----------
  cap.submit = function () {
    const chInput = $('#charInput');
    const ch = chInput && chInput.value ? chInput.value.slice(-1) : '';
    if (!ch || ch === ' ') { ST.toast('Type which character this is first.', 'warn'); return false; }
    if (!cap.extract || !cap.extract.paths.length) { ST.toast('Nothing traced yet.', 'warn'); return false; }
    const record = ST.metrics.buildRecord(ch, cap.extract.paths);
    if (!record) { ST.toast('Could not fit that shape.', 'warn'); return false; }
    record.thumb = makeThumb(record);
    ST.store.addVariant(ch, record);
    const n = ST.store.count();
    ST.toast(`“${ch}” added — ${n} character${n === 1 ? '' : 's'} live in ${ST.store.state.fontName}.`);
    // ready for the next letter on the same wall
    cap.lasso = [];
    cap.extract = null;
    cap.record = null;
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
    cx.fillStyle = '#f4f2ec';
    cx.fill(path, 'nonzero');
    return c.toDataURL('image/png');
  }

  // ---------- stage drawing ----------
  function requestDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }
  cap.requestDraw = requestDraw;

  function draw() {
    if (!ctx) return;
    const W = stage.width = stage.clientWidth * (g.devicePixelRatio || 1);
    const H = stage.height = stage.clientHeight * (g.devicePixelRatio || 1);
    const dpr = g.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!cap.img) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.font = '500 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('DROP A PHOTO OF GRAFFITI HERE', stage.clientWidth / 2, stage.clientHeight / 2);
      ctx.textAlign = 'start';
      return;
    }

    const v = cap.view;
    ctx.save();
    ctx.translate(v.tx, v.ty);
    ctx.scale(v.scale, v.scale);
    ctx.imageSmoothingEnabled = v.scale < 3;
    ctx.drawImage(cap.img, 0, 0);

    // ink overlay
    if (cap.extract && cap.step !== 'flatten') {
      ctx.drawImage(cap.extract.overlay, cap.extract.crop.x, cap.extract.crop.y);
      // traced vectors
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
    ctx.restore();

    // lasso (drawn in screen space for crisp dashes)
    const lassoPts = cap.lassoLive || (cap.lasso.length ? cap.lasso : null);
    if (lassoPts && cap.step !== 'flatten') {
      ctx.lineWidth = 2;
      ctx.beginPath();
      lassoPts.forEach((p, i) => {
        const sp = toScreen(p);
        i ? ctx.lineTo(sp.x, sp.y) : ctx.moveTo(sp.x, sp.y);
      });
      if (!cap.lassoLive) ctx.closePath();
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // perspective quad
    if (cap.step === 'flatten' && cap.quad) {
      const q = cap.quad.map(toScreen);
      ctx.fillStyle = 'rgba(8,8,10,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, stage.clientWidth, stage.clientHeight);
      ctx.moveTo(q[0].x, q[0].y);
      for (let i = 3; i >= 0; i--) ctx.lineTo(q[i].x, q[i].y);
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.strokeStyle = '#ff5c1f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      for (const p of q) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#0b0b0d';
        ctx.fill();
        ctx.strokeStyle = '#ff5c1f';
        ctx.lineWidth = 2;
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
      sampleInk(ip);
      return;
    }
    const panButton = ev.button === 1 || ev.button === 2 || spaceHeld || cap.tool === 'hand';
    if (panButton) {
      dragging = { kind: 'pan', sx: sp.x, sy: sp.y, tx: cap.view.tx, ty: cap.view.ty };
      return;
    }
    if (ev.button === 0 && cap.step !== 'flatten') {
      cap.lassoLive = [ip];
      dragging = { kind: 'lasso' };
      requestDraw();
    }
  }

  function onPointerMove(ev) {
    if (!dragging) return;
    const sp = stagePos(ev);
    if (dragging.kind === 'pan') {
      cap.view.tx = dragging.tx + sp.x - dragging.sx;
      cap.view.ty = dragging.ty + sp.y - dragging.sy;
    } else if (dragging.kind === 'handle') {
      cap.quad[dragging.idx] = toImage(sp);
    } else if (dragging.kind === 'lasso') {
      const ip = toImage(sp);
      const last = cap.lassoLive[cap.lassoLive.length - 1];
      if (V.dist(ip, last) > 2 / cap.view.scale) cap.lassoLive.push(ip);
    }
    requestDraw();
  }

  function onPointerUp(ev) {
    if (dragging && dragging.kind === 'lasso') closeLasso();
    dragging = null;
    try { stage.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
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
    ST.toast(`Paint sampled (${cap.ink.seeds.length} color${cap.ink.seeds.length > 1 ? 's' : ''}). Click more spots to widen.`);
  }

  function updateSeedChips() {
    const box = $('#seedChips');
    if (!box) return;
    box.innerHTML = '';
    cap.ink.seeds.forEach((s, i) => {
      const chip = ST.el('button', {
        class: 'seed-chip', title: 'remove',
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
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());

    g.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && e.target.tagName !== 'INPUT' && !e.target.isContentEditable) {
        spaceHeld = true; e.preventDefault();
      }
    });
    g.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });

    // drag & drop / file input
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

    // flatten
    $('#flattenApply').addEventListener('click', cap.applyFlatten);
    $('#flattenSkip').addEventListener('click', cap.skipFlatten);
    $('#flattenReset').addEventListener('click', cap.resetFlatten);

    // lasso
    $('#lassoReset').addEventListener('click', cap.clearLasso);

    // tools
    $('#toolFit').addEventListener('click', fitView);
    $('#toolHand').addEventListener('click', () => {
      cap.tool = cap.tool === 'hand' ? 'lasso' : 'hand';
      $('#toolHand').classList.toggle('on', cap.tool === 'hand');
      $('#toolLasso').classList.toggle('on', cap.tool === 'lasso');
    });
    $('#toolLasso').addEventListener('click', () => {
      cap.tool = 'lasso';
      cap.eyedrop = false;
      $('#eyedropBtn').classList.remove('on');
      $('#toolHand').classList.remove('on');
      $('#toolLasso').classList.add('on');
    });

    // ink controls
    $('#inkModeAuto').addEventListener('click', () => { syncInkMode('luma'); if (cap.lasso.length) runExtraction(false); });
    $('#inkModeColor').addEventListener('click', () => syncInkMode('color'));
    $('#eyedropBtn').addEventListener('click', () => {
      cap.eyedrop = !cap.eyedrop;
      $('#eyedropBtn').classList.toggle('on', cap.eyedrop);
      setHint(cap.eyedrop ? 'Click the sprayed paint in the photo. Click several spots for fades.' : '');
    });
    const rerun = ST.debounce(() => { if (cap.lasso.length) runExtraction(false); }, 140);
    const bindRange = (id, key, parse) => {
      const el = $(id);
      el.addEventListener('input', () => {
        cap.ink[key] = parse ? parse(el.value) : +el.value;
        rerun();
      });
    };
    bindRange('#inkThresh', 'threshOffset');
    bindRange('#inkTol', 'tol');
    bindRange('#inkSmooth', 'smooth');
    bindRange('#inkSpeck', 'despeckle');
    bindRange('#inkDetail', 'detail');
    $('#inkInvert').addEventListener('change', (e) => {
      cap.ink.invert = e.target.checked;
      cap.ink.invertAuto = false;
      rerun();
    });

    // tag + submit
    $('#charInput').addEventListener('input', updatePreview);
    $('#charInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); cap.submit(); }
    });
    $('#submitBtn').addEventListener('click', cap.submit);

    syncInkMode('luma');
    setStep('wall');
    updatePreview();
    requestDraw();
  };
})(typeof window !== 'undefined' ? window : globalThis);
