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
      };
      this._save = ST.debounce(() => this.persist(), 500);
    }

    load() {
      try {
        const raw = typeof localStorage !== 'undefined' && localStorage.getItem(KEY);
        if (raw) {
          const data = JSON.parse(raw);
          if (data && data.glyphs) this.state = Object.assign(this.state, data);
        }
      } catch (e) {
        console.warn('SANSTYLE: could not load library', e);
      }
    }

    persist() {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.state));
      } catch (e) {
        if (ST.toast) ST.toast('Storage full — export your library JSON to keep it safe.', 'warn');
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
      return JSON.stringify({
        app: 'sanstyle',
        version: 1,
        exported: new Date().toISOString(),
        fontName: this.state.fontName,
        mirrorCase: this.state.mirrorCase,
        glyphs: this.state.glyphs,
      }, null, 1);
    }

    importJSON(text, merge) {
      const data = JSON.parse(text);
      if (!data || data.app !== 'sanstyle' || !data.glyphs) {
        throw new Error('Not a SANSTYLE library file');
      }
      let added = 0;
      if (!merge) this.state.glyphs = {};
      for (const ch in data.glyphs) {
        const incoming = data.glyphs[ch];
        if (!incoming || !Array.isArray(incoming.variants)) continue;
        if (!this.state.glyphs[ch]) this.state.glyphs[ch] = { variants: [], active: 0 };
        const slot = this.state.glyphs[ch];
        const have = new Set(slot.variants.map((v) => v.id));
        for (const v of incoming.variants) {
          if (v && v.contours && !have.has(v.id)) { slot.variants.push(v); added++; }
        }
        slot.active = ST.clamp(slot.active, 0, slot.variants.length - 1);
      }
      if (data.fontName && !merge) this.state.fontName = data.fontName;
      this.touch();
      return added;
    }

    clearAll() {
      this.state.glyphs = {};
      this.touch();
    }
  }

  ST.CHARSET = CHARSET;
  ST.store = new Store();
})(typeof window !== 'undefined' ? window : globalThis);
