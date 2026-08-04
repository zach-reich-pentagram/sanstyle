/* SANSTYLE — heic.js
 * iPhone photo support. Safari decodes HEIC natively; everywhere else we
 * lazy-load the vendored libheif (asm.js, works offline/file://) on the
 * first HEIC upload and decode to a canvas.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const heic = (ST.heic = {});

  heic.looksHeic = function (file) {
    const t = (file.type || '').toLowerCase();
    const n = (file.name || '').toLowerCase();
    return t.includes('heic') || t.includes('heif') || /\.hei[cf]$/.test(n);
  };

  let modPromise = null;

  function loadModule() {
    if (modPromise) return modPromise;
    modPromise = new Promise((resolve, reject) => {
      if (g.libheif) return resolve(g.libheif);
      const s = g.document.createElement('script');
      s.src = 'vendor/libheif.js';
      s.onload = () => resolve(g.libheif);
      s.onerror = () => reject(new Error('Could not load the HEIC decoder.'));
      g.document.head.appendChild(s);
    }).then((factory) => {
      const m = typeof factory === 'function' ? factory() : factory;
      return m && typeof m.then === 'function' ? m : Promise.resolve(m);
    });
    return modPromise;
  }

  /** Decode a HEIC/HEIF File → canvas. */
  heic.decode = async function (file) {
    const mod = await loadModule();
    const buf = new Uint8Array(await file.arrayBuffer());
    const decoder = new mod.HeifDecoder();
    const images = decoder.decode(buf);
    if (!images || !images.length) throw new Error('No image found in that HEIC file.');
    const img = images[0];
    const w = img.get_width(), h = img.get_height();
    const canvas = g.document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const id = ctx.createImageData(w, h);
    await new Promise((resolve, reject) => {
      img.display(id, (ok) => (ok ? resolve() : reject(new Error('HEIC decode failed.'))));
    });
    ctx.putImageData(id, 0, 0);
    for (const im of images) { try { im.free(); } catch (e) { /* older builds */ } }
    return canvas;
  };
})(typeof window !== 'undefined' ? window : globalThis);
