/* Sanstyle — worker.js
 * Photo analysis off the page's thread. The same scripts the page runs
 * (with an OffscreenCanvas to draw on) flatten a photo and find its
 * letterforms here, so a stack of photos or a Drive re-scan is analyzed
 * while the page stays responsive. See batch.analyze.
 *
 * Each photo's analysis is kept (the last few): a click on the photo is
 * then answered from the shapes already found — which shape, which stroke —
 * instead of growing the letter again from nothing.
 */
'use strict';
importScripts('util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'extract.js', 'complete.js', 'letters-model.js', 'recognize.js', 'letters.js', 'typed.js', 'rectify.js', 'auto.js');

// the photo clicks are traced on, kept between clicks (sent once per photo)
let photo = null;
// analyses by id: { canvas (the flattened photo), shapes }
const analyses = new Map();
let nextAnalysis = 1;

function send(id, candidates, extra, transfer) {
  const seen = new Set(transfer.map((t) => t));
  const give = (arr) => { if (arr && !seen.has(arr.buffer)) { seen.add(arr.buffer); transfer.push(arr.buffer); } };
  const out = candidates.map((cd) => {
    const mask = cd.mask.slice(); // (the analysis keeps its own)
    give(mask);
    return { crop: cd.crop, mask, w: cd.w, h: cd.h, paths: cd.paths, kind: cd.kind, read: cd.read, lean: cd.lean, score: cd.score, typed: cd.typed, fit: cd.fit, reads: cd.reads };
  });
  if (extra.inPhoto) give(extra.inPhoto);
  self.postMessage(Object.assign({ id, ok: true, candidates: out }, extra), transfer);
}

self.onmessage = async (e) => {
  const { id, type, bitmap, opts } = e.data;
  try {
    // a click on the letter (see batch.clickTraceAsync)
    if (type === 'seeded') {
      if (bitmap) {
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        c.getContext('2d').drawImage(bitmap, 0, 0);
        if (bitmap.close) bitmap.close();
        if (e.data.inPhoto) c._inPhoto = e.data.inPhoto;
        photo = { key: e.data.key, canvas: c };
      }
      const an = e.data.analysis != null ? analyses.get(e.data.analysis) : null;
      if (an && (!photo || photo.key !== e.data.key)) photo = { key: e.data.key, canvas: an.canvas };
      // answered from the analysis when there is one and nothing was cut
      // (a cut changes the shapes: those are grown again)
      if (an && e.data.fast) {
        const res = self.ST.auto.clickLetter(an.shapes, an.canvas.width, an.canvas.height, e.data.x, e.data.y, self.ST.extract.flatData(an.canvas).data, an.backdrop);
        if (res) { send(id, res.candidates, { click: res.click }, []); return; }
      }
      if (!photo || photo.key !== e.data.key) { self.postMessage({ id, ok: false, error: 'photo not loaded' }); return; }
      const o2 = Object.assign({}, opts || {});
      if (an && an.backdrop) o2.backdrop = an.backdrop;
      const res = self.ST.extract.seeded(photo.canvas, e.data.x, e.data.y, o2);
      if (!res) { self.postMessage({ id, ok: true, none: true }); return; }
      for (const k of res.candidates) if (k.lean == null) k.lean = self.ST.letters ? self.ST.letters.lean(k.mask, k.w, k.h) : 0;
      send(id, res.candidates, { click: res.click || null }, []);
      return;
    }
    // strokes traced over the photo: the letter under them (see typed.js)
    if (type === 'strokes') {
      const an = e.data.analysis != null ? analyses.get(e.data.analysis) : null;
      if (!an) { self.postMessage({ id, ok: false, error: 'no analysis' }); return; }
      if (!an.data) an.data = self.ST.extract.flatData(an.canvas).data; // (kept for the next stroke)
      const src = { W: an.canvas.width, H: an.canvas.height, paints: an.paints || [], shapes: an.shapes, data: an.data };
      const found = self.ST.typed.traceStrokes(e.data.strokes, src, { tol: e.data.tol });
      if (!found) { self.postMessage({ id, ok: true, none: true }); return; }
      send(id, [found], {}, []);
      return;
    }
    // a character typed: looked for in the photo's shapes (see typed.js)
    if (type === 'typed') {
      const an = e.data.analysis != null ? analyses.get(e.data.analysis) : null;
      const first = e.data.first || null;
      const found = self.ST.typed.findIn(an ? an.shapes : [], e.data.ch, { first, hint: e.data.hint, hintWeight: e.data.hintWeight, budgetMs: 9000 });
      if (!found) { self.postMessage({ id, ok: true, none: true }); return; }
      send(id, [found], {}, []);
      return;
    }
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    const res = self.ST.auto.processImage(c, opts || {});
    const work = res.canvas;
    const inPhoto = work._inPhoto || null;
    const image = await createImageBitmap(work);
    const key = nextAnalysis++;
    analyses.set(key, { canvas: work, shapes: res.shapes || [], backdrop: res.backdrop || null, paints: res.paints || [] });
    while (analyses.size > 8) analyses.delete(analyses.keys().next().value);
    send(id, res.candidates, { angle: res.angle, rect: res.rect, analysis: key, width: image.width, height: image.height, image, inPhoto: inPhoto ? inPhoto.slice() : null }, [image]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
