/* Sanstyle — worker.js
 * Photo analysis off the page's thread. The same scripts the page runs
 * (with an OffscreenCanvas to draw on) straighten a photo and find its
 * letterforms here, so a stack of photos or a Drive re-scan is analyzed
 * while the page stays responsive. See batch.analyze.
 */
'use strict';
importScripts('util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'extract.js', 'complete.js', 'letters-model.js', 'recognize.js', 'letters.js', 'auto.js');

// the photo clicks are traced on, kept between clicks (sent once per photo)
let photo = null;

function send(id, candidates, extra, transfer) {
  const seen = new Set(transfer.map((t) => t));
  const give = (arr) => { if (arr && !seen.has(arr.buffer)) { seen.add(arr.buffer); transfer.push(arr.buffer); } };
  const out = candidates.map((cd) => {
    give(cd.mask);
    return { crop: cd.crop, mask: cd.mask, w: cd.w, h: cd.h, paths: cd.paths, kind: cd.kind, read: cd.read, lean: cd.lean, score: cd.score };
  });
  if (extra.inPhoto) give(extra.inPhoto);
  self.postMessage(Object.assign({ id, ok: true, candidates: out }, extra), transfer);
}

self.onmessage = (e) => {
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
      if (!photo || photo.key !== e.data.key) { self.postMessage({ id, ok: false, error: 'photo not loaded' }); return; }
      const res = self.ST.extract.seeded(photo.canvas, e.data.x, e.data.y, opts || {});
      if (!res) { self.postMessage({ id, ok: true, none: true }); return; }
      send(id, res.candidates, { click: res.click || null }, []);
      return;
    }
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    const res = self.ST.auto.processImage(c, opts || {});
    const work = res.canvas;
    const inPhoto = work._inPhoto || null;
    const image = work.transferToImageBitmap();
    send(id, res.candidates, { angle: res.angle, width: image.width, height: image.height, image, inPhoto }, [image]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
