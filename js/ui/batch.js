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
    if (!cand) {
      $('#reviewHint').textContent = 'Nothing traced in this photo — Edit manually, or Skip.';
      $('#reviewAccept').disabled = true;
      $('#reviewAlt').disabled = true;
    } else {
      $('#reviewAccept').disabled = false;
      $('#reviewAlt').disabled = item.candidates.length < 2;
      $('#reviewHint').textContent =
        `Shape ${item.ci + 1} of ${item.candidates.length} · type the character and add it. ` +
        'If the trace grabbed a neighbor or looks off, Edit manually.';
    }
    setTimeout(() => input.focus(), 60);
  }
  batch.renderCurrent = renderCurrent;

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
    const ch = ($('#reviewChar').value || '').slice(-1);
    if (!ch || ch === ' ') { ST.toast('Type the character first.', 'warn'); return false; }
    const record = ST.metrics.buildRecord(ch, cand.paths);
    if (!record) { ST.toast('Could not fit that shape.', 'warn'); return false; }
    record.thumb = ST.capture.makeThumb(record);
    ST.store.addVariant(ch, record);
    if (item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
    ST.toast(`“${ch}” added — next photo.`);
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

  // Called by the capture studio after any successful "Add to typeface".
  batch.onStudioSubmit = function () {
    if (!batch.checkedOut) return;
    const item = batch.checkedOut;
    batch.checkedOut = null;
    const qi = batch.queue.indexOf(item);
    if (qi >= 0 && qi >= batch.idx) {
      if (item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
      batch.queue.splice(qi, 1);
      if (qi < batch.idx) batch.idx--;
    }
    updateQueuePill();
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
