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

  // ---------- intake ----------
  function pushPhoto(canvas, name, sourceId) {
    const result = ST.auto.processImage(canvas, {});
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
  batch.addCanvas = pushPhoto;

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
        pushPhoto(canvas, file.name, sourceId);
      } catch (e) {
        console.warn('auto: skipped', file.name, e);
      }
      await new Promise((r) => setTimeout(r, 10));
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
        pushPhoto(canvas, jobs[i].photo.name, jobs[i].photo.id);
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
    setProgress();
    updateQueuePill();
    syncIsolateLabel();
    $('#reviewDetail').value = item ? item.detail || 5 : 5;
    $('#reviewDetail').disabled = !item;
    $('#reviewUndoCut').style.display = item && item.cuts && item.cuts.length ? '' : 'none';
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
      const kindNote = { separated: ' (separated from a touching neighbor)', isolated: ' (isolated)', parts: ' (with added pieces)' }[cand.kind] || '';
      $('#reviewHint').textContent =
        `Shape ${item.ci + 1} of ${item.candidates.length}${kindNote}. ` +
        'Wrong shape? Click the letter in the photo. Fused with a neighbor? Drag a cut across the join, or type the character and Isolate. ' +
        'Missing a piece (a dot, a point, a bit that got cut off)? Shift-click it.';
    }
    const tab = $('#tab-capture');
    if (tab && tab.classList.contains('active')) setTimeout(() => input.focus(), 60);
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
    const res = ST.extract.seeded(item.canvas, x, y, { cuts: item.cuts || null, smoothing: smoothingFor(item) });
    if (!res) {
      ST.toast('Nothing paint-like under that click — try the middle of a stroke.', 'warn');
      return 0;
    }
    if (res.click) item.lastClick = res.click;
    // a plain click starts over on the letter under it; the internal
    // re-traces (Detail, cuts, undo) keep the shift-clicked pieces
    if (!(opts && opts.keepParts)) item.parts = [];
    item.candidates = res.candidates.concat(item.candidates);
    item.ci = 0;
    renderCurrent();
    return res.candidates.length;
  };

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

  batch.addPart = function (x, y, opts) {
    const o = opts || {};
    const item = batch.queue[batch.idx];
    if (!item) return 0;
    const cur = item.candidates[item.ci];
    if (!cur) return batch.clickTrace(x, y);
    const res = ST.extract.seeded(item.canvas, x, y, { cuts: item.cuts || null, smoothing: smoothingFor(item) });
    if (!res) {
      if (!o.quiet) ST.toast('Nothing paint-like under that click — try the middle of the piece.', 'warn');
      return 0;
    }
    const whole = res.candidates[res.candidates.length - 1];
    const sw = ST.raster.strokeWidth(cur.mask, cur.w, cur.h);
    const merged = mergePart(cur, whole, { x, y }, res.click || { x, y }, sw);
    if (!merged) {
      if (!o.quiet) ST.toast('That piece is already part of the shape.');
      return 0;
    }
    item.candidates[item.ci] = merged;
    if (!o.replay) {
      item.parts = (item.parts || []).concat([{ x, y }]);
      const keep = $('#reviewChar').value;
      renderCurrent();
      $('#reviewChar').value = keep;
      syncIsolateLabel();
      ST.toast('Piece added to the shape.');
    }
    return 1;
  };

  // Shift-clicked pieces are remembered, so a Detail change, a cut, an undo
  // or an Isolate can rebuild the shape and put them back.
  function reapplyParts(item) {
    let n = 0;
    for (const p of item.parts || []) n += batch.addPart(p.x, p.y, { replay: true, quiet: true });
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
  batch.setDetail = function (v) {
    const item = batch.queue[batch.idx];
    if (!item) return;
    item.detail = v;
    const keep = $('#reviewChar').value;
    const wasIsolated = !!(item.candidates[item.ci] && item.candidates[item.ci].kind === 'isolated');
    const res = ST.auto.processImage(item.canvas, { deskew: false, noUpscale: true, smoothing: smoothingFor(item) });
    item.candidates = res.candidates;
    item.ci = 0;
    if (item.lastClick) batch.clickTrace(item.lastClick.x, item.lastClick.y, { keepParts: true });
    else renderCurrent();
    reapplyParts(item);
    $('#reviewChar').value = keep;
    syncIsolateLabel();
    if (wasIsolated && keep.trim()) batch.isolate();
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
    $('#reviewUndoCut').style.display = '';
    return n > 0;
  };

  batch.undoCut = function () {
    const item = batch.queue[batch.idx];
    if (!item || !item.cuts || !item.cuts.length) return;
    item.cuts.pop();
    if (item.lastClick) {
      batch.clickTrace(item.lastClick.x, item.lastClick.y, { keepParts: true });
      reapplyParts(item);
    } else renderCurrent();
    if (!item.cuts.length) $('#reviewUndoCut').style.display = 'none';
  };

  // "Isolate the 2": template-guided trim of the current shape to the typed
  // character, keeping the piece under the last click.
  batch.isolate = function () {
    const item = batch.queue[batch.idx];
    const cand = item && item.candidates[item.ci];
    const ch = batch.charKey($('#reviewChar').value);
    if (!cand || !ch) { ST.toast('Type the character first, then Isolate.', 'warn'); return false; }
    if (ch.length > 1) { ST.toast('Isolate works one character at a time — type just the letter to trim to.', 'warn'); return false; }
    if (!ST.classify) return false;
    const lc = item.lastClick
      ? { x: item.lastClick.x - cand.crop.x, y: item.lastClick.y - cand.crop.y }
      : { x: cand.w / 2, y: cand.h / 2 };
    // a loose match still says which strokes are the neighbor's; only a
    // hopeless one is refused (the previous shape stays under Try another)
    const res = ST.classify.isolate(cand.mask, cand.w, cand.h, ch, lc.x, lc.y, 0.18);
    if (!res) {
      ST.toast(`Couldn't find a “${ch}” inside this shape — try a cut across the join, or Edit manually.`, 'warn');
      return false;
    }
    // strokes that leave the box are a neighbor's: drop them at their joins
    const strokes = res.margin ? ST.extract.isolateStrokes(cand.mask, cand.w, cand.h, res.margin, lc.x, lc.y) : null;
    const clean = ST.extract.cleanMask(strokes ? strokes.mask : res.mask, cand.w, cand.h, 4);
    // re-crop to the isolated letter so the photo pane boxes just it
    const bb = ST.raster.maskBounds(clean, cand.w, cand.h);
    if (!bb) return false;
    const pad = 10;
    const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
    const x1 = Math.min(cand.w, bb.x1 + 1 + pad), y1 = Math.min(cand.h, bb.y1 + 1 + pad);
    const cw = x1 - x0, chh = y1 - y0;
    const sub = new Uint8Array(cw * chh);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) sub[y * cw + x] = clean[(y + y0) * cand.w + (x + x0)];
    const paths = ST.trace.vectorize(sub, cw, chh, {});
    if (!paths.length) return false;
    const crop = { x: cand.crop.x + x0, y: cand.crop.y + y0, w: cw, h: chh };
    item.candidates.unshift({ crop, mask: sub, w: cw, h: chh, paths, kind: 'isolated' });
    item.ci = 0;
    reapplyParts(item);
    const keep = $('#reviewChar').value;
    renderCurrent();
    $('#reviewChar').value = keep;
    syncIsolateLabel();
    const pct = Math.round(res.score * 100);
    if (res.score < 0.3) {
      ST.toast(`Trimmed to the best “${ch}” match found (only ${pct}%) — check the trace; Try another shape brings the full shape back.`, 'warn');
    } else {
      ST.toast(`Isolated a “${ch}” (match ${pct}%).`);
    }
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
    const record = ST.metrics.buildRecord(ch, cand.paths);
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
    $('#reviewIsolate').addEventListener('click', batch.isolate);
    $('#reviewUndoCut').addEventListener('click', batch.undoCut);
    $('#reviewDetail').addEventListener('input', ST.debounce((e) => batch.setDetail(+e.target.value), 220));
    $('#reviewChar').addEventListener('input', syncIsolateLabel);
    $('#queuePill').addEventListener('click', batch.reopen);
    $('#reviewChar').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); batch.accept(); }
    });
    ST.store.on('change', updateQueuePill);
    renderCurrent();
  };
})(typeof window !== 'undefined' ? window : globalThis);
