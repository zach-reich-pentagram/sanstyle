/* Sanstyle — ui/batch.js
 * The review queue, one photo at a time, shown on the capture stage: the
 * photo with its detected shape boxed and outlined, the trace and the
 * fitted letterform beside it. Type the character, Add to typeface — the
 * queue advances. A photo leaves the queue ONLY when its letterform was
 * added or you hit Skip. The first photo shows as soon as it's analyzed;
 * the rest stream in behind it.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$;

  const batch = (ST.batch = {
    queue: [],       // {name, sourceId, canvas, angle, candidates, ci, cuts, parts, detail}
    idx: 0,          // photos before idx are resolved
    intakeActive: false,
  });

  function remaining() { return Math.max(0, batch.queue.length - batch.idx); }
  batch.remaining = remaining;

  function updateQueuePill() {
    const pill = $('#queuePill');
    if (!pill) return;
    const n = remaining();
    pill.style.display = n ? '' : 'none';
    pill.textContent = `Review queue (${n})`;
  }

  function setProgress() {
    const el = $('#reviewProgress');
    if (!el) return;
    const item = batch.queue[batch.idx];
    if (!item) { el.textContent = batch.intakeActive ? 'Analyzing…' : ''; return; }
    const more = batch.intakeActive ? '+' : '';
    let text = `Photo ${batch.idx + 1} of ${batch.queue.length}${more}`;
    if (item.rect) text += ' · flattened';
    if (item.name && !/^demo-/.test(item.name)) text += ` · ${item.name.length > 28 ? item.name.slice(0, 26) + '…' : item.name}`;
    el.textContent = text;
  }

  // ---------- analysis off the page's thread ----------
  // Straightening a photo and finding its letterforms takes a second or two
  // of number crunching; done here it would freeze the page for every photo
  // in a stack. A background worker (js/worker.js, the same code) does it
  // instead. Where workers can't draw (old browsers), it runs on the page.
  let worker = null, workerOk = true, nextJob = 1;
  const workerJobs = new Map();
  function analysisWorker() {
    if (!workerOk) return null;
    if (worker) return worker;
    try {
      if (typeof g.Worker === 'undefined' || typeof g.OffscreenCanvas === 'undefined' || !g.createImageBitmap) throw new Error('unsupported');
      worker = new g.Worker('js/worker.js');
      worker.onmessage = (e) => {
        const done = workerJobs.get(e.data.id);
        if (done) { workerJobs.delete(e.data.id); done(e.data); }
      };
      worker.onerror = (e) => {
        console.warn('analysis worker failed — analyzing on the page instead', e && e.message);
        workerOk = false;
        worker = null;
        for (const [id, done] of workerJobs) done({ id, ok: false, error: 'worker failed' });
        workerJobs.clear();
      };
    } catch (e) {
      workerOk = false;
      worker = null;
    }
    return worker;
  }

  // one job for the worker, answered in order
  function ask(w, msg, transfer) {
    const id = nextJob++;
    return new Promise((resolve) => {
      workerJobs.set(id, resolve);
      w.postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }

  // The photo's analysis, kept in the worker (the last few used): a photo
  // come back to after many others were read is read again — once, in the
  // background as soon as it is on the stage — so a stroke traced or a
  // letter typed on it is found in its paints, not guessed at.
  function ensureAnalysis(item) {
    const w = analysisWorker();
    if (!w || !item || !item.canvas) return Promise.resolve(null);
    if (item._ensuring) return item._ensuring;
    const canvas = item.canvas;
    const p = (async () => {
      if (item.analysis != null) {
        const r = await ask(w, { type: 'has', analysis: item.analysis });
        if (r.ok && r.has) return item.analysis;
      }
      const bitmap = await g.createImageBitmap(canvas);
      const r = await ask(w, { type: 'reread', bitmap, inPhoto: canvas._inPhoto ? canvas._inPhoto.slice() : null }, [bitmap]);
      if (!r.ok || item.canvas !== canvas) return null;
      item.analysis = r.analysis;
      if (item.original && item.original.canvas === canvas) item.original.analysis = r.analysis;
      return r.analysis;
    })().catch(() => null).finally(() => { item._ensuring = null; });
    item._ensuring = p;
    return p;
  }
  batch.ensureAnalysis = ensureAnalysis;

  batch.analyze = async function (canvas, opts) {
    const w = analysisWorker();
    if (w) {
      try {
        const bitmap = await g.createImageBitmap(canvas);
        const id = nextJob++;
        const r = await new Promise((resolve) => {
          workerJobs.set(id, resolve);
          w.postMessage({ id, bitmap, opts: opts || {} }, [bitmap]);
        });
        if (r.ok) {
          const c = ST.makeCanvas(r.width, r.height);
          c.getContext('2d').drawImage(r.image, 0, 0);
          if (r.image.close) r.image.close();
          if (r.inPhoto) c._inPhoto = r.inPhoto;
          // (`analysis`: the worker keeps what it found, and answers clicks
          // on this photo from it)
          return { canvas: c, angle: r.angle, rect: r.rect || null, analysis: r.analysis, candidates: r.candidates };
        }
        console.warn('analysis in the worker failed — analyzing on the page instead:', r.error);
      } catch (e) {
        console.warn('analysis in the worker failed — analyzing on the page instead:', e);
      }
    }
    return ST.auto.processImage(canvas, opts || {});
  };

  // ---------- intake ----------
  function pushPhoto(canvas, name, sourceId) {
    return pushResult(ST.auto.processImage(canvas, {}), name, sourceId);
  }
  batch.addCanvas = pushPhoto;

  // the same, analyzed in the background
  async function pushPhotoAsync(canvas, name, sourceId) {
    return pushResult(await batch.analyze(canvas, {}), name, sourceId);
  }

  // (front: onto the stage now, ahead of the rest of the queue — what was
  // on it waits right behind, edits and all)
  function pushResult(result, name, sourceId, front) {
    const item = {
      name: name || 'photo',
      sourceId: sourceId || null,
      canvas: result.canvas,
      angle: result.angle,
      rect: result.rect || null,        // the flattening (rectify.js), to find the crop in the photo again
      analysis: result.analysis || null,
      candidates: result.candidates,
      ci: 0,
      // the selection as first made, for Reset
      original: { canvas: result.canvas, angle: result.angle, analysis: result.analysis || null, candidates: result.candidates },
    };
    if (front) batch.queue.splice(batch.idx, 0, item);
    else batch.queue.push(item);
    if (front || batch.idx === batch.queue.length - 1) renderCurrent();
    else setProgress();
    updateQueuePill();
    return result.candidates.length;
  }

  let intakeStart = 0;
  function startIntake() {
    batch.intakeActive = true;
    intakeStart = batch.queue.length;
    if (ST.switchTab) ST.switchTab('capture');
    if (batch.idx >= batch.queue.length) renderCurrent();
    else setProgress();
  }

  function endIntake() {
    batch.intakeActive = false;
    if (batch.queue.length === intakeStart) ST.toast('No photos to review.', 'warn');
    if (batch.idx >= batch.queue.length) renderCurrent();
    else setProgress();
  }

  batch.addFiles = async function (files) {
    const list = Array.from(files);
    if (!list.length) return;
    startIntake();
    const storeInDrive = ST.sync && ST.sync.storeUploadsEnabled();
    let stored = 0;
    for (const file of list) {
      try {
        const canvas = await fileToCanvas(file);
        let sourceId = null;
        if (storeInDrive) {
          try {
            sourceId = await ST.sync.uploadCanvas(canvas, file.name);
            if (sourceId) stored++;
          } catch (e) { console.warn('drive upload failed', e); }
        }
        await pushPhotoAsync(canvas, file.name, sourceId);
      } catch (e) {
        console.warn('auto: skipped', file.name, e);
      }
    }
    if (stored) ST.toast(`${stored} photo${stored === 1 ? '' : 's'} stored in the Drive inbox.`);
    endIntake();
  };

  batch.addRemotePhotos = async function (photos) {
    if (!photos.length) return;
    startIntake();
    const jobs = photos.map((p) => ({ photo: p, promise: null }));
    const kick = (i) => {
      if (jobs[i] && !jobs[i].promise) jobs[i].promise = ST.sync.fetchPhotoCanvas(jobs[i].photo);
    };
    kick(0); kick(1);
    for (let i = 0; i < jobs.length; i++) {
      kick(i + 2);
      try {
        const canvas = await jobs[i].promise;
        await pushPhotoAsync(canvas, jobs[i].photo.name, jobs[i].photo.id);
      } catch (e) {
        console.warn('inbox photo failed', jobs[i].photo.name, e);
      }
    }
    endIntake();
  };

  // One Drive photo picked in the Glyphs gallery: it comes up on the stage
  // now — not at the back of the queue, behind a Re-scan or the inbox's new
  // photos — whether or not it gave letterforms before. A photo still
  // waiting in the queue is brought forward rather than fetched again.
  const opening = new Set();
  batch.openRemotePhoto = async function (photo) {
    if (!photo || !photo.id) return false;
    const ids = photo.copies || [photo.id];
    if (ST.switchTab) ST.switchTab('capture');
    const k = batch.queue.findIndex((q, i) => i >= batch.idx && ids.includes(q.sourceId));
    if (k >= 0) {
      if (k > batch.idx) batch.queue.splice(batch.idx, 0, batch.queue.splice(k, 1)[0]);
      renderCurrent();
      return true;
    }
    if (opening.has(photo.id)) return false; // on its way already
    opening.add(photo.id);
    ST.toast(`Opening ${photo.name || 'the photo'} from Drive…`);
    if (!batch.queue[batch.idx]) ST.capture.setHint('Analyzing…');
    try {
      const canvas = await ST.sync.fetchPhotoCanvas(photo);
      pushResult(await batch.analyze(canvas, {}), photo.name, photo.id, true);
      return true;
    } catch (e) {
      console.warn('drive photo failed', photo.name, e);
      ST.toast(`Could not open ${photo.name || 'that photo'}.`, 'warn');
      if (!batch.queue[batch.idx]) renderCurrent();
      return false;
    } finally {
      opening.delete(photo.id);
    }
  };

  function fileToCanvas(file) {
    return new Promise((resolve, reject) => {
      const done = (src, w, h) => {
        const c = g.document.createElement('canvas');
        const s = Math.min(1, 1800 / Math.max(w, h));
        c.width = Math.round(w * s);
        c.height = Math.round(h * s);
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        resolve(c);
      };
      if (ST.heic && ST.heic.looksHeic(file)) {
        const native = g.createImageBitmap
          ? g.createImageBitmap(file, { imageOrientation: 'from-image' })
          : Promise.reject();
        Promise.resolve(native)
          .then((b) => done(b, b.width, b.height))
          .catch(() => ST.heic.decode(file).then((c) => done(c, c.width, c.height)).catch(reject));
        return;
      }
      g.createImageBitmap(file, { imageOrientation: 'from-image' })
        .then((b) => done(b, b.width, b.height))
        .catch(reject);
    });
  }

  // ---------- rendering ----------

  // Put the current photo and shape on the stage and sync every control.
  function renderCurrent() {
    const item = batch.queue[batch.idx] || null;
    const cand = item ? item.candidates[item.ci] || null : null;
    const input = $('#reviewChar');
    input.value = '';
    input.dataset.typed = '';
    if (item) ensureAnalysis(item);
    ST.capture.showItem(item, cand, { intake: batch.intakeActive });
    // what the shape reads as, filled in (typing replaces it)
    const guess = cand ? (cand.kind === 'typed' ? cand.typed : ST.capture.guess(cand)) : '';
    if (guess) { input.value = guess; ST.capture.updatePreview(); }
    if (cand && cand.kind === 'typed') input.dataset.typed = '1';
    setProgress();
    updateQueuePill();
    showLetters(item);
    if (batch.syncFind) batch.syncFind();
    $('#reviewReset').disabled = !item || !item.original;
    $('#reviewSkip').disabled = !item;
    if (!item) {
      $('#reviewHint').textContent = batch.intakeActive
        ? 'Analyzing the photos…'
        : 'Upload photos or load a demo wall. Each one lands here straightened, with its letterform found.';
      return;
    }
    if (!cand) {
      $('#reviewHint').textContent = 'Nothing traced yet — click the letter in the photo to trace it, or skip the photo.';
    } else {
      $('#reviewHint').textContent = cand.kind === 'traced'
        ? 'Traced from your strokes. Drag along any stroke still missing; ⌘Z takes the last one off.'
        : (item.candidates.length > 1 ? 'Pick the letter below or click it in the photo' : 'Not the letter you want? Click it in the photo') +
          ' — or trace it: drag along each of its strokes, through the strokes that cross it, and the paint under them is taken. Option-click a neighbor to take it off; shift-click a missing piece; Option-drag cuts a join. ⌘Z undoes. Scroll zooms; hold space and drag to pan.';
    }
    const tab = $('#tab-capture');
    if (tab && tab.classList.contains('active')) setTimeout(() => { input.focus(); input.select(); }, 60);
  }
  batch.renderCurrent = renderCurrent;

  // Every letter found in the photo, side by side: one click picks it.
  function thumbOf(cand) {
    if (cand._thumb) return cand._thumb;
    const S = 44, c = g.document.createElement('canvas');
    c.width = S; c.height = S;
    const x = c.getContext('2d');
    const bb = ST.raster.maskBounds(cand.mask, cand.w, cand.h);
    if (bb) {
      const m = g.document.createElement('canvas');
      m.width = bb.w; m.height = bb.h;
      const mx = m.getContext('2d'), id = mx.createImageData(bb.w, bb.h);
      for (let y = 0; y < bb.h; y++) {
        for (let xx = 0; xx < bb.w; xx++) if (cand.mask[(y + bb.y0) * cand.w + xx + bb.x0]) id.data[(y * bb.w + xx) * 4 + 3] = 255;
      }
      mx.putImageData(id, 0, 0);
      const k = (S - 8) / Math.max(bb.w, bb.h);
      x.drawImage(m, (S - bb.w * k) / 2, (S - bb.h * k) / 2, bb.w * k, bb.h * k);
    }
    cand._thumb = c;
    return c;
  }
  function showLetters(item) {
    const strip = $('#letterStrip');
    if (!strip) return;
    strip.textContent = '';
    if (!item || item.candidates.length < 2) { strip.hidden = true; return; }
    strip.hidden = false;
    item.candidates.slice(0, 12).forEach((cand, k) => {
      const b = g.document.createElement('button');
      b.className = 'letter-pick' + (k === item.ci ? ' on' : '');
      const r = cand.read && cand.read.ranked && cand.read.ranked[0];
      b.title = r && cand.read.letterness >= 0.5 ? `Reads as “${r.ch}”` : 'This shape';
      b.appendChild(thumbOf(cand));
      if (r && cand.read.letterness >= 0.5) {
        const t = g.document.createElement('span');
        t.textContent = r.ch;
        b.appendChild(t);
      }
      b.addEventListener('click', () => batch.pick(k));
      strip.appendChild(b);
    });
  }
  batch.pick = function (k) {
    const item = batch.queue[batch.idx];
    if (!item || !item.candidates[k]) return;
    item.ci = k;
    item.pickedCi = k; // (where you are looking now: see findTyped)
    renderCurrent();
  };

  // ---------- click-to-trace, cut, isolate ----------
  // Click-to-trace: canvas-pixel coordinates on the current photo.

  batch.clickTrace = function (x, y, opts) {
    const item = batch.queue[batch.idx];
    if (!item) return 0;
    item.lastClick = { x, y };
    return applyClick(item, ST.extract.seeded(item.canvas, x, y, clickOpts(item)), opts);
  };

  // The same, traced in the background worker: a click on a big, busy
  // photo takes a second or two of work, and the page stays live meanwhile.
  // (Resolves with the shapes offered; a click made meanwhile wins.)
  let clickSeq = 0;
  batch.clickTraceAsync = async function (x, y, opts) {
    const item = batch.queue[batch.idx];
    if (!item) return 0;
    item.lastClick = { x, y };
    const seq = ++clickSeq;
    const res = await seededAsync(item, x, y, clickOpts(item));
    if (seq !== clickSeq || batch.queue[batch.idx] !== item) return 0; // superseded
    return applyClick(item, res, opts);
  };

  const clickOpts = (item) => ({ cuts: item.cuts || null, smoothing: 4 });
  // a photo read again as it is (already flattened and scaled)
  function reread() {
    return { deskew: false, maxEdge: 1e9 };
  }

  function applyClick(item, res, opts) {
    if (!res) {
      ST.toast('Nothing paint-like under that click — try the middle of a stroke.', 'warn');
      return 0;
    }
    if (res.click) item.lastClick = res.click;
    item.pickedCi = null;
    // a plain click starts over on the letter under it; the internal
    // re-traces (Detail, cuts, undo) keep the shift-clicked pieces
    if (!(opts && opts.keepParts)) { item.parts = []; item.removals = []; }
    item.candidates = res.candidates.concat(item.candidates);
    item.ci = 0;
    renderCurrent();
    return res.candidates.length;
  }

  // extract.seeded in the worker, which keeps the photo between clicks
  // (sent once per photo: a crop makes a new one). On the page without one.
  const photoKeys = new WeakMap();
  let photoKeyNext = 1, workerPhoto = null;
  async function seededAsync(item, x, y, opts) {
    const w = analysisWorker();
    if (w) {
      try {
        const cv = item.canvas;
        if (!photoKeys.has(cv)) photoKeys.set(cv, photoKeyNext++);
        const key = photoKeys.get(cv);
        // (answered from the photo's analysis when nothing was cut)
        const msg = { type: 'seeded', key, x, y, opts, analysis: item.analysis, fast: !(opts && (opts.cuts && opts.cuts.length || opts.noSnap)) };
        const transfer = [];
        if (workerPhoto !== key) {
          msg.bitmap = await g.createImageBitmap(cv);
          transfer.push(msg.bitmap);
          if (cv._inPhoto) msg.inPhoto = cv._inPhoto.slice();
          workerPhoto = key;
        }
        const id = nextJob++;
        const r = await new Promise((resolve) => {
          workerJobs.set(id, resolve);
          w.postMessage(Object.assign({ id }, msg), transfer);
        });
        if (r.ok) return r.none ? null : { candidates: r.candidates, click: r.click };
        workerPhoto = null;
        console.warn('click in the worker failed — tracing on the page instead:', r.error);
      } catch (e) {
        workerPhoto = null;
        console.warn('click in the worker failed — tracing on the page instead:', e);
      }
    }
    return ST.extract.seeded(item.canvas, x, y, opts);
  }

  // Shift-click: merge the paint under the click into the current shape —
  // a detached piece (the dot of an i, the point of a !) or a bit that the
  // extraction, a cut or Isolate left out. Only the new ink connected to
  // the click joins; a neighbor that piece touches stays out.
  function mergePart(cur, part, raw, snapped, sw) {
    const x0 = Math.min(cur.crop.x, part.crop.x), y0 = Math.min(cur.crop.y, part.crop.y);
    const x1 = Math.max(cur.crop.x + cur.crop.w, part.crop.x + part.crop.w);
    const y1 = Math.max(cur.crop.y + cur.crop.h, part.crop.y + part.crop.h);
    const w = x1 - x0, h = y1 - y0;
    const base = new Uint8Array(w * h), fresh = new Uint8Array(w * h);
    const paint = (c, into) => {
      for (let y = 0; y < c.h; y++) {
        for (let x = 0; x < c.w; x++) {
          if (c.mask[y * c.w + x]) into[(y + c.crop.y - y0) * w + (x + c.crop.x - x0)] = 1;
        }
      }
    };
    paint(cur, base);
    paint(part, fresh);
    for (let i = 0; i < fresh.length; i++) if (base[i]) fresh[i] = 0;
    // the new ink nearest the click — the raw click first, then where it
    // snapped to (the snap may have jumped onto ink already in the shape)
    const reach = Math.max(4, Math.round(sw * 0.75));
    const nearestFresh = (px, py) => {
      const cx = Math.round(px) - x0, cy = Math.round(py) - y0;
      let best = null, bestD = Infinity;
      for (let y = Math.max(0, cy - reach); y <= Math.min(h - 1, cy + reach); y++) {
        for (let x = Math.max(0, cx - reach); x <= Math.min(w - 1, cx + reach); x++) {
          if (!fresh[y * w + x]) continue;
          const d = (x - cx) ** 2 + (y - cy) ** 2;
          if (d < bestD) { bestD = d; best = { x, y }; }
        }
      }
      return best;
    };
    const at = nearestFresh(raw.x, raw.y) || nearestFresh(snapped.x, snapped.y);
    if (!at) return null;
    const piece = ST.raster.floodFrom(w, h, at.x, at.y, (i) => fresh[i] === 1);
    if (!piece.count) return null;
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = base[i] || piece.mask[i] ? 1 : 0;
    // heal the seam where the piece meets the shape
    const r = Math.max(1, Math.min(6, Math.round(sw * 0.3)));
    mask = ST.raster.close(mask, w, h, r);
    const paths = ST.trace.vectorize(mask, w, h, {});
    if (!paths.length) return null;
    return { crop: { x: x0, y: y0, w, h }, mask, w, h, paths, kind: 'parts' };
  }

  // A stroke-width spot at (x, y): what a shift-click brushes in when the
  // classifier sees no paint there (a glint, a worn patch) — the click itself
  // says there is.
  function discPart(x, y, r, W, H) {
    const cx = Math.round(x), cy = Math.round(y);
    const x0 = Math.max(0, cx - r - 1), y0 = Math.max(0, cy - r - 1);
    const x1 = Math.min(W, cx + r + 2), y1 = Math.min(H, cy + r + 2);
    const w = x1 - x0, h = y1 - y0;
    const mask = new Uint8Array(w * h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const dx = xx + x0 - cx, dy = yy + y0 - cy;
        if (dx * dx + dy * dy <= (r + 0.5) * (r + 0.5)) mask[yy * w + xx] = 1;
      }
    }
    return { crop: { x: x0, y: y0, w, h }, mask, w, h, paths: [], kind: 'brush' };
  }

  const covers = (cand, x, y) => {
    const cx = Math.round(x) - cand.crop.x, cy = Math.round(y) - cand.crop.y;
    return cx >= 0 && cy >= 0 && cx < cand.w && cy < cand.h && !!cand.mask[cy * cand.w + cx];
  };

  batch.addPart = async function (x, y, opts) {
    const o = opts || {};
    const item = batch.queue[batch.idx];
    if (!item) return 0;
    const cur = item.candidates[item.ci];
    if (!cur) return batch.clickTraceAsync(x, y);
    if (covers(cur, x, y)) {
      if (!o.quiet) ST.toast('That spot is already part of the shape.');
      return 0;
    }
    const sw = ST.raster.strokeWidth(cur.mask, cur.w, cur.h);
    // 1. the paint under the click, grown from the click itself (never
    //    snapped away onto the shape that is already there)
    let merged = null;
    // (grown in the background worker: a big photo takes a moment)
    const res = await seededAsync(item, x, y, { cuts: item.cuts || null, smoothing: 4, noSnap: true, noLetters: true });
    if (batch.queue[batch.idx] !== item || item.candidates[item.ci] !== cur) return 0; // moved on meanwhile
    if (res) merged = mergePart(cur, res.candidates[res.candidates.length - 1], { x, y }, res.click || { x, y }, sw);
    // 2. still nothing at the clicked spot: brush in a stroke-width spot
    let brushed = false;
    if (!merged || !covers(merged, x, y)) {
      const base = merged || cur;
      const r = Math.max(3, Math.round(sw * 0.35));
      const disc = mergePart(base, discPart(x, y, r, item.canvas.width, item.canvas.height), { x, y }, { x, y }, sw);
      if (disc) { merged = disc; brushed = true; }
    }
    if (!merged) {
      if (!o.quiet) ST.toast('That spot is already part of the shape.');
      return 0;
    }
    merged.base = cur.base || cur.kind;
    merged.turn = cur.turn;
    item.candidates[item.ci] = merged;
    if (!o.replay) {
      item.parts = (item.parts || []).concat([{ x, y }]);
      item.history = (item.history || []).concat([{ type: 'part' }]);
      const keep = $('#reviewChar').value, keepTyped = $('#reviewChar').dataset.typed;
      renderCurrent();
      $('#reviewChar').value = keep;
      $('#reviewChar').dataset.typed = keepTyped;
      ST.capture.updatePreview();
      ST.toast(brushed ? 'Filled in a stroke-width spot.' : 'Piece added to the shape.');
    }
    return 1;
  };

  // Option-click: take a piece off the shape — the stroke under the click
  // and whatever hangs on the letter only through it (a neighbor fused on,
  // a drip, a stray blob). The letter you clicked stays.
  batch.removeAt = function (x, y, opts) {
    const o = opts || {};
    const item = batch.queue[batch.idx];
    const cur = item && item.candidates[item.ci];
    if (!cur) return 0;
    const anchor = item.lastClick ? { x: item.lastClick.x - cur.crop.x, y: item.lastClick.y - cur.crop.y } : null;
    const res = ST.extract.removePiece(cur.mask, cur.w, cur.h, x - cur.crop.x, y - cur.crop.y, anchor);
    if (!res) {
      if (!o.quiet) ST.toast('Nothing to take off there — Option-click a piece of the outlined shape (not the whole of it).', 'warn');
      return 0;
    }
    const paths = ST.trace.vectorize(res.mask, cur.w, cur.h, {});
    if (!paths.length) return 0;
    item.candidates[item.ci] = { crop: cur.crop, mask: res.mask, w: cur.w, h: cur.h, paths, kind: 'trimmed', base: cur.base || cur.kind, turn: cur.turn, _autoTried: cur._autoTried };
    if (!o.replay) {
      item.removals = (item.removals || []).concat([{ x, y }]);
      item.history = (item.history || []).concat([{ type: 'remove' }]);
      const keep = $('#reviewChar').value, keepTyped = $('#reviewChar').dataset.typed;
      renderCurrent();
      $('#reviewChar').value = keep;
      $('#reviewChar').dataset.typed = keepTyped;
      ST.capture.updatePreview();
      ST.toast('Piece removed — ⌘Z brings it back.');
    }
    return 1;
  };

  // Shift-clicked pieces (and Option-clicked removals) are remembered, so a
  // Detail change, a cut, an undo or an Isolate can rebuild the shape and
  // put them back.
  async function reapplyParts(item) {
    let n = 0;
    for (const p of item.parts || []) n += await batch.addPart(p.x, p.y, { replay: true, quiet: true });
    for (const r of item.removals || []) n += batch.removeAt(r.x, r.y, { replay: true, quiet: true });
    if (n) {
      const keep = $('#reviewChar').value, keepTyped = $('#reviewChar').dataset.typed;
      renderCurrent();
      $('#reviewChar').value = keep;
      $('#reviewChar').dataset.typed = keepTyped;
    }
    return n;
  }

  function cutWidthFor(item) {
    const maxDim = Math.max(item.canvas.width, item.canvas.height);
    const cand = item.candidates[item.ci];
    if (cand) {
      const sw = ST.raster.strokeWidth(cand.mask, cand.w, cand.h);
      // a fused blob reports a bloated stroke width; keep the cut a cut
      if (sw > 2) return Math.max(6, Math.min(Math.round(sw * 1.3), Math.round(maxDim * 0.04)));
    }
    return Math.max(8, Math.round(maxDim * 0.012));
  }

  // A cut is a short stroke drawn across a junction; ink under it is removed
  // before the region is grown again from the last click.
  // Which side of a cut is the letter? The side the last click is on; with
  // no click yet, the side holding more of the current shape's ink — the
  // regrow seeds from that side's ink farthest from the cut, never from
  // the cut's own midpoint (which lands on whichever side comes first).
  function keepSideSeed(item, cut) {
    if (item.lastClick) return item.lastClick;
    const cand = item.candidates[item.ci];
    if (!cand) return { x: (cut.x0 + cut.x1) / 2, y: (cut.y0 + cut.y1) / 2 };
    const dx = cut.x1 - cut.x0, dy = cut.y1 - cut.y0;
    let nA = 0, nB = 0, farA = null, farB = null, dA = -1, dB = -1;
    for (let y = 0; y < cand.h; y += 2) {
      for (let x = 0; x < cand.w; x += 2) {
        if (!cand.mask[y * cand.w + x]) continue;
        const gx = x + cand.crop.x, gy = y + cand.crop.y;
        const side = dx * (gy - cut.y0) - dy * (gx - cut.x0); // sign = side of the cut line
        const d = Math.abs(side) / Math.hypot(dx, dy);
        if (side >= 0) { nA++; if (d > dA) { dA = d; farA = { x: gx, y: gy }; } }
        else { nB++; if (d > dB) { dB = d; farB = { x: gx, y: gy }; } }
      }
    }
    return (nA >= nB ? farA : farB) || { x: (cut.x0 + cut.x1) / 2, y: (cut.y0 + cut.y1) / 2 };
  }

  batch.addCut = function (x0, y0, x1, y1) {
    const item = batch.queue[batch.idx];
    if (!item) return false;
    item.cuts = item.cuts || [];
    const cut = { x0, y0, x1, y1, width: cutWidthFor(item) };
    item.cuts.push(cut);
    const seed = keepSideSeed(item, cut);
    let n = batch.clickTrace(seed.x, seed.y, { keepParts: true });
    if (!n && item.lastClick) n = batch.clickTrace(item.lastClick.x, item.lastClick.y, { keepParts: true });
    item.history = (item.history || []).concat([{ type: 'cut' }]);
    return n > 0;
  };

  // A cut drawn on the stage: regrown in the background worker.
  batch.addCutAsync = async function (x0, y0, x1, y1) {
    const item = batch.queue[batch.idx];
    if (!item) return false;
    item.cuts = item.cuts || [];
    const cut = { x0, y0, x1, y1, width: cutWidthFor(item) };
    item.cuts.push(cut);
    item.history = (item.history || []).concat([{ type: 'cut' }]);
    const seed = keepSideSeed(item, cut);
    const was = item.lastClick;
    let n = await batch.clickTraceAsync(seed.x, seed.y, { keepParts: true });
    if (!n && was && batch.queue[batch.idx] === item) n = await batch.clickTraceAsync(was.x, was.y, { keepParts: true });
    await reapplyParts(item);
    return n > 0;
  };

  // Rebuild the shape from what's left: the last click (or the automatic
  // shapes), the remaining cuts, the remaining added pieces.
  async function rebuild(item) {
    const keep = $('#reviewChar').value, keepTyped = $('#reviewChar').dataset.typed;
    const cur = item.candidates[item.ci];
    const want = cur ? cur.base || cur.kind : null;
    if (item.lastClick) {
      const n = await batch.clickTraceAsync(item.lastClick.x, item.lastClick.y, { keepParts: true });
      // back on the kind of shape that was being worked on (the whole, not
      // the letter the click offers first)
      const k = item.candidates.slice(0, n).findIndex((c) => c.kind === want);
      if (k > 0) { item.ci = k; renderCurrent(); }
    } else {
      const res = await batch.analyze(item.canvas, reread(item));
      if (batch.queue[batch.idx] !== item) return;
      item.candidates = res.candidates;
      item.analysis = res.analysis || null;
      item.ci = 0;
      renderCurrent();
    }
    await reapplyParts(item);
    $('#reviewChar').value = keep;
    $('#reviewChar').dataset.typed = keepTyped;
    ST.capture.updatePreview();
  }

  // Reset: the photo and its shapes as the automatic pass first read them —
  // no crop, clicks, cuts, pieces or turn.
  batch.resetItem = function () {
    const item = batch.queue[batch.idx];
    if (!item || !item.original) return false;
    const keep = $('#reviewChar').value, keepTyped = $('#reviewChar').dataset.typed;
    Object.assign(item, {
      canvas: item.original.canvas, angle: item.original.angle, analysis: item.original.analysis, candidates: item.original.candidates, ci: 0,
      cuts: [], parts: [], removals: [], lastClick: null, history: [], manualTurn: null, traces: [], pickedCi: null, smooth: 0,
    });
    for (const c of item.candidates) { c.turn = c.lean ? -c.lean : 0; c.nudge = null; }
    renderCurrent();
    if (!item.candidates.length) { $('#reviewChar').value = keep; $('#reviewChar').dataset.typed = keepTyped; }
    ST.toast('Back to the automatic selection.');
    return true;
  };

  // Crop the photo to a box (photo px) and read it again: a letter that is
  // a small part of a busy photo gets the whole frame — its paint judged
  // against its own wall, and enlarged for detail when small. The cuts,
  // clicks and pieces were placed on the old frame, so they go; ⌘Z brings
  // the uncropped photo back as it was.
  batch.cropTo = async function (x0, y0, x1, y1) {
    const item = batch.queue[batch.idx];
    if (!item) return false;
    const W = item.canvas.width, H = item.canvas.height;
    const ax = Math.max(0, Math.round(Math.min(x0, x1))), ay = Math.max(0, Math.round(Math.min(y0, y1)));
    const bx = Math.min(W, Math.round(Math.max(x0, x1))), by = Math.min(H, Math.round(Math.max(y0, y1)));
    const w = bx - ax, h = by - ay;
    if (w < 24 || h < 24) { ST.toast('Drag a bigger box to crop.', 'warn'); return false; }
    const c = ST.makeCanvas(w, h);
    c.getContext('2d').drawImage(item.canvas, ax, ay, w, h, 0, 0, w, h);
    if (item.canvas._inPhoto) {
      const src = item.canvas._inPhoto, v = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) v.set(src.subarray((y + ay) * W + ax, (y + ay) * W + ax + w), y * w);
      c._inPhoto = v;
    }
    const prev = {
      canvas: item.canvas, angle: item.angle, analysis: item.analysis, candidates: item.candidates, ci: item.ci,
      cuts: item.cuts, parts: item.parts, removals: item.removals, lastClick: item.lastClick,
      history: item.history, manualTurn: item.manualTurn, traces: item.traces, _beforeTrace: item._beforeTrace,
    };
    // (read at its own size: a small letter cropped out gets the detail back)
    const res = await batch.analyze(c, { deskew: false, maxEdge: 900 });
    if (batch.queue[batch.idx] !== item) return false; // moved on meanwhile
    res.canvas._frame = ST.sources.subFrame(item.canvas, ax, ay, w, h); // where it lies in the photo
    const keep = $('#reviewChar').value, keepTyped = $('#reviewChar').dataset.typed;
    // (the turn set by hand holds: the crop is of the same photo)
    Object.assign(item, { canvas: res.canvas, analysis: res.analysis || null, candidates: res.candidates, ci: 0, cuts: [], parts: [], removals: [], lastClick: null, traces: [] });
    item.history = [{ type: 'crop', prev }];
    renderCurrent();
    if (keep.trim() && !res.candidates.length) { $('#reviewChar').value = keep; $('#reviewChar').dataset.typed = keepTyped; }
    ST.toast(res.candidates.length ? 'Cropped — ⌘Z brings the whole photo back.' : 'Cropped, but no letter found in the box — click it, or ⌘Z.');
    return true;
  };

  // ---------- a letter you trace ----------
  // Drag along the letter's strokes on the photo — one drag a stroke — and
  // the paint under them is taken as the letter (typed.js): your strokes
  // are its skeleton, carried through whatever crosses them. Each stroke
  // traced reads the letter again with all of them; ⌘Z takes the last off.
  async function traceAsync(item) {
    const strokes = item.traces || [];
    // (how far off the paint a hand's line may be: a few pointer widths,
    // in the photo's px at the zoom you traced at)
    const tol = 28 / ((ST.capture.view && ST.capture.view.scale) || 1);
    const w = analysisWorker();
    if (w) {
      try {
        let r = null;
        for (let tries = 0; tries < 2; tries++) {
          const key = await ensureAnalysis(item);
          if (key == null) break;
          r = await ask(w, { type: 'strokes', analysis: key, strokes, tol });
          if (r.ok || r.error !== 'no analysis') break;
        }
        if (r && r.ok) return r.none ? null : r.candidates[0];
        console.warn('tracing in the worker failed — tracing on the page instead:', r && r.error);
      } catch (e) {
        console.warn('tracing in the worker failed — tracing on the page instead:', e);
      }
    }
    // (no worker: the photo read on the page, once, for its paints)
    if (!item._pageRead || item._pageRead.canvas !== item.canvas) {
      const res = ST.auto.processImage(item.canvas, { deskew: false, maxEdge: Math.max(item.canvas.width, item.canvas.height) });
      item._pageRead = { canvas: item.canvas, src: { W: res.canvas.width, H: res.canvas.height, paints: res.paints || [], shapes: res.shapes || [], data: ST.extract.flatData(res.canvas).data, inPhoto: item.canvas._inPhoto || null } };
    }
    return ST.typed.traceStrokes(strokes, item._pageRead.src, { tol });
  }

  // (the candidates as they were before the first stroke: Reset and ⌘Z of
  // the last stroke come back to them)
  // (a character you typed stays; one filled in for the shape before is
  // replaced by what the traced letter reads as)
  function showTraced(item, found, keep) {
    item.candidates = [found].concat(item.candidates.filter((c) => c.kind !== 'traced'));
    item.ci = 0;
    item.pickedCi = null;
    renderCurrent();
    if (keep) {
      $('#reviewChar').value = keep;
      $('#reviewChar').dataset.typed = '1';
      ST.capture.updatePreview();
    }
  }
  const typedChar = () => ($('#reviewChar').dataset.typed ? $('#reviewChar').value : '');

  batch.addTrace = async function (path) {
    const item = batch.queue[batch.idx];
    if (!item || !path || path.length < 6) return false;
    const keep = typedChar();
    if (!item.traces || !item.traces.length) item._beforeTrace = { candidates: item.candidates, ci: item.ci };
    item.traces = (item.traces || []).concat([path]);
    item.history = (item.history || []).concat([{ type: 'trace' }]);
    const seq = (item._traceSeq = (item._traceSeq || 0) + 1);
    const found = await traceAsync(item);
    if (batch.queue[batch.idx] !== item || item._traceSeq !== seq) return false; // moved on meanwhile
    if (!found) {
      item.traces.pop();
      item.history.pop();
      ST.capture.requestDraw();
      ST.toast('No paint under that stroke — trace along the letter itself.', 'warn');
      return false;
    }
    showTraced(item, found, keep);
    return true;
  };

  // ---------- a letter typed: looked for in the photo ----------
  // Type the character you see and the photo is searched for it (typed.js):
  // the character's strokes are fitted onto the paint's own — the shape
  // you are looking at first, then the photo's other shapes — and drawn
  // stroke by stroke, carried on through the strokes of the letters that
  // cross it. Runs in the background worker, where the photo's analysis is.
  async function typedAsync(item, ch, first, hint, hintWeight) {
    const w = analysisWorker();
    const key = w ? await ensureAnalysis(item) : null;
    if (w && key != null) {
      try {
        const f = first ? { crop: first.crop, mask: first.mask.slice(), w: first.w, h: first.h } : null;
        const r = await ask(w, { type: 'typed', analysis: key, ch, first: f, hint, hintWeight }, f ? [f.mask.buffer] : []);
        if (r.ok) return r.none ? null : r.candidates[0];
        console.warn('typed search in the worker failed — searching on the page instead:', r.error);
      } catch (e) {
        console.warn('typed search in the worker failed — searching on the page instead:', e);
      }
    }
    const shapes = ((item.original && item.original.candidates) || item.candidates).filter((c) => c.kind !== 'typed');
    return ST.typed.findIn(shapes, ch, { first, hint, hintWeight, budgetMs: 9000 });
  }

  batch.findTyped = async function (chIn, opts) {
    const o = opts || {};
    const item = batch.queue[batch.idx];
    const ch = chIn || batch.charKey($('#reviewChar').value);
    if (!item || !ch || ch.length !== 1 || !ST.typed) return false;
    // the shape you are looking at (not one found for another character)
    const cur = item.candidates.find((c, k) => k >= item.ci && c.kind !== 'typed') || item.candidates.find((c) => c.kind !== 'typed') || null;
    // where you are looking: where you clicked, else the letter you picked
    // in the strip, else the middle of the photo (the letter you are after
    // is usually the one you framed)
    const picked = item.pickedCi != null ? item.candidates[item.pickedCi] : null;
    const hint = picked ? { x: picked.crop.x + picked.w / 2, y: picked.crop.y + picked.h / 2 }
      : item.lastClick || { x: item.canvas.width / 2, y: item.canvas.height / 2 };
    const hintWeight = picked ? 0.2 : item.lastClick ? 0.25 : 0.08;
    const seq = (item._typedSeq = (item._typedSeq || 0) + 1);
    const found = await typedAsync(item, ch, cur, hint, hintWeight);
    if (batch.queue[batch.idx] !== item || item._typedSeq !== seq) return false; // moved on meanwhile
    const keep = $('#reviewChar').value, keepTyped = $('#reviewChar').dataset.typed;
    if (!found) {
      if (!o.quiet) ST.toast(`Couldn't find a “${ch}” here — click it in the photo, then type it again.`, 'warn');
      return false;
    }
    item.history = (item.history || []).concat([{ type: 'typed', prev: { candidates: item.candidates, ci: item.ci } }]);
    item.candidates = [found].concat(item.candidates.filter((c) => !(c.kind === 'typed' && c.typed === ch)));
    item.ci = 0;
    item.pickedCi = null;
    renderCurrent();
    $('#reviewChar').value = keep;
    $('#reviewChar').dataset.typed = keepTyped;
    ST.capture.updatePreview();
    ST.toast(`Found the “${ch}” — ⌘Z brings the other shapes back.`);
    return true;
  };

  // ⌘Z: the last cut or added piece, most recent first.
  batch.undo = function () {
    const item = batch.queue[batch.idx];
    if (!item || !item.history || !item.history.length) return false;
    const last = item.history.pop();
    if (last.type === 'crop') {
      Object.assign(item, last.prev);
      renderCurrent();
      ST.toast('Crop undone.');
      return true;
    }
    if (last.type === 'trace') {
      const keep = typedChar();
      if (item.traces && item.traces.length) item.traces.pop();
      if (!item.traces || !item.traces.length) {
        if (item._beforeTrace) Object.assign(item, item._beforeTrace);
        renderCurrent();
        if (keep) { $('#reviewChar').value = keep; $('#reviewChar').dataset.typed = '1'; ST.capture.updatePreview(); }
        ST.toast('Traced stroke taken off.');
        return true;
      }
      return traceAsync(item).then((found) => {
        if (found && batch.queue[batch.idx] === item) showTraced(item, found, keep);
        ST.toast('Traced stroke taken off.');
        return true;
      });
    }
    if (last.type === 'typed') {
      const keep = $('#reviewChar').value, keepTyped = $('#reviewChar').dataset.typed;
      Object.assign(item, last.prev);
      renderCurrent();
      $('#reviewChar').value = keep;
      $('#reviewChar').dataset.typed = keepTyped;
      ST.capture.updatePreview();
      ST.toast('Back to the shapes found before.');
      return true;
    }
    if (last.type === 'cut' && item.cuts && item.cuts.length) item.cuts.pop();
    else if (last.type === 'part' && item.parts && item.parts.length) item.parts.pop();
    else if (last.type === 'remove' && item.removals && item.removals.length) item.removals.pop();
    return Promise.resolve(rebuild(item)).then(() => {
      ST.toast({ cut: 'Cut undone.', part: 'Added piece undone.', remove: 'Removed piece is back.' }[last.type] || 'Undone.');
      return true;
    });
  };

  // The most recent cut specifically; anything added after it stays.
  batch.undoCut = function () {
    const item = batch.queue[batch.idx];
    if (!item || !item.cuts || !item.cuts.length) return;
    item.cuts.pop();
    if (item.history) {
      const k = item.history.map((a) => a.type).lastIndexOf('cut');
      if (k >= 0) item.history.splice(k, 1);
    }
    return rebuild(item);
  };

  // The library key for what was typed: one character, or a ligature of
  // two to four letters/digits ("ar", "bl", "gr").
  batch.charKey = function (value) { return ST.metrics.charKey(value); };

  // A small JPEG of the photo around the shape, kept (locally) with the
  // letterform so the tester can show where a letter came from.
  batch.sourceThumb = function (item, cand) {
    return ST.capture.sourceThumb(item.canvas, cand.crop);
  };

  // ---------- actions ----------
  function advance(note) {
    batch.idx++;
    renderCurrent();
    const done = batch.idx >= batch.queue.length && !batch.intakeActive;
    if (note) ST.toast(note + (done ? ' — the queue is finished.' : ' — next photo.'));
  }

  batch.accept = function () {
    const item = batch.queue[batch.idx];
    if (!item) return false;
    const cand = item.candidates[item.ci];
    if (!cand) return false;
    const ch = batch.charKey($('#reviewChar').value);
    if (!ch) { ST.toast('Type the character first.', 'warn'); return false; }
    const record = ST.capture.recordFor(cand, ch);
    if (!record) { ST.toast('Could not fit that shape.', 'warn'); return false; }
    record.thumb = ST.capture.makeThumb(record);
    // which photo, and where in it: the crop can be cut again on any device
    const from = ST.sources.photoOf(item, cand.crop);
    if (from) record.photo = from;
    const add = () => {
      ST.store.addVariant(ch, record);
      if (ST.sources) ST.sources.put(record.id, batch.sourceThumb(item, cand));
      if (item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
    };
    // the same character taken from this photo before: one design of it per
    // photo — you pick which
    const slot = ST.store.slot(ch);
    const same = slot ? slot.variants.filter((v) => samePhoto(v, item)) : [];
    if (same.length) { pickOne(ch, record, same, item, add); return false; }
    add();
    advance(ch.length > 1 ? `“${ch}” added as a ligature` : `“${ch}” added`);
    return true;
  };

  // (a letterform cut from this photo: the Drive photo it came from, or —
  // an upload not stored in Drive — the file of the same name)
  function samePhoto(v, item) {
    const p = v && v.photo;
    if (!p) return false;
    if (item.sourceId) return p.id === item.sourceId;
    return !p.id && !!item.name && p.name === item.name;
  }

  // The one to keep, of this photo's designs of a character: the new one
  // (the ones before go), or one kept before (the new one and the rest go).
  // Cancel leaves everything as it was.
  function pickOne(ch, record, same, item, add) {
    const modal = $('#dupModal');
    if (!modal) { add(); advance(`“${ch}” added`); return; }
    if (modal.classList.contains('open')) return;
    const close = () => { modal.classList.remove('open'); g.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    const drop = (list) => {
      for (const v of list) {
        const s = ST.store.slot(ch);
        const k = s ? s.variants.indexOf(v) : -1;
        if (k >= 0) ST.store.deleteVariant(ch, k);
      }
    };
    $('#dupTitle').textContent = `You already added “${ch}” from this photo. Which one do you want to keep?`;
    const picks = $('#dupPicks');
    picks.textContent = '';
    const card = (thumb, label, onPick) => {
      const b = g.document.createElement('button');
      b.className = 'dup-pick';
      const img = g.document.createElement('img');
      if (thumb) img.src = thumb;
      img.alt = label;
      const span = g.document.createElement('span');
      span.textContent = label;
      b.append(img, span);
      b.addEventListener('click', () => { close(); onPick(); });
      picks.appendChild(b);
    };
    const thumbOf = (v) => { try { return v.thumb || ST.capture.makeThumb(v); } catch (e) { return null; } };
    same.forEach((v, k) => card(thumbOf(v), same.length > 1 ? `Added before (${k + 1})` : 'Added before', () => {
      drop(same.filter((u) => u !== v));
      const s = ST.store.slot(ch);
      if (s) ST.store.setActive(ch, s.variants.indexOf(v));
      if (item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
      advance(`Kept the “${ch}” from before`);
    }));
    card(record.thumb, 'New', () => {
      drop(same);
      add();
      advance(`“${ch}” replaced`);
    });
    $('#dupCancel').onclick = close;
    g.addEventListener('keydown', onKey, true);
    modal.classList.add('open');
  }
  batch.pickOne = pickOne;

  batch.tryNext = function () {
    const item = batch.queue[batch.idx];
    if (!item || item.candidates.length < 2) return;
    item.ci = (item.ci + 1) % item.candidates.length;
    renderCurrent();
  };

  batch.skip = function () {
    const item = batch.queue[batch.idx];
    if (!item) return;
    if (item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
    advance('Photo skipped');
  };

  // Bring the queue's current photo back onto the stage (the topbar pill).
  batch.reopen = function () {
    if (ST.switchTab) ST.switchTab('capture');
    renderCurrent();
  };

  batch.init = function () {
    $('#reviewAccept').addEventListener('click', batch.accept);
    $('#reviewReset').addEventListener('click', () => batch.resetItem());
    $('#reviewSkip').addEventListener('click', batch.skip);
    const busy = (label, fn) => (ST.capture.busy ? ST.capture.busy(label, fn) : fn());
    // ⌘Z / Ctrl-Z on the capture tab undoes the last cut or added piece
    g.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key !== 'z' && e.key !== 'Z')) return;
      const tab = $('#tab-capture');
      if (!tab || !tab.classList.contains('active')) return;
      if (e.target && e.target.isContentEditable) return;
      const item = batch.queue[batch.idx];
      if (!item || !item.history || !item.history.length) return;
      e.preventDefault();
      busy('Undoing…', () => batch.undo());
    });
    $('#queuePill').addEventListener('click', batch.reopen);
    $('#reviewChar').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); batch.accept(); }
    });
    // typing a character the shape doesn't read as: the photo is searched
    // for it (a pause after the key, so a character typed over is not)
    const findBtn = $('#reviewFind');
    const syncFind = () => {
      const ch = batch.charKey($('#reviewChar').value);
      if (!findBtn) return;
      findBtn.disabled = !batch.queue[batch.idx] || ch.length !== 1;
      findBtn.textContent = ch.length === 1 ? `Find “${ch}” in the photo` : 'Find the letter I typed';
    };
    batch.syncFind = syncFind;
    $('#reviewChar').addEventListener('input', syncFind);
    $('#reviewChar').addEventListener('input', () => { $('#reviewChar').dataset.typed = $('#reviewChar').value ? '1' : ''; });
    $('#reviewChar').addEventListener('input', ST.debounce(() => {
      const item = batch.queue[batch.idx];
      const ch = batch.charKey($('#reviewChar').value);
      if (!item || ch.length !== 1) return;
      const cur = item.candidates[item.ci];
      if (cur && cur.kind === 'typed' && cur.typed === ch) return;
      // (a letter you traced is the letter: typing only names it)
      if (cur && cur.kind === 'traced') return;
      // (a shape that already reads plainly as it needs no search)
      const read = cur ? ST.capture.readOf(cur) : null;
      if (read) {
        const want = new Set(ST.typed ? ST.typed.cases(ch) : [ch]);
        let p = 0;
        for (const r of read.ranked) if (want.has(r.ch)) p += r.p;
        if (p >= 0.55 && read.letterness >= 0.7) return;
      }
      busy(`Finding “${ch}” in the photo…`, () => batch.findTyped(ch, { quiet: true }));
    }, 550));
    if (findBtn) findBtn.addEventListener('click', () => busy('Finding the letter in the photo…', () => batch.findTyped()));
    ST.store.on('change', updateQueuePill);
    renderCurrent();
  };
})(typeof window !== 'undefined' ? window : globalThis);
