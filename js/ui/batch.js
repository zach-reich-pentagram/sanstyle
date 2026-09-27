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
    if (item.angle) text += ` · straightened ${item.angle > 0 ? '−' : '+'}${Math.abs(item.angle)}°`;
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
          return { canvas: c, angle: r.angle, candidates: r.candidates };
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

  function pushResult(result, name, sourceId) {
    batch.queue.push({
      name: name || 'photo',
      sourceId: sourceId || null,
      canvas: result.canvas,
      angle: result.angle,
      candidates: result.candidates,
      ci: 0,
    });
    if (batch.idx === batch.queue.length - 1) renderCurrent();
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
  function syncIsolateLabel() {
    const key = batch.charKey($('#reviewChar').value);
    $('#reviewIsolate').textContent = key.length === 1 ? `Isolate “${key}”` : 'Isolate';
  }

  // Put the current photo and shape on the stage and sync every control.
  function renderCurrent() {
    const item = batch.queue[batch.idx] || null;
    const cand = item ? item.candidates[item.ci] || null : null;
    const input = $('#reviewChar');
    input.value = '';
    ST.capture.showItem(item, cand, { intake: batch.intakeActive });
    // what the shape reads as, filled in (typing replaces it)
    const guess = cand ? ST.capture.guess(cand) : '';
    if (guess) { input.value = guess; ST.capture.updatePreview(); }
    setProgress();
    updateQueuePill();
    syncIsolateLabel();
    $('#reviewDetail').value = item ? item.detail || 5 : 5;
    $('#reviewDetail').disabled = !item;
    $('#reviewAlt').disabled = !item || item.candidates.length < 2;
    $('#reviewIsolate').disabled = !cand;
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
      const kindNote = { separated: ' (separated from a touching neighbor)', letter: ' (the letter alone — what was fused onto it taken off)', isolated: ' (isolated)', parts: ' (with added pieces)', trimmed: ' (pieces removed)' }[cand.kind] || '';
      $('#reviewHint').textContent =
        `Shape ${item.ci + 1} of ${item.candidates.length}${kindNote}. ` +
        'Wrong shape? Click the letter in the photo. Fused with a neighbor? Type the character, Option-click the neighbor to take it off, or drag a cut across the join. ' +
        'Missing a piece (a dot, a point, a bit that got cut off)? Shift-click it. ⌘Z undoes the last change.';
    }
    const tab = $('#tab-capture');
    if (tab && tab.classList.contains('active')) setTimeout(() => { input.focus(); input.select(); }, 60);
  }
  batch.renderCurrent = renderCurrent;

  // ---------- click-to-trace, cut, isolate ----------
  // Click-to-trace: canvas-pixel coordinates on the current photo.
  // The review's Detail knob (1–9) is the extraction's smoothing, inverted:
  // low detail heals gaps and smooths hard, high detail keeps every nuance.
  function smoothingFor(item) { return 9 - (item.detail || 5); }
  batch.smoothingFor = smoothingFor;

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

  const clickOpts = (item) => ({ cuts: item.cuts || null, smoothing: smoothingFor(item) });

  function applyClick(item, res, opts) {
    if (!res) {
      ST.toast('Nothing paint-like under that click — try the middle of a stroke.', 'warn');
      return 0;
    }
    if (res.click) item.lastClick = res.click;
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
        const msg = { type: 'seeded', key, x, y, opts };
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

  batch.addPart = function (x, y, opts) {
    const o = opts || {};
    const item = batch.queue[batch.idx];
    if (!item) return 0;
    const cur = item.candidates[item.ci];
    if (!cur) return batch.clickTrace(x, y);
    if (covers(cur, x, y)) {
      if (!o.quiet) ST.toast('That spot is already part of the shape.');
      return 0;
    }
    const sw = ST.raster.strokeWidth(cur.mask, cur.w, cur.h);
    // 1. the paint under the click, grown from the click itself (never
    //    snapped away onto the shape that is already there)
    let merged = null;
    const res = ST.extract.seeded(item.canvas, x, y, { cuts: item.cuts || null, smoothing: smoothingFor(item), noSnap: true });
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
      const keep = $('#reviewChar').value;
      renderCurrent();
      $('#reviewChar').value = keep;
      syncIsolateLabel();
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
      const keep = $('#reviewChar').value;
      renderCurrent();
      $('#reviewChar').value = keep;
      syncIsolateLabel();
      ST.capture.updatePreview();
      ST.toast('Piece removed — ⌘Z brings it back.');
    }
    return 1;
  };

  // Shift-clicked pieces (and Option-clicked removals) are remembered, so a
  // Detail change, a cut, an undo or an Isolate can rebuild the shape and
  // put them back.
  function reapplyParts(item) {
    let n = 0;
    for (const p of item.parts || []) n += batch.addPart(p.x, p.y, { replay: true, quiet: true });
    for (const r of item.removals || []) n += batch.removeAt(r.x, r.y, { replay: true, quiet: true });
    if (n) {
      const keep = $('#reviewChar').value;
      renderCurrent();
      $('#reviewChar').value = keep;
      syncIsolateLabel();
    }
    return n;
  }

  // Re-extract the current photo at a new Detail setting: the automatic
  // shapes again, then the last click on top of them, then the isolation
  // that was applied — so the knob feels like it turns the shape itself.
  // (the automatic pass runs in the background worker: the page stays live)
  batch.setDetail = async function (v) {
    const item = batch.queue[batch.idx];
    if (!item) return;
    item.detail = v;
    const keep = $('#reviewChar').value;
    const wasIsolated = !!(item.candidates[item.ci] && item.candidates[item.ci].kind === 'isolated');
    const res = await batch.analyze(item.canvas, { deskew: false, noUpscale: true, smoothing: smoothingFor(item) });
    if (item.detail !== v || batch.queue[batch.idx] !== item) return; // moved on meanwhile
    item.candidates = res.candidates;
    item.ci = 0;
    if (item.lastClick) batch.clickTrace(item.lastClick.x, item.lastClick.y, { keepParts: true });
    else renderCurrent();
    reapplyParts(item);
    $('#reviewChar').value = keep;
    syncIsolateLabel();
    if (wasIsolated && keep.trim()) batch.isolate({ quiet: true });
  };

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
    reapplyParts(item);
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
    reapplyParts(item);
    return n > 0;
  };

  // Rebuild the shape from what's left: the last click (or the automatic
  // shapes), the remaining cuts, the remaining added pieces.
  async function rebuild(item) {
    const keep = $('#reviewChar').value;
    const cur = item.candidates[item.ci];
    const want = cur ? cur.base || cur.kind : null;
    if (item.lastClick) {
      const n = batch.clickTrace(item.lastClick.x, item.lastClick.y, { keepParts: true });
      // back on the kind of shape that was being worked on (the whole, not
      // the letter the click offers first)
      const k = item.candidates.slice(0, n).findIndex((c) => c.kind === want);
      if (k > 0) { item.ci = k; renderCurrent(); }
    } else {
      const res = await batch.analyze(item.canvas, { deskew: false, noUpscale: true, smoothing: smoothingFor(item) });
      if (batch.queue[batch.idx] !== item) return;
      item.candidates = res.candidates;
      item.ci = 0;
      renderCurrent();
    }
    reapplyParts(item);
    $('#reviewChar').value = keep;
    syncIsolateLabel();
    ST.capture.updatePreview();
  }

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
      canvas: item.canvas, angle: item.angle, candidates: item.candidates, ci: item.ci,
      cuts: item.cuts, parts: item.parts, removals: item.removals, lastClick: item.lastClick,
      history: item.history, manualTurn: item.manualTurn,
    };
    const res = await batch.analyze(c, { deskew: false, smoothing: smoothingFor(item) });
    if (batch.queue[batch.idx] !== item) return false; // moved on meanwhile
    const keep = $('#reviewChar').value;
    Object.assign(item, { canvas: res.canvas, candidates: res.candidates, ci: 0, cuts: [], parts: [], removals: [], lastClick: null, manualTurn: null });
    item.history = [{ type: 'crop', prev }];
    renderCurrent();
    if (keep.trim() && !res.candidates.length) $('#reviewChar').value = keep;
    ST.toast(res.candidates.length ? 'Cropped — ⌘Z brings the whole photo back.' : 'Cropped, but no letter found in the box — click it, or ⌘Z.');
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
    if (last.type === 'isolate') {
      // back to the shape as it was before the trim
      const k = item.candidates.findIndex((c) => c.kind === 'isolated');
      if (k >= 0) item.candidates.splice(k, 1);
      // back on the shape that was trimmed
      item.ci = last.ci != null && last.ci < item.candidates.length ? last.ci : 0;
      const keep = $('#reviewChar').value;
      renderCurrent();
      $('#reviewChar').value = keep;
      syncIsolateLabel();
      ST.capture.updatePreview();
      ST.toast('Trim undone.');
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

  // "Isolate the 2": template-guided trim of a shape to the typed
  // character, keeping the piece under the last click — the strokes that
  // leave the character's box (a neighbor's) are cut off at their joins,
  // and the joins healed. → { cand, res } or null
  function isolatedCandidate(item, cand, ch) {
    const lc = item.lastClick
      ? { x: item.lastClick.x - cand.crop.x, y: item.lastClick.y - cand.crop.y }
      : { x: cand.w / 2, y: cand.h / 2 };
    // where the character sits: the best few placements of its template;
    // each trims the shape, and the trim that looks most like the character
    // wins (the best-matching box can still take a bit of the neighbor)
    const found = ST.classify.locate(cand.mask, cand.w, cand.h, ch, { cx: lc.x, cy: lc.y, alternatives: 3 });
    // every reading, ranked on the raw trim (cheap); only the front
    // runners are cleaned up and traced
    const trims = [];
    for (const place of (found && (found.alternatives || [found])) || []) {
      // a loose match still says which strokes are the neighbor's; only a
      // hopeless one is refused
      const res = ST.classify.isolate(cand.mask, cand.w, cand.h, ch, lc.x, lc.y, 0.18, { found: place });
      if (!res) continue;
      const strokes = res.margin ? ST.extract.isolateStrokes(cand.mask, cand.w, cand.h, res.margin, lc.x, lc.y) : null;
      trims.push({ mask: strokes ? strokes.mask : res.mask, res });
    }
    // and stroke by stroke: from the stroke clicked, the touching strokes
    // that make the shape most like the character
    const grown = ST.extract.growLetter(cand.mask, cand.w, cand.h, lc.x, lc.y, (m) => ST.classify.scoreMask(m, cand.w, cand.h, ch));
    if (grown) trims.push({ mask: grown.mask, res: { score: grown.score }, whole: true });
    // and the recognizer's: the strokes under the click grouped the way
    // that reads most like the character typed
    const reads = readsAs(ch);
    if (reads) {
      const found = ST.letters.find(cand.mask, cand.w, cand.h, { center: lc, must: lc, target: ch });
      const lt = found && found.letters[0];
      if (lt && lt.set.size < found.sc.n) trims.push({ mask: ST.letters.render(found, cand.mask, cand.w, cand.h, lt), res: { score: 0 }, whole: true });
    }
    // ranked by how much each trim reads as the character: the recognizer
    // when there is one, else the font templates. A trim made of whole
    // strokes ends each one the way the paint does (round, at its join);
    // a template's box can slice a stroke on a slant and leave a point — so
    // when the two read about as well, the whole strokes win.
    const bonus = (t) => (reads && t.whole ? 0.05 : 0);
    for (const t of trims) {
      const p = reads ? reads(t.mask, cand.w, cand.h) : ST.classify.scoreMask(t.mask, cand.w, cand.h, ch);
      t.rank = p + bonus(t);
      if (reads) t.res = Object.assign({}, t.res, { score: p });
    }
    trims.sort((a, b) => b.rank - a.rank);
    let best = null;
    for (const t of trims.slice(0, 2)) {
      const got = trimTo(cand, t.mask, t.res);
      if (!got) continue;
      got.fit = reads ? reads(got.cand.mask, got.cand.w, got.cand.h) + bonus(t) : ST.classify.scoreFor(got.cand.paths, ch);
      if (!best || got.fit > best.fit) best = got;
    }
    return best;
  }

  // How much a mask reads as `ch` (either case), by the recognizer — or null
  // without one (then the font templates judge).
  function readsAs(ch) {
    if (!ST.letters || !ST.recognize || !ST.recognize.ready() || !ch || ch.length !== 1) return null;
    const want = new Set([ch, ch.toUpperCase(), ch.toLowerCase()]);
    if (!ST.recognize.classes().some((c) => want.has(c))) return null; // not a character it knows
    return (mask, w, h) => {
      const r = ST.recognize.classify(mask, w, h);
      if (!r) return 0;
      let p = 0;
      for (const x of r.ranked) if (want.has(x.ch)) p += x.p;
      return p * r.letterness;
    };
  }

  function trimTo(cand, trimmed, res) {
    const clean = ST.extract.cleanMask(trimmed, cand.w, cand.h, 4);
    // re-crop to the isolated letter so the photo pane boxes just it
    const bb = ST.raster.maskBounds(clean, cand.w, cand.h);
    if (!bb) return null;
    const pad = 10;
    const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
    const x1 = Math.min(cand.w, bb.x1 + 1 + pad), y1 = Math.min(cand.h, bb.y1 + 1 + pad);
    const cw = x1 - x0, chh = y1 - y0;
    const sub = new Uint8Array(cw * chh);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) sub[y * cw + x] = clean[(y + y0) * cand.w + (x + x0)];
    const paths = ST.trace.vectorize(sub, cw, chh, {});
    if (!paths.length) return null;
    const crop = { x: cand.crop.x + x0, y: cand.crop.y + y0, w: cw, h: chh };
    return { cand: { crop, mask: sub, w: cw, h: chh, paths, kind: 'isolated', base: cand.base || cand.kind }, res };
  }

  function showIsolated(item, got) {
    item._beforeIsolate = item.ci;
    item.candidates.unshift(got.cand);
    item.ci = 0;
    reapplyParts(item);
    const keep = $('#reviewChar').value;
    renderCurrent();
    $('#reviewChar').value = keep;
    syncIsolateLabel();
    ST.capture.updatePreview();
  }

  batch.isolate = function (opts) {
    const quiet = !!(opts && opts.quiet);
    const item = batch.queue[batch.idx];
    const cand = item && item.candidates[item.ci];
    const ch = batch.charKey($('#reviewChar').value);
    if (!cand || !ch) { ST.toast('Type the character first, then Isolate.', 'warn'); return false; }
    if (ch.length > 1) { ST.toast('Isolate works one character at a time — type just the letter to trim to.', 'warn'); return false; }
    if (!ST.classify) return false;
    const got = isolatedCandidate(item, cand, ch);
    if (!got) {
      ST.toast(`Couldn't find a “${ch}” inside this shape — try a cut across the join, or Edit manually.`, 'warn');
      return false;
    }
    cand._autoTried = ch;
    showIsolated(item, got);
    if (quiet) return true;
    item.history = (item.history || []).concat([{ type: 'isolate', ci: item._beforeIsolate }]);
    const pct = Math.round(got.res.score * 100);
    if (got.res.score < 0.3) {
      ST.toast(`Trimmed to the best “${ch}” match found (only ${pct}%) — check the trace; Try another shape brings the full shape back.`, 'warn');
    } else {
      ST.toast(`Isolated a “${ch}” (match ${pct}%).`);
    }
    return true;
  };

  // Typing the character is enough: when the shape is a letter fused with
  // a neighbor of the same paint (touching it, crossing it, running into
  // it), it is trimmed to the typed character by itself — but only when
  // the trimmed shape matches that character clearly better than the whole
  // did, and something neighbor-sized came off. ⌘Z (or Try another shape)
  // brings the whole shape back.
  batch.autoIsolate = function () {
    const item = batch.queue[batch.idx];
    const cand = item && item.candidates[item.ci];
    if (!cand || !ST.classify || cand.kind === 'isolated') return false;
    const ch = batch.charKey($('#reviewChar').value);
    if (!ch || ch.length !== 1 || cand._autoTried === ch) return false;
    cand._autoTried = ch;
    // a shape that already reads as the character has nothing fused to it
    const reads = readsAs(ch);
    const whole = reads ? reads(cand.mask, cand.w, cand.h) : ST.classify.scoreFor(cand.paths, ch);
    if (whole >= (reads ? 0.6 : 0.5)) return false;
    const got = isolatedCandidate(item, cand, ch);
    if (!got) return false;
    const before = ST.raster.count(cand.mask), after = ST.raster.count(got.cand.mask);
    if (after > 0.85 * before || after < 0.2 * before) return false;
    const trimmed = got.fit;
    if (!(trimmed >= 0.3 && trimmed >= whole + (reads ? 0.15 : 0.06))) return false;
    got.cand._autoTried = ch;
    showIsolated(item, got);
    item.history = (item.history || []).concat([{ type: 'isolate', ci: item._beforeIsolate }]);
    ST.toast(`Trimmed the neighbor off the “${ch}” — ⌘Z brings it back.`);
    return true;
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
    ST.store.addVariant(ch, record);
    if (ST.sources) ST.sources.put(record.id, batch.sourceThumb(item, cand));
    if (item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
    advance(ch.length > 1 ? `“${ch}” added as a ligature` : `“${ch}” added`);
    return true;
  };

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
    $('#reviewAlt').addEventListener('click', batch.tryNext);
    $('#reviewSkip').addEventListener('click', batch.skip);
    $('#reviewIsolate').addEventListener('click', () => busy('Isolating…', () => batch.isolate()));
    const busy = (label, fn) => (ST.capture.busy ? ST.capture.busy(label, fn) : fn());
    $('#reviewDetail').addEventListener('input', ST.debounce((e) => { const v = +e.target.value; busy('Re-reading the photo…', () => batch.setDetail(v)); }, 220));
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
    $('#reviewChar').addEventListener('input', syncIsolateLabel);
    $('#reviewChar').addEventListener('input', ST.debounce(() => batch.autoIsolate(), 380));
    $('#queuePill').addEventListener('click', batch.reopen);
    $('#reviewChar').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); batch.accept(); }
    });
    ST.store.on('change', updateQueuePill);
    renderCurrent();
  };
})(typeof window !== 'undefined' ? window : globalThis);
