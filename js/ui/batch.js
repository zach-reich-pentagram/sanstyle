/* Sanstyle — ui/batch.js
 * The review queue, one photo at a time: the photo on the left with the
 * detected shape boxed, the smoothed trace on the right. Type the character,
 * Add to typeface — the queue advances. A photo leaves the queue ONLY when
 * its letterform was added or you hit Skip; Edit manually checks it out to
 * the studio (added there → it clears; abandoned → it stays queued); Save
 * for later parks everything, including across reloads for Drive photos.
 * The first photo shows as soon as it's analyzed; the rest stream behind.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$;

  const batch = (ST.batch = {
    queue: [],       // {name, sourceId, canvas, angle, candidates, ci}
    idx: 0,          // photos before idx are resolved
    checkedOut: null, // photo sent to the studio, awaiting its submit
    intakeActive: false,
  });

  const modal = () => $('#reviewModal');
  function show() { modal().classList.add('open'); }
  function hide() { modal().classList.remove('open'); updateQueuePill(); }
  function isOpen() { return modal().classList.contains('open'); }

  function remaining() {
    return Math.max(0, batch.queue.length - batch.idx) + (batch.checkedOut ? 0 : 0);
  }

  function updateQueuePill() {
    const pill = $('#queuePill');
    if (!pill) return;
    const n = remaining();
    pill.style.display = n && !isOpen() ? '' : 'none';
    pill.textContent = `Review queue (${n})`;
  }

  function setProgress() {
    const item = batch.queue[batch.idx];
    const more = batch.intakeActive ? '+' : '';
    let text = `Photo ${Math.min(batch.idx + 1, batch.queue.length)} of ${batch.queue.length}${more}`;
    if (item && item.angle) text += ` · auto-straightened ${item.angle > 0 ? '−' : '+'}${Math.abs(item.angle)}°`;
    $('#reviewProgress').textContent = text;
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
    if (isOpen() && batch.idx === batch.queue.length - 1) renderCurrent();
    else if (isOpen()) setProgress();
    updateQueuePill();
    return result.candidates.length;
  }
  batch.addCanvas = pushPhoto;

  function startIntake() {
    batch.intakeActive = true;
    show();
    if (batch.idx >= batch.queue.length) {
      $('#reviewBody').style.display = 'none';
      $('#reviewSpinner').style.display = '';
      $('#reviewSpinner').textContent = 'Analyzing…';
    }
  }

  function endIntake() {
    batch.intakeActive = false;
    if (!isOpen()) return;
    if (batch.idx >= batch.queue.length) {
      hide();
      ST.toast('No photos to review.', 'warn');
    } else {
      setProgress();
    }
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

  function renderCurrent() {
    const item = batch.queue[batch.idx];
    if (!item) {
      if (batch.intakeActive) {
        $('#reviewBody').style.display = 'none';
        $('#reviewSpinner').style.display = '';
        return;
      }
      hide();
      ST.toast('Review queue finished.');
      return;
    }
    show();
    $('#reviewSpinner').style.display = 'none';
    $('#reviewBody').style.display = '';
    setProgress();

    const cand = item.candidates[item.ci] || null;

    // left: the whole photo, current shape boxed
    const srcC = $('#reviewSource');
    const sc = srcC.getContext('2d');
    sc.clearRect(0, 0, srcC.width, srcC.height);
    const s = Math.min(srcC.width / item.canvas.width, srcC.height / item.canvas.height);
    const dw = item.canvas.width * s, dh = item.canvas.height * s;
    const ox = (srcC.width - dw) / 2, oy = (srcC.height - dh) / 2;
    sc.imageSmoothingEnabled = true;
    sc.drawImage(item.canvas, ox, oy, dw, dh);
    if (cand) {
      sc.strokeStyle = '#3b82f6';
      sc.lineWidth = 2;
      sc.strokeRect(ox + cand.crop.x * s, oy + cand.crop.y * s, cand.crop.w * s, cand.crop.h * s);
    }

    // right: the smoothed trace
    const traceC = $('#reviewTrace');
    const tc = traceC.getContext('2d');
    tc.clearRect(0, 0, traceC.width, traceC.height);
    if (cand) {
      const bb = ST.trace.boundsOf(cand.paths);
      if (bb) {
        const ts = Math.min((traceC.width - 24) / bb.w, (traceC.height - 24) / bb.h);
        const tox = (traceC.width - bb.w * ts) / 2 - bb.x0 * ts;
        const toy = (traceC.height - bb.h * ts) / 2 - bb.y0 * ts;
        const path = new Path2D();
        for (const p of cand.paths) {
          const cs = p.cubics;
          path.moveTo(tox + cs[0][0].x * ts, toy + cs[0][0].y * ts);
          for (const cu of cs) {
            path.bezierCurveTo(tox + cu[1].x * ts, toy + cu[1].y * ts,
              tox + cu[2].x * ts, toy + cu[2].y * ts, tox + cu[3].x * ts, toy + cu[3].y * ts);
          }
          path.closePath();
        }
        tc.fillStyle = '#000';
        tc.fill(path, 'nonzero');
      }
    }

    const input = $('#reviewChar');
    input.value = '';
    syncIsolateLabel();
    $('#reviewDetail').value = item.detail || 5;
    $('#reviewUndoCut').style.display = item.cuts && item.cuts.length ? '' : 'none';
    if (!cand) {
      $('#reviewHint').textContent =
        'Nothing traced yet — click the letter in the photo to trace it, or Skip.';
      $('#reviewAccept').disabled = true;
      $('#reviewAlt').disabled = true;
      $('#reviewIsolate').disabled = true;
    } else {
      $('#reviewAccept').disabled = false;
      $('#reviewIsolate').disabled = false;
      $('#reviewAlt').disabled = item.candidates.length < 2;
      const kindNote = { separated: ' (separated from a touching neighbor)', isolated: ' (isolated)', parts: ' (with added pieces)' }[cand.kind] || '';
      $('#reviewHint').textContent =
        `Shape ${item.ci + 1} of ${item.candidates.length}${kindNote} · type the character (two letters for a ligature) and add it. ` +
        'Wrong shape? Click the letter in the photo. Fused with a neighbor? Drag a cut across the join, or type the character and Isolate. ' +
        'Missing a piece (a dot, a point, a bit that got cut off)? Shift-click it.';
    }
    // draw any cuts on the photo pane
    if (item.cuts && item.cuts.length) {
      const c = srcC.getContext('2d');
      c.strokeStyle = 'rgba(225,29,72,0.85)';
      c.lineWidth = 3;
      for (const cut of item.cuts) {
        c.beginPath();
        c.moveTo(ox + cut.x0 * s, oy + cut.y0 * s);
        c.lineTo(ox + cut.x1 * s, oy + cut.y1 * s);
        c.stroke();
      }
    }
    setTimeout(() => input.focus(), 60);
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

  // Pane gesture: click = trace that letter, drag = cut across a junction.
  let paneDrag = null;
  function paneToCanvas(e) {
    const item = batch.queue[batch.idx];
    const cnv = $('#reviewSource');
    const rect = cnv.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (cnv.width / rect.width);
    const py = (e.clientY - rect.top) * (cnv.height / rect.height);
    const s = Math.min(cnv.width / item.canvas.width, cnv.height / item.canvas.height);
    const ox = (cnv.width - item.canvas.width * s) / 2, oy = (cnv.height - item.canvas.height * s) / 2;
    return { x: (px - ox) / s, y: (py - oy) / s, s, ox, oy, px, py };
  }

  function onPanePointerDown(e) {
    const item = batch.queue[batch.idx];
    if (!item || e.button !== 0) return;
    const p = paneToCanvas(e);
    paneDrag = { start: p, last: p, moved: false, shift: e.shiftKey };
    $('#reviewSource').setPointerCapture(e.pointerId);
  }

  function onPanePointerMove(e) {
    if (!paneDrag) return;
    const p = paneToCanvas(e);
    if (Math.hypot(p.px - paneDrag.start.px, p.py - paneDrag.start.py) > 6) paneDrag.moved = true;
    paneDrag.last = p;
    if (paneDrag.moved) {
      renderCurrent();
      const c = $('#reviewSource').getContext('2d');
      c.strokeStyle = '#e11d48';
      c.lineWidth = 3;
      c.setLineDash([6, 4]);
      c.beginPath();
      c.moveTo(paneDrag.start.px, paneDrag.start.py);
      c.lineTo(p.px, p.py);
      c.stroke();
      c.setLineDash([]);
    }
  }

  function onPanePointerUp(e) {
    if (!paneDrag) return;
    const d = paneDrag;
    paneDrag = null;
    try { $('#reviewSource').releasePointerCapture(e.pointerId); } catch (err) { /* released */ }
    const item = batch.queue[batch.idx];
    if (!item) return;
    const inside = (p) => p.x >= 0 && p.y >= 0 && p.x < item.canvas.width && p.y < item.canvas.height;
    if (d.moved) {
      if (inside(d.start) || inside(d.last)) batch.addCut(d.start.x, d.start.y, d.last.x, d.last.y);
      else renderCurrent();
    } else if (inside(d.start)) {
      // shift-click adds a piece to the shape; a plain click traces afresh
      if (d.shift || e.shiftKey) batch.addPart(d.start.x, d.start.y);
      else batch.clickTrace(d.start.x, d.start.y);
    }
  }

  // The library key for what was typed: one character, or a ligature of
  // two to four letters/digits ("ar", "bl", "gr").
  batch.charKey = function (value) { return ST.metrics.charKey(value); };

  // A small JPEG of the photo around the shape, kept (locally) with the
  // letterform so the tester can show where a letter came from.
  batch.sourceThumb = function (item, cand) {
    return ST.capture.sourceThumb(item.canvas, cand.crop);
  };

  // ---------- actions ----------
  function advance() {
    batch.idx++;
    renderCurrent();
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
    ST.toast(ch.length > 1 ? `“${ch}” added as a ligature — next photo.` : `“${ch}” added — next photo.`);
    advance();
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
    if (item && item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
    advance();
  };

  batch.editManually = function () {
    const item = batch.queue[batch.idx];
    if (!item) return;
    ST.capture.useBitmap(item.canvas, item.canvas.width, item.canvas.height);
    ST.capture.skipFlatten();
    const cand = item.candidates[item.ci] || item.candidates[0];
    if (cand) {
      const cr = cand.crop;
      ST.capture.lasso = [
        { x: cr.x, y: cr.y }, { x: cr.x + cr.w, y: cr.y },
        { x: cr.x + cr.w, y: cr.y + cr.h }, { x: cr.x, y: cr.y + cr.h },
      ];
      ST.capture.runExtraction(true);
    }
    // Checked out, NOT resolved: only a studio submit (or a later Skip)
    // releases this photo from the queue.
    batch.checkedOut = item;
    hide();
    if (g.__st && g.__st.switchTab) g.__st.switchTab('capture');
    ST.toast('Loaded into the studio. Adding it there clears the photo from the queue.');
  };

  // Called by the capture studio after any successful "Add to typeface":
  // clears the checked-out photo and brings up the next one automatically.
  batch.onStudioSubmit = function () {
    if (!batch.checkedOut) return;
    const item = batch.checkedOut;
    batch.checkedOut = null;
    const qi = batch.queue.indexOf(item);
    if (qi >= 0 && qi >= batch.idx) {
      if (item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
      batch.queue.splice(qi, 1);
    }
    updateQueuePill();
    if (remaining()) setTimeout(renderCurrent, 250);
  };

  batch.close = function () {
    batch.checkedOut = null;
    hide();
    if (remaining()) {
      ST.toast(`${remaining()} photo${remaining() === 1 ? '' : 's'} saved for later — reopen from “Review queue”.`);
    }
  };

  batch.reopen = function () {
    batch.checkedOut = null;
    if (remaining()) renderCurrent();
  };

  batch.init = function () {
    $('#autoBtn').addEventListener('click', () => $('#autoInput').click());
    $('#autoInput').addEventListener('change', (e) => {
      if (e.target.files.length) batch.addFiles(e.target.files);
      e.target.value = '';
    });
    $('#reviewAccept').addEventListener('click', batch.accept);
    $('#reviewAlt').addEventListener('click', batch.tryNext);
    $('#reviewSkip').addEventListener('click', batch.skip);
    $('#reviewEdit').addEventListener('click', batch.editManually);
    $('#reviewClose').addEventListener('click', batch.close);
    $('#reviewIsolate').addEventListener('click', batch.isolate);
    $('#reviewUndoCut').addEventListener('click', batch.undoCut);
    $('#reviewDetail').addEventListener('input', ST.debounce((e) => batch.setDetail(+e.target.value), 220));
    const pane = $('#reviewSource');
    pane.addEventListener('pointerdown', onPanePointerDown);
    pane.addEventListener('pointermove', onPanePointerMove);
    pane.addEventListener('pointerup', onPanePointerUp);
    pane.addEventListener('pointercancel', () => { paneDrag = null; });
    $('#reviewChar').addEventListener('input', syncIsolateLabel);
    $('#queuePill').addEventListener('click', batch.reopen);
    $('#reviewChar').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); batch.accept(); }
    });
    g.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); batch.close(); }
    });
    ST.store.on('change', updateQueuePill);
  };
})(typeof window !== 'undefined' ? window : globalThis);
