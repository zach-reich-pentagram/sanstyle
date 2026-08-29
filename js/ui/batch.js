/* SANSTYLE — ui/batch.js
 * The automated lane. Single or batch photo upload → auto straighten →
 * detect letter candidates → trace → guess the character — then a
 * one-by-one review: accept, retag, skip, or bail out to the manual studio.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$;

  const batch = (ST.batch = {
    queue: [],       // [{sourceName, canvas, candidate}]
    idx: 0,
    processing: false,
  });

  function show() { $('#reviewModal').classList.add('open'); }
  function hide() { $('#reviewModal').classList.remove('open'); }

  function setProgress(text) {
    $('#reviewProgress').textContent = text;
  }

  // ---------- intake ----------
  batch.addFiles = async function (files) {
    const list = Array.from(files);
    if (!list.length) return;
    batch.processing = true;
    show();
    $('#reviewBody').style.display = 'none';
    $('#reviewSpinner').style.display = '';
    let found = 0, stored = 0;
    const storeInDrive = ST.sync && ST.sync.storeUploadsEnabled();
    for (let i = 0; i < list.length; i++) {
      setProgress(`Analyzing photo ${i + 1} of ${list.length}…`);
      try {
        const canvas = await fileToCanvas(list[i]);
        let sourceId = null;
        if (storeInDrive) {
          try {
            sourceId = await ST.sync.uploadCanvas(canvas, list[i].name);
            if (sourceId) { stored++; ST.sync.markProcessed(sourceId); }
          } catch (e) {
            console.warn('drive upload failed', e);
          }
        }
        found += batch.addCanvas(canvas, list[i].name, sourceId);
      } catch (e) {
        console.warn('auto: skipped', list[i].name, e);
      }
      await new Promise((r) => setTimeout(r, 10)); // let the UI breathe
    }
    batch.processing = false;
    $('#reviewSpinner').style.display = 'none';
    if (stored) ST.toast(`${stored} photo${stored === 1 ? '' : 's'} stored in the Drive inbox.`);
    if (!batch.queue.length) {
      hide();
      ST.toast('No letterforms detected — try the manual capture flow.', 'warn');
      return;
    }
    ST.toast(`${found} letterform${found === 1 ? '' : 's'} detected. Review each one.`);
    batch.idx = Math.min(batch.idx, batch.queue.length - 1);
    renderCurrent();
  };

  // Photos already sitting in the Drive inbox.
  batch.addRemotePhotos = async function (photos) {
    batch.processing = true;
    show();
    $('#reviewBody').style.display = 'none';
    $('#reviewSpinner').style.display = '';
    let found = 0, empty = 0;
    for (let i = 0; i < photos.length; i++) {
      setProgress(`Fetching photo ${i + 1} of ${photos.length} from Drive…`);
      try {
        const canvas = await ST.sync.fetchPhotoCanvas(photos[i]);
        const n = batch.addCanvas(canvas, photos[i].name, photos[i].id);
        found += n;
        if (!n) { empty++; ST.sync.markProcessed(photos[i].id); }
      } catch (e) {
        console.warn('inbox photo failed', photos[i].name, e);
      }
    }
    batch.processing = false;
    $('#reviewSpinner').style.display = 'none';
    if (!batch.queue.length) {
      hide();
      ST.toast(empty
        ? `No letterforms detected in ${empty} photo${empty === 1 ? '' : 's'} — marked as reviewed.`
        : 'Nothing to review.', 'warn');
      return;
    }
    ST.toast(`${found} letterform${found === 1 ? '' : 's'} found. Review each one.`);
    batch.idx = Math.min(batch.idx, batch.queue.length - 1);
    renderCurrent();
  };

  // Also callable directly with a canvas (tests, demo walls).
  batch.addCanvas = function (canvas, name, sourceId) {
    const result = ST.auto.processImage(canvas, {});
    for (const cand of result.candidates) {
      batch.queue.push({
        sourceName: name || 'photo', sourceId: sourceId || null,
        canvas: result.canvas, angle: result.angle, cand,
      });
    }
    return result.candidates.length;
  };

  // Once every candidate from a Drive photo is resolved, remember it.
  function resolveSource(item) {
    if (!item || !item.sourceId) return;
    if (!batch.queue.some((q) => q.sourceId === item.sourceId)) {
      if (ST.sync) ST.sync.markProcessed(item.sourceId);
    }
  }

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

  // ---------- review ----------
  function renderCurrent() {
    const item = batch.queue[batch.idx];
    if (!item) { hide(); return; }
    show();
    $('#reviewBody').style.display = '';
    setProgress(`Letterform ${batch.idx + 1} of ${batch.queue.length}` +
      (item.angle ? ` · auto-straightened ${item.angle > 0 ? '−' : '+'}${Math.abs(item.angle)}°` : ''));

    // source crop
    const srcC = $('#reviewSource');
    const crop = item.cand.crop;
    const s = Math.min(srcC.width / crop.w, srcC.height / crop.h);
    const sc = srcC.getContext('2d');
    sc.clearRect(0, 0, srcC.width, srcC.height);
    sc.imageSmoothingEnabled = true;
    const dw = crop.w * s, dh = crop.h * s;
    sc.drawImage(item.canvas, crop.x, crop.y, crop.w, crop.h,
      (srcC.width - dw) / 2, (srcC.height - dh) / 2, dw, dh);

    // traced preview
    const traceC = $('#reviewTrace');
    const tc = traceC.getContext('2d');
    tc.clearRect(0, 0, traceC.width, traceC.height);
    const bb = ST.trace.boundsOf(item.cand.paths);
    if (bb) {
      const ts = Math.min((traceC.width - 20) / bb.w, (traceC.height - 20) / bb.h);
      const ox = (traceC.width - bb.w * ts) / 2 - bb.x0 * ts;
      const oy = (traceC.height - bb.h * ts) / 2 - bb.y0 * ts;
      const path = new Path2D();
      for (const p of item.cand.paths) {
        const cs = p.cubics;
        path.moveTo(ox + cs[0][0].x * ts, oy + cs[0][0].y * ts);
        for (const cu of cs) {
          path.bezierCurveTo(ox + cu[1].x * ts, oy + cu[1].y * ts,
            ox + cu[2].x * ts, oy + cu[2].y * ts, ox + cu[3].x * ts, oy + cu[3].y * ts);
        }
        path.closePath();
      }
      tc.fillStyle = '#000';
      tc.fill(path, 'nonzero');
    }

    $('#reviewChar').value = item.cand.guess || '';
    $('#reviewConf').textContent = item.cand.ranked
      ? `Guessed “${item.cand.guess}” at ${Math.round((item.cand.confidence || 0) * 100)}% confidence` +
        (item.cand.ranked[1] ? ` · next: ${item.cand.ranked.slice(1, 4).map((r) => r.ch).join(' ')}` : '')
      : 'No guess — type the character.';
    $('#reviewChar').focus();
    $('#reviewChar').select();
  }

  function removeCurrent() {
    const [item] = batch.queue.splice(batch.idx, 1);
    resolveSource(item);
    if (batch.idx >= batch.queue.length) batch.idx = batch.queue.length - 1;
    if (!batch.queue.length) {
      hide();
      ST.toast('Review queue finished.');
      return;
    }
    renderCurrent();
  }

  batch.accept = function () {
    const item = batch.queue[batch.idx];
    if (!item) return false;
    const ch = ($('#reviewChar').value || '').slice(-1);
    if (!ch || ch === ' ') { ST.toast('Type which character this is first.', 'warn'); return false; }
    const record = ST.metrics.buildRecord(ch, item.cand.paths);
    if (!record) { ST.toast('Could not fit that shape.', 'warn'); return false; }
    record.thumb = ST.capture.makeThumb(record);
    ST.store.addVariant(ch, record);
    ST.toast(`“${ch}” added — ${ST.store.count()} characters in ${ST.store.state.fontName}.`);
    removeCurrent();
    return true;
  };

  batch.skip = function () { removeCurrent(); };

  batch.editManually = function () {
    const item = batch.queue[batch.idx];
    if (!item) return;
    ST.capture.useBitmap(item.canvas, item.canvas.width, item.canvas.height);
    ST.capture.skipFlatten();
    const c = item.cand.crop;
    ST.capture.lasso = [
      { x: c.x, y: c.y }, { x: c.x + c.w, y: c.y },
      { x: c.x + c.w, y: c.y + c.h }, { x: c.x, y: c.y + c.h },
    ];
    ST.capture.runExtraction(true);
    $('#charInput').value = item.cand.guess || '';
    ST.capture.updatePreview();
    batch.queue.splice(batch.idx, 1);
    resolveSource(item);
    if (batch.idx >= batch.queue.length) batch.idx = Math.max(0, batch.queue.length - 1);
    hide();
    if (g.__st && g.__st.switchTab) g.__st.switchTab('capture');
    updateQueuePill();
  };

  batch.close = function () {
    hide();
    updateQueuePill();
  };

  batch.reopen = function () {
    if (batch.queue.length) { renderCurrent(); }
  };

  function updateQueuePill() {
    const pill = $('#queuePill');
    if (!pill) return;
    pill.style.display = batch.queue.length ? '' : 'none';
    pill.textContent = `Review queue (${batch.queue.length})`;
  }

  batch.init = function () {
    $('#autoBtn').addEventListener('click', () => $('#autoInput').click());
    $('#autoInput').addEventListener('change', (e) => {
      if (e.target.files.length) batch.addFiles(e.target.files);
      e.target.value = '';
    });
    $('#reviewAccept').addEventListener('click', batch.accept);
    $('#reviewSkip').addEventListener('click', batch.skip);
    $('#reviewEdit').addEventListener('click', batch.editManually);
    $('#reviewClose').addEventListener('click', batch.close);
    $('#queuePill').addEventListener('click', batch.reopen);
    $('#reviewChar').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); batch.accept(); }
    });
    ST.store.on('change', updateQueuePill);
  };
})(typeof window !== 'undefined' ? window : globalThis);
