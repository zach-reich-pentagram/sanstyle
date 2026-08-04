/* SANSTYLE — util.js
 * Namespace bootstrap + tiny shared helpers.
 * Every module attaches to the ST global so the app runs as classic scripts
 * (works from file:// with no build step) and inside Node's vm for tests.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});

  ST.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  ST.lerp = (a, b, t) => a + (b - a) * t;
  ST.round2 = (v) => Math.round(v * 100) / 100;

  // Deterministic RNG (mulberry32) — demo walls and tests need repeatability.
  ST.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  ST.debounce = function (fn, ms) {
    let t = null;
    const d = function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
    d.cancel = () => { if (t) clearTimeout(t); t = null; };
    return d;
  };

  ST.Emitter = class {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); return () => this.off(ev, fn); }
    off(ev, fn) { const a = this._h[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
    emit(ev, ...args) { (this._h[ev] || []).slice().forEach((fn) => fn(...args)); }
  };

  ST.uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  // --- DOM helpers (browser only) ---
  if (typeof g.document !== 'undefined') {
    ST.$ = (sel, root) => (root || g.document).querySelector(sel);
    ST.$$ = (sel, root) => Array.from((root || g.document).querySelectorAll(sel));
    ST.el = function (tag, attrs, ...kids) {
      const n = g.document.createElement(tag);
      if (attrs) for (const k in attrs) {
        if (k === 'class') n.className = attrs[k];
        else if (k === 'style') n.style.cssText = attrs[k];
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
      }
      for (const kid of kids) {
        if (kid === null || kid === undefined) continue;
        n.appendChild(typeof kid === 'string' ? g.document.createTextNode(kid) : kid);
      }
      return n;
    };

    let toastTimer = null;
    ST.toast = function (msg, kind) {
      let t = ST.$('#toast');
      if (!t) {
        t = ST.el('div', { id: 'toast' });
        g.document.body.appendChild(t);
      }
      t.textContent = msg;
      t.className = 'show' + (kind ? ' ' + kind : '');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.className = ''; }, 3400);
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
