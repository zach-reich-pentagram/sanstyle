/* SANSTYLE — store.js
 * The living glyph library. Local-first: persists to localStorage, exports/
 * imports as JSON so sets can be shared and merged. Each character slot holds
 * any number of captured variants; one is "active" and ships in the font.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const KEY = 'sanstyle.library.v1';

  const CHARSET = {
    caps: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
    lower: 'abcdefghijklmnopqrstuvwxyz'.split(''),
    digits: '0123456789'.split(''),
    marks: '. , : ; ! ? \' " - _ # @ & $ % ( ) [ ] * + = / \\ < >'.split(' '),
  };

  class Store extends ST.Emitter {
    constructor() {
      super();
      this.state = {
        fontName: 'Sanstyle',
        mirrorCase: true,
        glyphs: {}, // char → { variants: [record], active: 0 }
        tester: null,
        design: null,
        processedPhotos: [], // Drive inbox file ids already reviewed
      };
      this._save = ST.debounce(() => this.persist(), 500);
    }

    defaultTester() {
      return {
        bg: '#ffffff', fg: '#000000', align: 'left', aspect: 'free',
        cycle: true, size: 112, tracking: 0.02, leading: 1.05,
      };
    }

    load() {
      try {
        const raw = typeof localStorage !== 'undefined' && localStorage.getItem(KEY);
        if (raw) {
          const data = JSON.parse(raw);
          if (data && data.glyphs) this.state = Object.assign(this.state, data);
        }
      } catch (e) {
        console.warn('Sanstyle: could not load library', e);
      }
      this.state.tester = Object.assign(this.defaultTester(), this.state.tester || {});
      this.state.design = this.state.design || {};
      this.state.processedPhotos = this.state.processedPhotos || [];
    }

    markPhotoProcessed(id) {
      if (!id || this.state.processedPhotos.includes(id)) return;
      this.state.processedPhotos.push(id);
      this.touch();
    }

    // Visual preferences persist but don't trigger a font recompile.
    updateTester(patch) {
      Object.assign(this.state.tester, patch);
      this._save();
      this.emit('tester');
    }

    updateDesign(patch) {
      Object.assign(this.state.design, patch);
      for (const k in this.state.design) {
        if (this.state.design[k] === null) delete this.state.design[k];
      }
      this._save();
      this.emit('design');
    }

    persist() {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.state));
      } catch (e) {
        // quota: retry without previews (regenerable thumbs, photo crops)
        try {
          const slim = JSON.parse(JSON.stringify(this.state));
          for (const ch in slim.glyphs) {
            for (const v of slim.glyphs[ch].variants) { delete v.thumb; delete v.source; }
          }
          localStorage.setItem(KEY, JSON.stringify(slim));
          if (!this._warnedSlim && ST.toast) {
            this._warnedSlim = true;
            ST.toast('Local cache is tight — previews trimmed locally; letterforms are safe.');
          }
        } catch (e2) {
          if (ST.toast) ST.toast('Local storage is full — rely on cloud sync or export JSON.', 'warn');
        }
      }
    }

    touch() {
      this._save();
      this.emit('change');
    }

    slot(ch) { return this.state.glyphs[ch] || null; }

    variantById(id) {
      for (const ch in this.state.glyphs) {
        for (const v of this.state.glyphs[ch].variants) if (v.id === id) return v;
      }
      return null;
    }

    activeVariant(ch) {
      const s = this.slot(ch);
      if (!s || !s.variants.length) return null;
      return s.variants[Math.min(s.active || 0, s.variants.length - 1)];
    }

    addVariant(ch, record) {
      if (!this.state.glyphs[ch]) this.state.glyphs[ch] = { variants: [], active: 0 };
      const s = this.state.glyphs[ch];
      s.variants.push(record);
      s.active = s.variants.length - 1; // newest becomes the live glyph
      this.touch();
      return s.variants.length;
    }

    setActive(ch, idx) {
      const s = this.slot(ch);
      if (!s) return;
      s.active = ST.clamp(idx, 0, s.variants.length - 1);
      this.touch();
    }

    deleteVariant(ch, idx) {
      const s = this.slot(ch);
      if (!s) return;
      if (s.variants[idx] && ST.sources) ST.sources.remove(s.variants[idx].id);
      s.variants.splice(idx, 1);
      if (!s.variants.length) delete this.state.glyphs[ch];
      else s.active = ST.clamp(s.active, 0, s.variants.length - 1);
      this.touch();
    }

    updateNudge(ch, idx, patch) {
      const s = this.slot(ch);
      if (!s || !s.variants[idx]) return;
      const v = s.variants[idx];
      v.nudge = Object.assign({ scale: 0, dy: 0, dl: 0, dr: 0 }, v.nudge, patch);
      this.touch();
    }

    resetNudge(ch, idx) {
      const s = this.slot(ch);
      if (!s || !s.variants[idx]) return;
      s.variants[idx].nudge = { scale: 0, dy: 0, dl: 0, dr: 0 };
      this.touch();
    }

    setFontName(name) {
      this.state.fontName = (name || '').slice(0, 40) || 'Sanstyle';
      this.touch();
    }

    setMirrorCase(v) {
      this.state.mirrorCase = !!v;
      this.touch();
    }

    filledChars() { return Object.keys(this.state.glyphs).sort(); }
    count() { return this.filledChars().length; }
    variantCount() {
      let n = 0;
      for (const ch of this.filledChars()) n += this.state.glyphs[ch].variants.length;
      return n;
    }

    exportJSON() {
      return JSON.stringify(this.exportObject(), null, 1);
    }

    exportObject() {
      return {
        app: 'sanstyle',
        version: 1,
        exported: new Date().toISOString(),
        fontName: this.state.fontName,
        mirrorCase: this.state.mirrorCase,
        glyphs: this.state.glyphs,
        processedPhotos: this.state.processedPhotos,
        tester: this.state.tester,
        design: this.state.design,
      };
    }

    /**
     * Merge another library into this one. Variants union by id; the incoming
     * side's preferences (font name, tester, design, active picks) win when
     * present — with one user syncing across devices, "latest pull/push wins"
     * is the intended behavior.
     */
    mergeLibrary(data, opts) {
      const o = opts || {};
      let added = 0;
      if (o.replace) this.state.glyphs = {};
      for (const ch in data.glyphs || {}) {
        const incoming = data.glyphs[ch];
        if (!incoming || !Array.isArray(incoming.variants)) continue;
        if (!this.state.glyphs[ch]) this.state.glyphs[ch] = { variants: [], active: 0 };
        const slot = this.state.glyphs[ch];
        const have = new Set(slot.variants.map((v) => v.id));
        for (const v of incoming.variants) {
          if (v && v.contours && !have.has(v.id)) { slot.variants.push(v); added++; }
        }
        if (o.preferIncoming && typeof incoming.active === 'number') {
          slot.active = incoming.active;
        }
        slot.active = ST.clamp(slot.active || 0, 0, slot.variants.length - 1);
      }
      if (data.fontName && (o.preferIncoming || o.replace || this.state.fontName === 'Sanstyle')) {
        this.state.fontName = data.fontName;
      }
      if (o.preferIncoming && typeof data.mirrorCase === 'boolean') this.state.mirrorCase = data.mirrorCase;
      if (o.preferIncoming && data.tester) {
        this.state.tester = Object.assign(this.defaultTester(), data.tester);
      }
      if (o.preferIncoming && data.design) this.state.design = data.design;
      for (const id of data.processedPhotos || []) {
        if (!this.state.processedPhotos.includes(id)) this.state.processedPhotos.push(id);
      }
      this.touch();
      return added;
    }

    importJSON(text, merge) {
      const data = JSON.parse(text);
      if (!data || data.app !== 'sanstyle' || !data.glyphs) {
        throw new Error('Not a Sanstyle library file');
      }
      return this.mergeLibrary(data, { replace: !merge });
    }

    clearAll() {
      if (ST.sources) {
        for (const ch of this.filledChars()) for (const v of this.state.glyphs[ch].variants) ST.sources.remove(v.id);
      }
      this.state.glyphs = {};
      this.touch();
    }
  }

  ST.CHARSET = CHARSET;
  ST.store = new Store();

  // ---------- source crops ----------
  // The bit of photo each letterform was cut from, keyed by variant id.
  // Kept out of the library JSON (and out of the cloud push) in IndexedDB:
  // a few hundred JPEG crops would blow the localStorage quota and slow
  // every sync. Memory-only where IndexedDB is unavailable. Elsewhere — on
  // another device, or after the browser cleared its storage — find() cuts
  // the bit again from the letterform's Drive photo (see `photo` below).
  const SRC_DB = 'sanstyle.sources', SRC_STORE = 'crops';
  const srcMem = new Map();
  let srcDb = null;
  function openSources() {
    if (srcDb) return srcDb;
    srcDb = new Promise((resolve) => {
      try {
        const req = indexedDB.open(SRC_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(SRC_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return srcDb;
  }
  ST.sources = {
    put(id, dataUrl) {
      if (!id || !dataUrl) return Promise.resolve();
      srcMem.set(id, dataUrl);
      return openSources().then((db) => {
        if (!db) return;
        try { db.transaction(SRC_STORE, 'readwrite').objectStore(SRC_STORE).put(dataUrl, id); } catch (e) { /* read-only */ }
      });
    },
    get(id) {
      if (!id) return Promise.resolve(null);
      if (srcMem.has(id)) return Promise.resolve(srcMem.get(id));
      return openSources().then((db) => new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = db.transaction(SRC_STORE).objectStore(SRC_STORE).get(id);
          req.onsuccess = () => { if (req.result) srcMem.set(id, req.result); resolve(req.result || null); };
          req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      }));
    },
    remove(id) {
      srcMem.delete(id);
      return openSources().then((db) => {
        if (!db) return;
        try { db.transaction(SRC_STORE, 'readwrite').objectStore(SRC_STORE).delete(id); } catch (e) { /* gone */ }
      });
    },
    // The crop for a letterform (a variant record): the one kept on this
    // device, or else cut again from its Drive photo — and kept here from
    // then on.
    find(v) {
      if (!v || !v.id) return Promise.resolve(null);
      return ST.sources.get(v.id).then((url) => {
        if (url || !ST.sources.canFetch(v)) return url || null;
        return ST.sync.cropFromPhoto(v).then((cut) => {
          if (cut) ST.sources.put(v.id, cut);
          return cut || null;
        });
      });
    },
    // whether find() can go to Drive for it
    canFetch(v) {
      return !!(v && v.photo && v.photo.id && Array.isArray(v.photo.quad) &&
        ST.sync && ST.sync.unlocked && ST.sync.cropFromPhoto);
    },
  };

  // ---------- where in its photo a letterform was cut ----------
  // The crops above stay on the device that made them. So that the bit of
  // photo can be cut again anywhere, a letterform added from a photo
  // records it in `variant.photo`: `id` (its Drive file, when it has one),
  // `name`, and `quad` — the crop's corners (top-left, top-right,
  // bottom-right, bottom-left as the letter stands) as fractions of the
  // photo's width and height as it was shot. It rides in library.json, so
  // it syncs, exports and imports with the letterform.
  //
  // The stage shows the photo straightened: turned upright by the item's
  // `angle` about its middle (auto.rotateCanvas — the canvas grows to the
  // turned photo's bounds), scaled evenly, and perhaps cropped (a cropped
  // canvas's `_frame` says where it sits in the whole straightened frame,
  // as fractions of it). Undoing that puts a crop back on the photo.
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const r4 = (v) => Math.round(v * 1e4) / 1e4;

  // A crop of `canvas` (px) as a frame of the whole straightened photo; a
  // crop of a crop composes.
  ST.sources.subFrame = function (canvas, x, y, w, h) {
    const f = canvas._frame || FULL;
    return {
      x: f.x + (x / canvas.width) * f.w, y: f.y + (y / canvas.height) * f.h,
      w: (w / canvas.width) * f.w, h: (h / canvas.height) * f.h,
    };
  };

  // { angle (degrees, as the item has it), full: {w, h} of the whole
  //   straightened frame, frame (fractions; whole when absent), view: {w, h}
  //   of the canvas the rect is in, rect: {x, y, w, h} px } → quad
  ST.sources.photoQuad = function (o) {
    const f = o.frame || FULL;
    // a flattened photo (o.flat, rectify.js): its homography undone — px
    // on the flat canvas back to px on the photo at the working size it was
    // read at
    if (o.flat && o.flat.H && ST.rectify) {
      const Hi = ST.rectify.inv3(o.flat.H);
      if (!Hi) return null;
      const W = o.full.w, H = o.full.h, r = o.flat, px = o.rect, q = [];
      for (const [x, y] of [[px.x, px.y], [px.x + px.w, px.y], [px.x + px.w, px.y + px.h], [px.x, px.y + px.h]]) {
        const fx = (f.x + (x / o.view.w) * f.w) * W, fy = (f.y + (y / o.view.h) * f.h) * H;
        const p = ST.rectify.apply(Hi, fx, fy);
        q.push(r4(p[0] / r.srcW), r4(p[1] / r.srcH));
      }
      return q;
    }
    const rad = (-(o.angle || 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const cs = Math.abs(cos), sn = Math.abs(sin);
    const W = o.full.w, H = o.full.h;
    // the photo's own size in the frame's px: the frame is its turned bounds
    const det = cs * cs - sn * sn;
    if (!(det > 0.2) || !W || !H) return null;
    const pw = (W * cs - H * sn) / det, ph = (H * cs - W * sn) / det;
    if (!(pw > 0 && ph > 0)) return null;
    const r = o.rect, quad = [];
    for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]) {
      // frame px about its middle, turned back onto the photo
      const dx = (f.x + (x / o.view.w) * f.w) * W - W / 2;
      const dy = (f.y + (y / o.view.h) * f.h) * H - H / 2;
      quad.push(r4((dx * cos + dy * sin + pw / 2) / pw), r4((-dx * sin + dy * cos + ph / 2) / ph));
    }
    return quad;
  };

  // The `photo` record for a letterform cut from a review-queue item's shape
  // (crop: px on the item's canvas): the same bit capture.sourceThumb
  // keeps — the crop with a margin, within the canvas. A demo wall has no
  // photo to go back to.
  ST.sources.photoOf = function (item, crop) {
    if (!item || !item.canvas || !crop) return null;
    if (!item.sourceId && /^demo-/.test(item.name || '')) return null;
    const cv = item.canvas, full = (item.original && item.original.canvas) || cv;
    const pad = Math.round(Math.max(crop.w, crop.h) * 0.15);
    const x0 = Math.max(0, crop.x - pad), y0 = Math.max(0, crop.y - pad);
    const x1 = Math.min(cv.width, crop.x + crop.w + pad), y1 = Math.min(cv.height, crop.y + crop.h + pad);
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    const quad = ST.sources.photoQuad({
      angle: item.rect ? 0 : item.angle,
      flat: item.rect || null, // the flattening (rectify.js), if any
      full: { w: full.width, h: full.height },
      frame: cv === full ? null : cv._frame,
      view: { w: cv.width, h: cv.height },
      rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    });
    if (!quad) return null;
    const out = { quad };
    if (item.sourceId) out.id = item.sourceId;
    if (item.name) out.name = item.name;
    return out;
  };

  // Cut a quad out of a photo (canvas or bitmap), upright, as a small JPEG
  // data URL — what capture.sourceThumb would have kept. Past the photo's
  // edge reads neutral gray.
  ST.sources.cutQuad = function (photo, quad, maxEdge) {
    const W = photo.width, H = photo.height;
    const P = (i) => ({ x: quad[2 * i] * W, y: quad[2 * i + 1] * H });
    const a = P(0), b = P(1), cc = P(2), d = P(3);
    const sw = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(cc.x - d.x, cc.y - d.y)) / 2;
    const sh = (Math.hypot(d.x - a.x, d.y - a.y) + Math.hypot(cc.x - b.x, cc.y - b.y)) / 2;
    if (!(sw >= 1 && sh >= 1)) return null;
    // (as big as the kept crops come out: extraction reads small letters enlarged)
    const s = Math.min(3, (maxEdge || 320) / Math.max(sw, sh));
    const c = g.document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * s));
    c.height = Math.max(1, Math.round(sh * s));
    const cx = c.getContext('2d');
    cx.fillStyle = '#8a8a8a';
    cx.fillRect(0, 0, c.width, c.height);
    // a parallelogram (a photo turned, scaled, cropped): output px → photo
    // px is a + u·(b − a)/width + v·(d − a)/height, and the photo is drawn
    // through its inverse
    if (Math.hypot(cc.x - (b.x + d.x - a.x), cc.y - (b.y + d.y - a.y)) < 0.5 || !ST.geom) {
      cx.setTransform(new DOMMatrix([
        (b.x - a.x) / c.width, (b.y - a.y) / c.width, (d.x - a.x) / c.height, (d.y - a.y) / c.height, a.x, a.y,
      ]).inverse());
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(photo, 0, 0);
      return c.toDataURL('image/jpeg', 0.75);
    }
    // a flattened photo's quad is any four-sided shape: each output pixel
    // is looked up through the homography from the output onto the quad
    const Hm = ST.geom.homography(
      [{ x: 0, y: 0 }, { x: c.width, y: 0 }, { x: c.width, y: c.height }, { x: 0, y: c.height }], [a, b, cc, d]);
    if (!Hm) return null;
    // (only the part of the photo the quad covers is read)
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, cc.x, d.x)) - 1), y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, cc.y, d.y)) - 1);
    const x1 = Math.min(W, Math.ceil(Math.max(a.x, b.x, cc.x, d.x)) + 1), y1 = Math.min(H, Math.ceil(Math.max(a.y, b.y, cc.y, d.y)) + 1);
    if (x1 - x0 < 1 || y1 - y0 < 1) return c.toDataURL('image/jpeg', 0.75);
    const pc = g.document.createElement('canvas');
    pc.width = x1 - x0; pc.height = y1 - y0;
    const px = pc.getContext('2d');
    px.drawImage(photo, x0, y0, pc.width, pc.height, 0, 0, pc.width, pc.height);
    const src = px.getImageData(0, 0, pc.width, pc.height).data, pw = pc.width, ph = pc.height;
    const out = cx.getImageData(0, 0, c.width, c.height), od = out.data;
    for (let v = 0; v < c.height; v++) {
      for (let u = 0; u < c.width; u++) {
        const q = ST.geom.applyH(Hm, u + 0.5, v + 0.5);
        const fx = q.x - x0 - 0.5, fy = q.y - y0 - 0.5;
        if (fx < 0 || fy < 0 || fx > pw - 1 || fy > ph - 1) continue;
        const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const jx = Math.min(pw - 1, ix + 1), jy = Math.min(ph - 1, iy + 1);
        const o = (v * c.width + u) * 4;
        for (let k = 0; k < 3; k++) {
          od[o + k] = (src[(iy * pw + ix) * 4 + k] * (1 - tx) + src[(iy * pw + jx) * 4 + k] * tx) * (1 - ty) +
            (src[(jy * pw + ix) * 4 + k] * (1 - tx) + src[(jy * pw + jx) * 4 + k] * tx) * ty;
        }
      }
    }
    cx.putImageData(out, 0, 0);
    return c.toDataURL('image/jpeg', 0.75);
  };
})(typeof window !== 'undefined' ? window : globalThis);
