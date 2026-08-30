/* Sanstyle — ui/batch.js
 * The automated lane, letter-first. One photo at a time: you type the
 * character you can see, the machine finds the best-matching traced shape in
 * that photo and shows it; you add it, try another shape, fall back to the
 * manual studio, or move on. The first photo appears as soon as it's ready —
 * the rest fetch and analyze in the background (Drive photos prefetch ahead).
 * Closing the modal saves the rest for later.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const $ = ST.$;

  const batch = (ST.batch = {
    queue: [],       // photos: {name, sourceId, canvas, angle, candidates, used:Set}
    idx: 0,          // current photo (earlier ones are done)
    phase: 'ask',    // ask | result
    current: null,   // {char, matches:[candIdx...], mi}
    intakeActive: false,
    intakeTotal: 0,
  });

  const modal = () => $('#reviewModal');
  function show() { modal().classList.add('open'); }
  function hide() { modal().classList.remove('open'); updateQueuePill(); }
  function isOpen() { return modal().classList.contains('open'); }

  function remaining() { return Math.max(0, batch.queue.length - batch.idx); }

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
      used: new Set(),
    });
    // first ready photo replaces the spinner immediately
    if (isOpen() && batch.idx === batch.queue.length - 1) {
      renderCurrent();
    } else if (isOpen()) {
      setProgress();
    }
    updateQueuePill();
    return result.candidates.length;
  }
  batch.addCanvas = pushPhoto; // kept for hooks/tests

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

  // Drive inbox photos: prefetch two ahead so review never waits on the network.
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
    if (batch.phase === 'ask') renderAsk(item);
    else renderResult(item);
  }
  batch.renderCurrent = renderCurrent;

  function renderAsk(item) {
    $('#reviewAsk').style.display = '';
    $('#reviewResult').style.display = 'none';

    const cnv = $('#reviewPhoto');
    const c = cnv.getContext('2d');
    c.clearRect(0, 0, cnv.width, cnv.height);
    const s = Math.min(cnv.width / item.canvas.width, cnv.height / item.canvas.height);
    const dw = item.canvas.width * s, dh = item.canvas.height * s;
    const ox = (cnv.width - dw) / 2, oy = (cnv.height - dh) / 2;
    c.imageSmoothingEnabled = true;
    c.drawImage(item.canvas, ox, oy, dw, dh);
    // faint boxes over what the detector found
    c.strokeStyle = 'rgba(59,130,246,0.85)';
    c.lineWidth = 1.5;
    for (let i = 0; i < item.candidates.length; i++) {
      if (item.used.has(i)) continue;
      const cr = item.candidates[i].crop;
      c.strokeRect(ox + cr.x * s, oy + cr.y * s, cr.w * s, cr.h * s);
    }

    const input = $('#reviewChar');
    input.value = '';
    const unused = item.candidates.filter((_, i) => !item.used.has(i));
    if (!unused.length) {
      $('#reviewHint').textContent = item.candidates.length
        ? 'Every detected shape in this photo has been used — next photo, or edit manually.'
        : 'No letterforms detected in this photo — edit manually, or move on.';
      $('#reviewFind').disabled = true;
    } else {
      $('#reviewFind').disabled = false;
      const best = unused[0].guess;
      $('#reviewHint').textContent =
        `${unused.length} shape${unused.length === 1 ? '' : 's'} detected` +
        (best ? ` · the machine's guess: “${best}”` : '') +
        ' · type the character you see and hit Enter.';
    }
    setTimeout(() => input.focus(), 60);
  }

  function renderResult(item) {
    $('#reviewAsk').style.display = 'none';
    $('#reviewResult').style.display = '';
    const cur = batch.current;
    const cand = item.candidates[cur.matches[cur.mi]];

    const srcC = $('#reviewSource');
    const sc = srcC.getContext('2d');
    sc.clearRect(0, 0, srcC.width, srcC.height);
    const crop = cand.crop;
    const s = Math.min(srcC.width / crop.w, srcC.height / crop.h);
    const dw = crop.w * s, dh = crop.h * s;
    sc.imageSmoothingEnabled = true;
    sc.drawImage(item.canvas, crop.x, crop.y, crop.w, crop.h,
      (srcC.width - dw) / 2, (srcC.height - dh) / 2, dw, dh);

    const traceC = $('#reviewTrace');
    const tc = traceC.getContext('2d');
    tc.clearRect(0, 0, traceC.width, traceC.height);
    const bb = ST.trace.boundsOf(cand.paths);
    if (bb) {
      const ts = Math.min((traceC.width - 20) / bb.w, (traceC.height - 20) / bb.h);
      const ox = (traceC.width - bb.w * ts) / 2 - bb.x0 * ts;
      const oy = (traceC.height - bb.h * ts) / 2 - bb.y0 * ts;
      const path = new Path2D();
      for (const p of cand.paths) {
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

    $('#reviewConf').textContent =
      `Best match for “${cur.char}” · similarity ${Math.round(cur.scores[cur.mi] * 100)}%` +
      (cur.matches.length > 1 ? ` · shape ${cur.mi + 1} of ${cur.matches.length}` : '') +
      ' · if the trace grabbed a neighbor, Edit manually and block it out.';
    $('#reviewAlt').disabled = cur.matches.length < 2;
  }

  // ---------- actions ----------
  batch.findChar = function () {
    const item = batch.queue[batch.idx];
    if (!item) return false;
    const ch = ($('#reviewChar').value || '').slice(-1);
    if (!ch || ch === ' ') { ST.toast('Type the character first.', 'warn'); return false; }
    const scored = [];
    for (let i = 0; i < item.candidates.length; i++) {
      if (item.used.has(i)) continue;
      scored.push({ i, score: ST.classify.scoreFor(item.candidates[i].paths, ch) });
    }
    if (!scored.length) { ST.toast('No unused shapes in this photo.', 'warn'); return false; }
    scored.sort((a, b) => b.score - a.score);
    batch.current = {
      char: ch,
      matches: scored.map((s) => s.i),
      scores: scored.map((s) => s.score),
      mi: 0,
    };
    batch.phase = 'result';
    renderCurrent();
    return true;
  };

  batch.tryNext = function () {
    if (!batch.current || batch.current.matches.length < 2) return;
    batch.current.mi = (batch.current.mi + 1) % batch.current.matches.length;
    renderCurrent();
  };

  batch.backToAsk = function () {
    batch.phase = 'ask';
    batch.current = null;
    renderCurrent();
  };

  batch.accept = function () {
    const item = batch.queue[batch.idx];
    if (!item || !batch.current) return false;
    const candIdx = batch.current.matches[batch.current.mi];
    const cand = item.candidates[candIdx];
    const ch = batch.current.char;
    const record = ST.metrics.buildRecord(ch, cand.paths);
    if (!record) { ST.toast('Could not fit that shape.', 'warn'); return false; }
    record.thumb = ST.capture.makeThumb(record);
    ST.store.addVariant(ch, record);
    item.used.add(candIdx);
    ST.toast(`“${ch}” added — same photo: type another letter, or go to the next photo.`);
    batch.backToAsk();
    return true;
  };

  batch.nextPhoto = function () {
    const item = batch.queue[batch.idx];
    if (item && item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
    batch.idx++;
    batch.backToAsk();
  };

  batch.editManually = function () {
    const item = batch.queue[batch.idx];
    if (!item) return;
    ST.capture.useBitmap(item.canvas, item.canvas.width, item.canvas.height);
    ST.capture.skipFlatten();
    // pre-lasso the current shape if one is selected, else the best unused
    let cand = null;
    if (batch.current) cand = item.candidates[batch.current.matches[batch.current.mi]];
    else cand = item.candidates.find((_, i) => !item.used.has(i)) || item.candidates[0];
    if (cand) {
      const cr = cand.crop;
      ST.capture.lasso = [
        { x: cr.x, y: cr.y }, { x: cr.x + cr.w, y: cr.y },
        { x: cr.x + cr.w, y: cr.y + cr.h }, { x: cr.x, y: cr.y + cr.h },
      ];
      ST.capture.runExtraction(true);
      if (batch.current) $('#charInput').value = batch.current.char;
      ST.capture.updatePreview();
    }
    if (item.sourceId && ST.sync) ST.sync.markProcessed(item.sourceId);
    batch.idx++;
    batch.phase = 'ask';
    batch.current = null;
    hide();
    if (g.__st && g.__st.switchTab) g.__st.switchTab('capture');
    ST.toast('Loaded into the studio — lasso or block out, then tag and add. The queue is saved.');
  };

  batch.close = function () {
    hide();
    if (remaining()) {
      ST.toast(`${remaining()} photo${remaining() === 1 ? '' : 's'} saved for later — reopen from “Review queue”.`);
    }
  };

  batch.reopen = function () {
    if (remaining()) renderCurrent();
  };

  batch.init = function () {
    $('#autoBtn').addEventListener('click', () => $('#autoInput').click());
    $('#autoInput').addEventListener('change', (e) => {
      if (e.target.files.length) batch.addFiles(e.target.files);
      e.target.value = '';
    });
    $('#reviewFind').addEventListener('click', batch.findChar);
    $('#reviewAccept').addEventListener('click', batch.accept);
    $('#reviewAlt').addEventListener('click', batch.tryNext);
    $('#reviewBack').addEventListener('click', batch.backToAsk);
    $('#reviewNext').addEventListener('click', batch.nextPhoto);
    $('#reviewEdit').addEventListener('click', batch.editManually);
    $('#reviewEdit2').addEventListener('click', batch.editManually);
    $('#reviewClose').addEventListener('click', batch.close);
    $('#queuePill').addEventListener('click', batch.reopen);
    $('#reviewChar').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); batch.findChar(); }
    });
    g.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); batch.close(); }
      else if (e.key === 'Enter' && batch.phase === 'result') { e.preventDefault(); batch.accept(); }
    });
    ST.store.on('change', updateQueuePill);
  };
})(typeof window !== 'undefined' ? window : globalThis);
