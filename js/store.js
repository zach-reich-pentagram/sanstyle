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
  // every sync. Memory-only where IndexedDB is unavailable.
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
  };
})(typeof window !== 'undefined' ? window : globalThis);
