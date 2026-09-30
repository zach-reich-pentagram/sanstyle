/* SANSTYLE — ui/capture.js
 * The capture studio is the review surface: every photo in the queue lands
 * on the stage with its detected letterform boxed and outlined over the
 * paint, and every letter found in the photo is offered beside it. Drag
 * along a letter's strokes to trace it, click a letter to take it,
 * shift-click to add a piece, Option-click to take one off, Option-drag a
 * short cut across a join. The traced and fitted
 * letterform sit on the right beside the character box. The stage pans
 * and zooms — there is nothing else to dial in.
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
    view: { scale: 1, tx: 0, ty: 0, rot: 0 }, // rot: the photo turned on the stage (degrees, clockwise +)
    tool: 'trace',    // trace | hand
    needsFit: false,
    demoIdx: 0,
    lastDemo: null,
  });

  let stage, ctx, wrap, preview, pctx, traceC, tctx;
  let dragging = null;
  let spaceHeld = false;
  let raf = 0;

  // ---------- view ----------
  // photo px → stage px: turned by rot about the photo's middle, scaled,
  // moved (and back)
  const turned = (p, deg) => {
    if (!deg || !cap.img) return p;
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), cx = cap.img.width / 2, cy = cap.img.height / 2;
    return { x: cx + (p.x - cx) * c - (p.y - cy) * s, y: cy + (p.x - cx) * s + (p.y - cy) * c };
  };
  const toScreen = (p) => { const q = turned(p, cap.view.rot); return { x: q.x * cap.view.scale + cap.view.tx, y: q.y * cap.view.scale + cap.view.ty }; };
  const toImage = (p) => turned({ x: (p.x - cap.view.tx) / cap.view.scale, y: (p.y - cap.view.ty) / cap.view.scale }, -cap.view.rot);
  cap.toScreen = toScreen; cap.toImage = toImage;

  function fitView() {
    if (!cap.img || !stage) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) { cap.needsFit = true; return; }
    // (the photo as turned: its box on the stage)
    const a = (cap.view.rot * Math.PI) / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
    const bw = cap.img.width * c + cap.img.height * sn, bh = cap.img.width * sn + cap.img.height * c;
    const s = Math.min(W / bw, H / bh) * 0.94;
    cap.view.scale = s;
    cap.view.tx = W / 2 - (cap.img.width / 2) * s;
    cap.view.ty = H / 2 - (cap.img.height / 2) * s;
    cap.needsFit = false;
    requestDraw();
  }
  cap.fitView = fitView;

  // Turn the photo on the stage (about what is in the middle of the view,
  // so the letter you are looking at stays put): the letter is traced as
  // you see it, and comes out turned the same way.
  function setRot(deg) {
    if (!stage || deg === cap.view.rot) return;
    const mid = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
    const ip = cap.img ? toImage(mid) : null;
    cap.view.rot = deg;
    if (ip) {
      const q = turned(ip, deg);
      cap.view.tx = mid.x - q.x * cap.view.scale;
      cap.view.ty = mid.y - q.y * cap.view.scale;
    }
    requestDraw();
  }
  cap.setRot = setRot;

  // (what the empty stage says: nothing is laid over a photo — how to work
  // on it is told in the Shape panel)
  function setHint(msg) { cap.note = msg || ''; if (!cap.img) requestDraw(); }
  cap.setHint = setHint;

  // ---------- the current photo and its shape ----------
  // The review queue calls this whenever the photo or the shape changes.
  cap.showItem = function (item, cand, opts) {
    const o = opts || {};
    // (a cropped photo is a new picture of the same item: fit it again)
    const newPhoto = !!item && (item !== cap.item || item.canvas !== cap.img);
    cap.item = item || null;
    cap.cand = cand || null;
    cap.img = item ? item.canvas : null;
    // (the photo as turned by hand)
    const rot = item && item.manualTurn != null ? item.manualTurn : 0;
    if (newPhoto) { cap.view.rot = rot; fitView(); } else setRot(rot);
    const wall = $('#step-wall'), shape = $('#step-shape'), tag = $('#step-tag');
    if (wall) { wall.classList.toggle('active', !item); wall.classList.toggle('done', !!item); }
    if (shape) { shape.classList.toggle('active', !!item); shape.classList.toggle('locked', !item); }
    if (tag) { tag.classList.toggle('active', !!cand); tag.classList.toggle('locked', !cand); }
    if (!item) setHint(o.intake ? 'Analyzing…' : 'Drop photos of graffiti here — or load a demo wall');
    // (the smoothing set on this photo)
    if (cand && item && (cand.smooth || 0) !== (item.smooth || 0)) cap.smoothCand(cand, item.smooth || 0);
    // a leaning letter stands up by its stems (the Rotate slider adjusts)
    if (cand && cand.turn == null) {
      if (item && item.manualTurn != null) cand.turn = item.manualTurn; // set by hand on this photo: kept
      else {
        const lean = cand.lean != null ? cand.lean : (ST.letters ? ST.letters.lean(cand.mask, cand.w, cand.h) : 0);
        cand.turn = lean ? -lean : 0;
      }
    }
    syncRotate();
    drawTrace();
    updatePreview();
    showGuesses();
    requestDraw();
  };

  // ---------- upright ----------
  // The shape's contours turned by its `turn` (degrees, clockwise +) about
  // its middle: what the glyph is built from. The photo overlay keeps the
  // contours as found.
  cap.uprightPaths = function (cand) {
    if (!cand) return [];
    const turn = cand.turn || 0;
    if (!turn) return cand.paths;
    if (cand._upright && cand._upright.turn === turn) return cand._upright.paths;
    const bb = ST.trace.boundsOf(cand.paths);
    const paths = bb ? ST.trace.rotatePaths(cand.paths, turn, (bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2) : cand.paths;
    cand._upright = { turn, paths };
    return paths;
  };

  function syncRotate() {
    const r = $('#reviewRotate'), v = $('#reviewRotateVal');
    if (!r) return;
    const turn = cap.cand ? Math.round(cap.cand.turn || 0) : cap.item && cap.item.manualTurn != null ? Math.round(cap.item.manualTurn) : 0;
    r.value = turn;
    r.disabled = !cap.item;
    if (v) v.textContent = `${turn > 0 ? '+' : turn < 0 ? '−' : ''}${Math.abs(turn)}°`;
    const n = (cap.cand && cap.cand.nudge) || {};
    const sc = $('#reviewScale'), dy = $('#reviewDy');
    if (sc) { sc.value = n.scale || 0; sc.disabled = !cap.cand; $('#reviewScaleVal').textContent = `${100 + (n.scale || 0)}%`; }
    if (dy) { dy.value = n.dy || 0; dy.disabled = !cap.cand; $('#reviewDyVal').textContent = `${(n.dy || 0) > 0 ? '+' : ''}${n.dy || 0}`; }
    const sm = $('#reviewSmooth'), level = cap.item ? cap.item.smooth || 0 : 0;
    if (sm) { sm.value = level; sm.disabled = !cap.cand; $('#reviewSmoothVal').textContent = String(level); }
  }

  // ---------- smoothing ----------
  // A shape's outline evened out by hand (the Smoothing slider, 0–10): the
  // shape blurred over up to two fifths of its strokes' width and cut again
  // halfway — jags, bumps and notches smaller than that go, the strokes
  // keep their width and place. 0 is the shape as found. Set on a photo, it
  // holds for every letter taken from it.
  cap.smoothCand = function (cand, level) {
    if (!cand || !cand.mask) return;
    level = Math.max(0, Math.min(10, Math.round(level || 0)));
    if ((cand.smooth || 0) === level) return;
    if (!cand._raw) cand._raw = { mask: cand.mask, w: cand.w, h: cand.h, crop: cand.crop, paths: cand.paths };
    const raw = cand._raw;
    let out = raw;
    if (level) {
      const R = ST.raster;
      const sw = R.strokeWidth(raw.mask, raw.w, raw.h) || 10;
      const r = Math.max(1, Math.round((level / 10) * 0.4 * sw));
      const p = r + 2, w = raw.w + 2 * p, h = raw.h + 2 * p;
      const f = new Float32Array(w * h);
      for (let y = 0; y < raw.h; y++) for (let x = 0; x < raw.w; x++) f[(y + p) * w + x + p] = raw.mask[y * raw.w + x];
      // (a box twice over: near enough a gaussian)
      const b = R.blur(R.blur(f, w, h, r), w, h, r);
      const m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = b[i] >= 0.5 ? 1 : 0;
      const paths = ST.trace.vectorize(m, w, h, { strokeWidth: sw });
      if (paths.length) out = { mask: m, w, h, crop: { x: raw.crop.x - p, y: raw.crop.y - p, w, h }, paths };
    }
    Object.assign(cand, { mask: out.mask, w: out.w, h: out.h, crop: out.crop, paths: out.paths, smooth: level });
    cand._overlay = cand._upright = cand._read = cand._fit = cand._thumb = null;
  };

  // ---------- what it reads as ----------
  // The upright shape as the recognizer sees it (cached per rotation).
  cap.readOf = function (cand) {
    if (!cand || !cand.paths.length || !ST.recognize || !ST.recognize.ready()) return null;
    const turn = cand.turn || 0;
    if (cand._read && cand._read.turn === turn) return cand._read.read;
    const paths = cap.uprightPaths(cand);
    const bb = ST.trace.boundsOf(paths);
    let read = null;
    if (bb && bb.w > 1 && bb.h > 1) {
      const s = 96 / Math.max(bb.w, bb.h);
      const w = Math.max(2, Math.ceil(bb.w * s) + 4), h = Math.max(2, Math.ceil(bb.h * s) + 4);
      const c = ST.makeCanvas(w, h), x = c.getContext('2d');
      x.fillStyle = '#000';
      x.fill(pathOf(paths, (px, py) => [(px - bb.x0) * s + 2, (py - bb.y0) * s + 2]), 'nonzero');
      const d = x.getImageData(0, 0, w, h).data;
      const m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
      read = ST.recognize.classify(m, w, h);
    }
    cand._read = { turn, read };
    return read;
  };

  // The best guesses as buttons: one click types the character.
  function showGuesses() {
    const row = $('#guessRow');
    if (!row) return;
    row.textContent = '';
    const read = cap.readOf(cap.cand);
    if (!read || read.letterness < 0.3) return;
    const label = g.document.createElement('span');
    label.className = 'dim';
    label.textContent = 'Reads as:';
    row.appendChild(label);
    for (const r of read.ranked.slice(0, 3)) {
      if (r.p < 0.04) break;
      const b = g.document.createElement('button');
      b.className = 'pill sm';
      b.textContent = r.ch;
      b.title = `${Math.round(r.p * 100)}% sure`;
      b.addEventListener('click', () => {
        const input = $('#reviewChar');
        input.value = r.ch;
        input.dispatchEvent(new Event('input'));
        input.focus();
      });
      row.appendChild(b);
    }
  }
  cap.showGuesses = showGuesses;

  // The character the recognizer is sure enough of, for the box to start
  // with (typing over it replaces it) — or ''.
  cap.guess = function (cand) {
    const read = cap.readOf(cand);
    if (!read || read.letterness < 0.5 || !read.ranked.length || read.ranked[0].p < 0.35) return '';
    return read.ranked[0].ch;
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
    const paths = cap.uprightPaths(cand);
    const bb = ST.trace.boundsOf(paths);
    if (!bb) return;
    const ts = Math.min((W - 24) / Math.max(1, bb.w), (H - 24) / Math.max(1, bb.h));
    const tox = (W - bb.w * ts) / 2 - bb.x0 * ts;
    const toy = (H - bb.h * ts) / 2 - bb.y0 * ts;
    tctx.fillStyle = '#000';
    tctx.fill(pathOf(paths, (x, y) => [tox + x * ts, toy + y * ts]), 'nonzero');
  }

  // ---------- fitted preview ----------
  function updatePreview() {
    const input = $('#reviewChar');
    const key = ST.metrics.charKey(input ? input.value : '');
    cap.record = null;
    if (cap.cand && cap.cand.paths.length && key) cap.record = cap.recordFor(cap.cand, key);
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

  // The letterform as it will be added: upright, fitted, with the Height
  // and Baseline set on the Shape step. Fitting is cached per turn and
  // character, so a Height/Baseline drag only re-applies the nudge.
  cap.recordFor = function (cand, key) {
    const turn = cand.turn || 0;
    let rec = cand._fit && cand._fit.turn === turn && cand._fit.key === key && cand._fit.paths === cand.paths ? cand._fit.rec : null;
    if (!rec) {
      rec = ST.metrics.buildRecord(key, cap.uprightPaths(cand));
      cand._fit = { turn, key, paths: cand.paths, rec };
    }
    if (!rec) return null;
    const n = cand.nudge || {};
    return Object.assign({}, rec, { id: ST.uid(), nudge: Object.assign({}, rec.nudge, { scale: n.scale || 0, dy: n.dy || 0 }) });
  };

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
    // resizing a canvas reallocates it: only when its size really changed
    const bw = Math.round(stage.clientWidth * dpr), bh = Math.round(stage.clientHeight * dpr);
    if (stage.width !== bw || stage.height !== bh) { stage.width = bw; stage.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);

    if (!cap.img) {
      ctx.fillStyle = '#bbb';
      ctx.font = '400 14px "Helvetica Neue", Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(cap.note || 'Drop photos of graffiti here', stage.clientWidth / 2, stage.clientHeight / 2);
      ctx.textAlign = 'start';
      return;
    }

    const v = cap.view;
    ctx.save();
    ctx.translate(v.tx, v.ty);
    ctx.scale(v.scale, v.scale);
    if (v.rot) {
      ctx.translate(cap.img.width / 2, cap.img.height / 2);
      ctx.rotate((v.rot * Math.PI) / 180);
      ctx.translate(-cap.img.width / 2, -cap.img.height / 2);
    }
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
    // the strokes you traced, thin over the paint
    if (item && item.traces && item.traces.length) {
      ctx.strokeStyle = 'rgba(34,211,238,0.95)';
      ctx.lineWidth = 2.5 / v.scale;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const t of item.traces) {
        ctx.beginPath();
        for (let i = 0; i < t.length; i += 2) (i ? ctx.lineTo(t[i], t[i + 1]) : ctx.moveTo(t[i], t[i + 1]));
        ctx.stroke();
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

    // a crop box being drawn: the photo outside it dimmed
    // (the box as it will be cut: square to the photo, turned with it)
    if (dragging && dragging.kind === 'crop' && dragging.moved) {
      const a = dragging.start, b = dragging.last;
      const box = [toScreen(a), toScreen({ x: b.x, y: a.y }), toScreen(b), toScreen({ x: a.x, y: b.y })];
      const poly = () => { ctx.moveTo(box[0].x, box[0].y); for (let k = 1; k < 4; k++) ctx.lineTo(box[k].x, box[k].y); ctx.closePath(); };
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.rect(0, 0, stage.width, stage.height); poly(); ctx.fill('evenodd');
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); poly(); ctx.stroke();
      ctx.setLineDash([]);
    }
    // a stroke being traced, in screen space
    if (dragging && dragging.kind === 'gesture' && dragging.moved && !dragging.alt) {
      const pts = dragging.path;
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        const q = toScreen({ x: pts[i], y: pts[i + 1] });
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
      ctx.stroke();
    }
    // a cut being drawn, in screen space
    if (dragging && dragging.kind === 'gesture' && dragging.moved && dragging.alt) {
      const a = toScreen(dragging.start), b = toScreen(dragging.last);
      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---------- gestures: drag = trace a stroke, click = take a letter,
  // shift-click = add a piece, option-click = take one off, option-drag = cut ----------
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
    if (cap.tool === 'crop') { dragging = { kind: 'crop', start: ip, last: ip, sStart: sp, moved: false }; return; }
    dragging = { kind: 'gesture', start: ip, last: ip, sStart: sp, sLast: sp, moved: false, shift: ev.shiftKey, alt: ev.altKey, path: [ip.x, ip.y] };
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
    // the stroke's path, a point every couple of screen pixels
    if (dragging.path && Math.hypot(sp.x - dragging.sLast.x, sp.y - dragging.sLast.y) >= 2) {
      dragging.path.push(dragging.last.x, dragging.last.y);
      dragging.sLast = sp;
    }
    if (dragging.moved) requestDraw();
  }

  function onPointerUp(ev) {
    const d = dragging;
    dragging = null;
    try { stage.releasePointerCapture(ev.pointerId); } catch (e) { /* released */ }
    if (d && d.kind === 'crop') {
      if (d.moved && cap.item) {
        setTool('trace');
        busy('Cropping and re-reading…', () => ST.batch.cropTo(d.start.x, d.start.y, d.last.x, d.last.y));
      } else requestDraw();
      return;
    }
    if (!d || d.kind !== 'gesture' || !cap.item || !cap.img) { requestDraw(); return; }
    const inside = (p) => p.x >= 0 && p.y >= 0 && p.x < cap.img.width && p.y < cap.img.height;
    if (d.moved && d.alt) {
      // Option-drag: a cut across a join
      if (inside(d.start) || inside(d.last)) busy('Cutting…', () => ST.batch.addCutAsync(d.start.x, d.start.y, d.last.x, d.last.y));
      else requestDraw();
    } else if (d.moved) {
      // a drag: one stroke of the letter, traced
      const path = d.path.slice();
      const last = toImage(stagePos(ev));
      if (last.x !== path[path.length - 2] || last.y !== path[path.length - 1]) path.push(last.x, last.y);
      const W = cap.img.width, H = cap.img.height;
      const onPhoto = path.some((v, i) => i % 2 === 0 && inside({ x: v, y: path[i + 1] }));
      for (let i = 0; i < path.length; i += 2) { path[i] = ST.clamp(path[i], 0, W - 1); path[i + 1] = ST.clamp(path[i + 1], 0, H - 1); }
      if (onPhoto) busy('Tracing the stroke…', () => ST.batch.addTrace(path));
      else requestDraw();
    } else if (d.alt || ev.altKey) {
      // Option-click: take that piece off the shape (a piece completed past
      // the photo's edge can be clicked there too)
      busy('Removing…', () => ST.batch.removeAt(d.start.x, d.start.y));
    } else if (inside(d.start)) {
      if (d.shift || ev.shiftKey) busy('Adding the piece…', () => ST.batch.addPart(d.start.x, d.start.y));
      else busy('Tracing…', () => ST.batch.clickTraceAsync(d.start.x, d.start.y));
    } else {
      requestDraw();
    }
  }

  // Tracing, cutting and re-reading take a moment: say so (the cursor) and
  // let that paint before the work starts. (label: what is being done)
  function busy(label, fn) {
    if (stage) stage.style.cursor = 'progress';
    const done = () => { setTool(cap.tool); requestDraw(); };
    g.requestAnimationFrame(() => g.setTimeout(() => {
      let r;
      try { r = fn(); } catch (e) { done(); throw e; }
      // work handed to the background worker: busy until it is back
      if (r && typeof r.then === 'function') r.then(done, (e) => { done(); console.warn(e); });
      else done();
    }, 0));
  }
  cap.busy = busy;

  function onWheel(ev) {
    if (!cap.img) return;
    ev.preventDefault();
    const sp = stagePos(ev);
    const factor = Math.pow(1.0016, -ev.deltaY);
    const ns = ST.clamp(cap.view.scale * factor, 0.04, 40);
    const ip = turned(toImage(sp), cap.view.rot);
    cap.view.scale = ns;
    cap.view.tx = sp.x - ip.x * ns;
    cap.view.ty = sp.y - ip.y * ns;
    requestDraw();
  }

  function setTool(tool) {
    const was = cap.tool;
    cap.tool = tool;
    const hand = $('#toolHand');
    if (hand) hand.classList.toggle('on', tool === 'hand');
    const crop = $('#toolCrop');
    if (crop) crop.classList.toggle('on', tool === 'crop');
    if (stage) stage.style.cursor = tool === 'hand' ? 'grab' : 'crosshair';
    if (tool === 'crop' && was !== 'crop') ST.toast('Drag a box round the letter to crop the photo to it · Esc cancels');
  }
  cap.setTool = setTool;

  // ---------- init ----------
  cap.init = function () {
    wrap = $('.stage-wrap');
    stage = $('#stage');
    ctx = stage.getContext('2d');
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
    $('#toolCrop').addEventListener('click', () => { if (cap.item) setTool(cap.tool === 'crop' ? 'trace' : 'crop'); });
    g.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cap.tool === 'crop') setTool('trace'); });
    $('#reviewChar').addEventListener('input', updatePreview);
    // Slider drags fire far faster than a redraw: the state changes at
    // once, the drawing once per frame, the (slower) recognizer re-read only
    // when the drag pauses.
    let frame = 0, guessTimer = 0;
    const redraw = (turned) => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawTrace(); updatePreview(); });
      if (turned) { clearTimeout(guessTimer); guessTimer = setTimeout(showGuesses, 180); }
    };
    // (turns the photo on the stage and the letter with it: set by hand,
    // it holds for every letter taken from this photo)
    const turnTo = (deg) => {
      if (!cap.item) return;
      deg = ((((Math.round(deg) + 180) % 360) + 360) % 360) - 180;
      cap.item.manualTurn = deg;
      if (cap.cand) cap.cand.turn = deg;
      setRot(deg);
      syncRotate();
      redraw(true);
    };
    cap.turnTo = turnTo;
    $('#reviewRotate').addEventListener('input', (e) => turnTo(+e.target.value));
    if ($('#toolTurnL')) $('#toolTurnL').addEventListener('click', () => turnTo((cap.view.rot || 0) - 90));
    if ($('#toolTurnR')) $('#toolTurnR').addEventListener('click', () => turnTo((cap.view.rot || 0) + 90));
    const nudgeInput = (key) => (e) => {
      if (!cap.cand) return;
      cap.cand.nudge = Object.assign({ scale: 0, dy: 0 }, cap.cand.nudge, { [key]: +e.target.value });
      syncRotate();
      redraw(false);
    };
    if ($('#reviewScale')) $('#reviewScale').addEventListener('input', nudgeInput('scale'));
    // (the outline smoothed again a beat after the slider stops)
    const smoothSoon = ST.debounce(() => {
      if (!cap.cand || !cap.item) return;
      cap.smoothCand(cap.cand, cap.item.smooth || 0);
      requestDraw();
      redraw(true);
    }, 60);
    if ($('#reviewSmooth')) $('#reviewSmooth').addEventListener('input', (e) => {
      if (!cap.item) return;
      cap.item.smooth = +e.target.value;
      $('#reviewSmoothVal').textContent = e.target.value;
      smoothSoon();
    });
    if ($('#reviewDy')) $('#reviewDy').addEventListener('input', nudgeInput('dy'));

    setTool('trace');
    cap.showItem(null, null);
  };
})(typeof window !== 'undefined' ? window : globalThis);
