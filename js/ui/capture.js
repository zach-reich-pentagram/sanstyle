/* SANSTYLE — ui/capture.js
 * The capture studio is the review surface: every photo in the queue lands
 * on the stage with its detected letterform boxed and outlined over the
 * paint. Click a letter to trace it, shift-click to add a piece, drag a
 * short cut across a join; the Detail knob re-reads the photo. The traced
 * and fitted letterform sit on the right beside the character box. The
 * stage pans and zooms — there is nothing else to dial in.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$;

  const cap = (ST.capture = {
    img: null,        // the photo on the stage (the queue item's straightened canvas)
    item: null,       // current queue item
    cand: null,       // current shape
    record: null,     // fitted record for the typed character
    view: { scale: 1, tx: 0, ty: 0 },
    tool: 'trace',    // trace | hand
    needsFit: false,
    demoIdx: 0,
    lastDemo: null,
  });

  let stage, ctx, wrap, hintEl, preview, pctx, traceC, tctx;
  let dragging = null;
  let spaceHeld = false;
  let raf = 0;

  // ---------- view ----------
  const toScreen = (p) => ({ x: p.x * cap.view.scale + cap.view.tx, y: p.y * cap.view.scale + cap.view.ty });
  const toImage = (p) => ({ x: (p.x - cap.view.tx) / cap.view.scale, y: (p.y - cap.view.ty) / cap.view.scale });
  cap.toScreen = toScreen; cap.toImage = toImage;

  function fitView() {
    if (!cap.img || !stage) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) { cap.needsFit = true; return; }
    const s = Math.min(W / cap.img.width, H / cap.img.height) * 0.94;
    cap.view.scale = s;
    cap.view.tx = (W - cap.img.width * s) / 2;
    cap.view.ty = (H - cap.img.height * s) / 2;
    cap.needsFit = false;
    requestDraw();
  }
  cap.fitView = fitView;

  function setHint(msg) { if (hintEl) hintEl.textContent = msg || ''; }
  cap.setHint = setHint;

  // ---------- the current photo and its shape ----------
  // The review queue calls this whenever the photo or the shape changes.
  cap.showItem = function (item, cand, opts) {
    const o = opts || {};
    const newPhoto = !!item && item !== cap.item;
    cap.item = item || null;
    cap.cand = cand || null;
    cap.img = item ? item.canvas : null;
    if (newPhoto) fitView();
    const wall = $('#step-wall'), shape = $('#step-shape'), tag = $('#step-tag');
    if (wall) { wall.classList.toggle('active', !item); wall.classList.toggle('done', !!item); }
    if (shape) { shape.classList.toggle('active', !!item); shape.classList.toggle('locked', !item); }
    if (tag) { tag.classList.toggle('active', !!cand); tag.classList.toggle('locked', !cand); }
    if (!item) setHint(o.intake ? 'Analyzing…' : 'Drop photos of graffiti here — or load a demo wall.');
    else if (!cand) setHint('Nothing traced yet — click the letter in the photo, or skip it.');
    else setHint('Click a letter to trace it · shift-click adds a piece · drag a short cut across a join · scroll zooms, space pans');
    drawTrace();
    updatePreview();
    requestDraw();
  };

  function pathOf(paths, map) {
    const path = new Path2D();
    for (const p of paths) {
      const cs = p.cubics;
      const m0 = map(cs[0][0].x, cs[0][0].y);
      path.moveTo(m0[0], m0[1]);
      for (const cu of cs) {
        const a = map(cu[1].x, cu[1].y), b = map(cu[2].x, cu[2].y), c = map(cu[3].x, cu[3].y);
        path.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
      }
      path.closePath();
    }
    return path;
  }

  // the clean silhouette of the current shape
  function drawTrace() {
    if (!tctx) return;
    const W = traceC.width, H = traceC.height;
    tctx.clearRect(0, 0, W, H);
    const cand = cap.cand;
    if (!cand || !cand.paths.length) return;
    const bb = ST.trace.boundsOf(cand.paths);
    if (!bb) return;
    const ts = Math.min((W - 24) / Math.max(1, bb.w), (H - 24) / Math.max(1, bb.h));
    const tox = (W - bb.w * ts) / 2 - bb.x0 * ts;
    const toy = (H - bb.h * ts) / 2 - bb.y0 * ts;
    tctx.fillStyle = '#000';
    tctx.fill(pathOf(cand.paths, (x, y) => [tox + x * ts, toy + y * ts]), 'nonzero');
  }

  // ---------- fitted preview ----------
  function updatePreview() {
    const input = $('#reviewChar');
    const key = ST.metrics.charKey(input ? input.value : '');
    cap.record = null;
    if (cap.cand && cap.cand.paths.length && key) cap.record = ST.metrics.buildRecord(key, cap.cand.paths);
    drawPreview(key || 'A');
    const btn = $('#reviewAccept');
    if (btn) btn.disabled = !cap.record;
    const info = $('#fitInfo');
    if (info) {
      if (cap.record) {
        const r = cap.record;
        const os = (r.osTop || r.osBot) ? ` · overshoot +${r.osTop}/−${r.osBot}` : '';
        info.textContent = `Fit: ${r.clsName} · left ${r.lsb} · right ${r.rsb} · advance ${r.advance}${os}`;
      } else if (cap.cand) {
        info.textContent = 'Type the character to see it fitted.';
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
    pctx.fillStyle = '#000';
    pctx.fill(pathOf(fin.contours, (x, y) => [originX + (x + fin.lsb) * s, yGl(y)]), 'nonzero');
  }

  // ---------- submit ----------
  cap.submit = function () { return ST.batch.accept(); };

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
    cx.fillStyle = '#000';
    cx.fill(pathOf(fin.contours, (x, y) => [ox + x * s, oy - y * s]), 'nonzero');
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

  // ---------- demo walls ----------
  cap.loadDemo = function (letter) {
    const letters = ST.demo.letters;
    const ch = letter || letters[cap.demoIdx % letters.length];
    cap.demoIdx++; // every wall gets a fresh seed, so recaptures differ
    const wall = ST.demo.makeWall(ch, 1234 + cap.demoIdx * 77 + ch.charCodeAt(0));
    cap.lastDemo = wall;
    const becomesCurrent = ST.batch.queue.length === ST.batch.idx;
    ST.batch.addCanvas(wall.canvas, 'demo-' + ch);
    if (becomesCurrent) {
      const input = $('#reviewChar');
      if (input) { input.value = ch; input.dispatchEvent(new Event('input')); }
    }
    return wall;
  };

  // ---------- stage drawing ----------
  function requestDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }
  cap.requestDraw = requestDraw;

  // the shape's ink, tinted, cached per shape
  function overlayFor(cand) {
    if (cand._overlay) return cand._overlay;
    const c = g.document.createElement('canvas');
    c.width = cand.w; c.height = cand.h;
    const od = c.getContext('2d');
    const img = od.createImageData(cand.w, cand.h);
    for (let i = 0; i < cand.mask.length; i++) {
      if (!cand.mask[i]) continue;
      img.data[i * 4] = 255; img.data[i * 4 + 1] = 72; img.data[i * 4 + 2] = 40; img.data[i * 4 + 3] = 118;
    }
    od.putImageData(img, 0, 0);
    cand._overlay = c;
    return c;
  }

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
      ctx.fillText('Drop photos of graffiti here', stage.clientWidth / 2, stage.clientHeight / 2);
      ctx.textAlign = 'start';
      return;
    }

    const v = cap.view;
    ctx.save();
    ctx.translate(v.tx, v.ty);
    ctx.scale(v.scale, v.scale);
    ctx.imageSmoothingEnabled = v.scale < 3;
    ctx.drawImage(cap.img, 0, 0);

    const cand = cap.cand, item = cap.item;
    if (cand) {
      ctx.drawImage(overlayFor(cand), cand.crop.x, cand.crop.y);
      ctx.lineWidth = 1.6 / v.scale;
      ctx.strokeStyle = '#d8ff3d';
      ctx.stroke(pathOf(cand.paths, (x, y) => [x + cand.crop.x, y + cand.crop.y]));
      ctx.lineWidth = 2 / v.scale;
      ctx.strokeStyle = '#3b82f6';
      ctx.strokeRect(cand.crop.x, cand.crop.y, cand.crop.w, cand.crop.h);
    }
    if (item && item.cuts && item.cuts.length) {
      ctx.strokeStyle = 'rgba(225,29,72,0.9)';
      ctx.lineWidth = 3 / v.scale;
      for (const cut of item.cuts) {
        ctx.beginPath(); ctx.moveTo(cut.x0, cut.y0); ctx.lineTo(cut.x1, cut.y1); ctx.stroke();
      }
    }
    if (item && item.parts && item.parts.length) {
      ctx.strokeStyle = '#d8ff3d';
      ctx.lineWidth = 2 / v.scale;
      for (const p of item.parts) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 7 / v.scale, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();

    // a cut being drawn, in screen space
    if (dragging && dragging.kind === 'gesture' && dragging.moved) {
      const a = toScreen(dragging.start), b = toScreen(dragging.last);
      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---------- gestures: click = trace, shift-click = add a piece, drag = cut ----------
  function stagePos(ev) {
    const r = stage.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function onPointerDown(ev) {
    if (!cap.img) return;
    const sp = stagePos(ev);
    const ip = toImage(sp);
    try { stage.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
    const pan = ev.button === 1 || ev.button === 2 || spaceHeld || cap.tool === 'hand';
    if (pan) {
      dragging = { kind: 'pan', sx: sp.x, sy: sp.y, tx: cap.view.tx, ty: cap.view.ty };
      return;
    }
    if (ev.button !== 0) return;
    dragging = { kind: 'gesture', start: ip, last: ip, sStart: sp, moved: false, shift: ev.shiftKey };
  }

  function onPointerMove(ev) {
    if (!dragging) return;
    const sp = stagePos(ev);
    if (dragging.kind === 'pan') {
      cap.view.tx = dragging.tx + sp.x - dragging.sx;
      cap.view.ty = dragging.ty + sp.y - dragging.sy;
      requestDraw();
      return;
    }
    if (Math.hypot(sp.x - dragging.sStart.x, sp.y - dragging.sStart.y) > 6) dragging.moved = true;
    dragging.last = toImage(sp);
    if (dragging.moved) requestDraw();
  }

  function onPointerUp(ev) {
    const d = dragging;
    dragging = null;
    try { stage.releasePointerCapture(ev.pointerId); } catch (e) { /* released */ }
    if (!d || d.kind !== 'gesture' || !cap.item || !cap.img) { requestDraw(); return; }
    const inside = (p) => p.x >= 0 && p.y >= 0 && p.x < cap.img.width && p.y < cap.img.height;
    if (d.moved) {
      if (inside(d.start) || inside(d.last)) ST.batch.addCut(d.start.x, d.start.y, d.last.x, d.last.y);
      else requestDraw();
    } else if (inside(d.start)) {
      if (d.shift || ev.shiftKey) ST.batch.addPart(d.start.x, d.start.y);
      else ST.batch.clickTrace(d.start.x, d.start.y);
    } else {
      requestDraw();
    }
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

  function setTool(tool) {
    cap.tool = tool;
    const hand = $('#toolHand');
    if (hand) hand.classList.toggle('on', tool === 'hand');
    if (stage) stage.style.cursor = tool === 'hand' ? 'grab' : 'crosshair';
  }
  cap.setTool = setTool;

  // ---------- init ----------
  cap.init = function () {
    wrap = $('.stage-wrap');
    stage = $('#stage');
    ctx = stage.getContext('2d');
    hintEl = $('#stageHint');
    preview = $('#previewCanvas');
    pctx = preview.getContext('2d');
    traceC = $('#reviewTrace');
    tctx = traceC ? traceC.getContext('2d') : null;

    new ResizeObserver(() => {
      if (cap.needsFit && stage.clientWidth && stage.clientHeight) fitView();
      requestDraw();
    }).observe(stage);

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());

    g.addEventListener('keydown', (e) => {
      const typing = e.target.tagName === 'INPUT' || e.target.isContentEditable;
      if (e.code === 'Space' && !e.repeat && !typing) { spaceHeld = true; e.preventDefault(); }
    });
    g.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });

    for (const ev of ['dragover', 'drop']) {
      wrap.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === 'drop' && e.dataTransfer.files.length) ST.batch.addFiles(e.dataTransfer.files);
      });
    }
    $('#fileInput').addEventListener('change', (e) => {
      if (e.target.files.length) ST.batch.addFiles(e.target.files);
      e.target.value = '';
    });
    $('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
    $('#demoBtn').addEventListener('click', () => cap.loadDemo());

    $('#toolFit').addEventListener('click', fitView);
    $('#toolHand').addEventListener('click', () => setTool(cap.tool === 'hand' ? 'trace' : 'hand'));
    $('#reviewChar').addEventListener('input', updatePreview);

    setTool('trace');
    cap.showItem(null, null);
  };
})(typeof window !== 'undefined' ? window : globalThis);
