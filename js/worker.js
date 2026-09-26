/* Sanstyle — worker.js
 * Photo analysis off the page's thread. The same scripts the page runs
 * (with an OffscreenCanvas to draw on) straighten a photo and find its
 * letterforms here, so a stack of photos or a Drive re-scan is analyzed
 * while the page stays responsive. See batch.analyze.
 */
'use strict';
importScripts('util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'extract.js', 'complete.js', 'auto.js');

self.onmessage = (e) => {
  const { id, bitmap, opts } = e.data;
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    const res = self.ST.auto.processImage(c, opts || {});
    const work = res.canvas;
    const inPhoto = work._inPhoto || null;
    const image = work.transferToImageBitmap();
    const transfer = [image];
    const seen = new Set();
    const give = (arr) => { if (arr && !seen.has(arr.buffer)) { seen.add(arr.buffer); transfer.push(arr.buffer); } };
    const candidates = res.candidates.map((cd) => {
      give(cd.mask);
      return { crop: cd.crop, mask: cd.mask, w: cd.w, h: cd.h, paths: cd.paths };
    });
    give(inPhoto);
    self.postMessage({ id, ok: true, angle: res.angle, width: image.width, height: image.height, image, inPhoto, candidates }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
