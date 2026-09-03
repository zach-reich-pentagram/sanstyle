/* SANSTYLE — fitting.js
 * The "make it a typeface" layer: per-character vertical classes, optical
 * overshoot detection, auto sidebearings (a simplified HT-Letterspacer),
 * and assembly of the final glyph set for compilation.
 *
 * Font space: 1000 units/em, baseline y=0, y up.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const V = ST.geom;
  const M = (ST.metrics = {});

  M.UPM = 1000;
  M.CAP = 700;      // cap height
  M.XH = 490;       // x-height
  M.ASC = 730;      // ascender
  M.DESC = -210;    // descender
  M.SPACE_ADV = 340;

  // Vertical fit class per character: the box the raw drawing is scaled into.
  // os = eligible for optical overshoot compensation.
  const PUNCT = {
    '.': { top: 130, bottom: 0, os: false },
    ',': { top: 140, bottom: -70, os: false },
    ':': { top: M.XH, bottom: 0, os: false },
    ';': { top: M.XH, bottom: -70, os: false },
    "'": { top: M.CAP, bottom: 510, os: false },
    '"': { top: M.CAP, bottom: 510, os: false },
    '`': { top: M.CAP, bottom: 510, os: false },
    '-': { top: 370, bottom: 260, os: false },
    '_': { top: 25, bottom: -65, os: false },
    '(': { top: 740, bottom: -150, os: false },
    ')': { top: 740, bottom: -150, os: false },
    '[': { top: 740, bottom: -150, os: false },
    ']': { top: 740, bottom: -150, os: false },
    '{': { top: 740, bottom: -150, os: false },
    '}': { top: 740, bottom: -150, os: false },
    '/': { top: 740, bottom: -110, os: false },
    '\\': { top: 740, bottom: -110, os: false },
    '|': { top: 740, bottom: -150, os: false },
    '*': { top: M.CAP, bottom: 390, os: false },
    '+': { top: 555, bottom: 145, os: false },
    '=': { top: 495, bottom: 205, os: false },
    '<': { top: 555, bottom: 145, os: false },
    '>': { top: 555, bottom: 145, os: false },
    '^': { top: 730, bottom: 460, os: false },
    '~': { top: 425, bottom: 250, os: false },
    '!': { top: M.CAP, bottom: 0, os: true },
    '?': { top: M.CAP, bottom: 0, os: true },
    '$': { top: 760, bottom: -60, os: false },
    '@': { top: M.CAP, bottom: -40, os: false },
  };

  // The library key for what was typed: one character, or a ligature of
  // two to four letters/digits ("ar", "bl", "gr") that the font swaps in
  // whenever that sequence is typed.
  M.charKey = function (value) {
    const v = (value || '').trim();
    if (!v) return '';
    if (v.length >= 2 && v.length <= 4 && /^[A-Za-z0-9]+$/.test(v)) return v;
    const ch = v.slice(-1);
    return ch === ' ' ? '' : ch;
  };

  M.classFor = function (ch) {
    if (ch && ch.length > 1) {
      // a ligature ("ar", "bl", "gr"): the box that spans its members —
      // the tallest member's top, the lowest member's bottom
      let top = -Infinity, bottom = Infinity, os = false;
      for (const c of ch) {
        const k = M.classFor(c);
        top = Math.max(top, k.top); bottom = Math.min(bottom, k.bottom); os = os || k.os;
      }
      return { name: 'liga', top, bottom, os };
    }
    if (PUNCT[ch]) return Object.assign({ name: 'mark' }, PUNCT[ch]);
    if (/[A-Z0-9]/.test(ch)) return { name: 'cap', top: M.CAP, bottom: 0, os: true };
    if (/[a-z]/.test(ch)) {
      if ('bdfhkl'.includes(ch)) return { name: 'asc', top: M.ASC, bottom: 0, os: true };
      if (ch === 't') return { name: 'asc', top: 650, bottom: 0, os: true };
      if ('gpqy'.includes(ch)) return { name: 'desc', top: M.XH, bottom: M.DESC, os: true };
      if (ch === 'j') return { name: 'desc', top: 660, bottom: M.DESC, os: false };
      if (ch === 'i') return { name: 'xh', top: 660, bottom: 0, os: false };
      return { name: 'xh', top: M.XH, bottom: 0, os: true };
    }
    return { name: 'cap', top: M.CAP, bottom: 0, os: true };
  };

  // How flat is the outline near its top/bottom extreme? Returns the fraction
  // of the glyph's width covered by points inside a thin band at the extreme.
  // Flat bars (E, H, T) → ~1.0; round (O, S) → ~0.2; apex (A, V) → ~0.05.
  function extremeFlatness(polys, bb, atTop) {
    const band = Math.max(1.5, bb.h * 0.035);
    let lo = Infinity, hi = -Infinity;
    for (const poly of polys) {
      for (const p of poly) {
        const nearEdge = atTop ? (p.y - bb.y0) <= band : (bb.y1 - p.y) <= band;
        if (nearEdge) { if (p.x < lo) lo = p.x; if (p.x > hi) hi = p.x; }
      }
    }
    if (hi <= lo || bb.w <= 0) return 0;
    return (hi - lo) / bb.w;
  }

  function overshootFor(flatness, boxH) {
    // scaled to the fitted box height so small classes overshoot less
    const u = boxH / M.CAP;
    if (flatness < 0.12) return Math.round(15 * u); // pointed apex
    if (flatness < 0.45) return Math.round(11 * u); // round (circle band ≈ 0.37)
    if (flatness < 0.60) return Math.round(5 * u);  // semi-flat
    return 0;
  }

  /**
   * Fit traced pixel-space contours (y-down) into the character's vertical
   * class in font units (y-up), with optical overshoot at round/pointed
   * extremes. Returns { contours, bbox, osTop, osBot, cls }.
   */
  M.fitGlyph = function (pathsPx, ch) {
    const cls = M.classFor(ch);
    const polys = ST.trace.flattenAll(pathsPx, 4);
    let bb = null;
    for (const poly of polys) {
      const b = V.bounds(poly);
      if (!bb) bb = b;
      else {
        bb.x0 = Math.min(bb.x0, b.x0); bb.y0 = Math.min(bb.y0, b.y0);
        bb.x1 = Math.max(bb.x1, b.x1); bb.y1 = Math.max(bb.y1, b.y1);
      }
    }
    if (!bb) return null;
    bb.w = bb.x1 - bb.x0; bb.h = bb.y1 - bb.y0;
    if (bb.w < 1e-6 || bb.h < 1e-6) return null;

    const osTop = cls.os ? overshootFor(extremeFlatness(polys, bb, true), cls.top - cls.bottom) : 0;
    const osBot = cls.os ? overshootFor(extremeFlatness(polys, bb, false), cls.top - cls.bottom) : 0;

    const top = cls.top + osTop, bottom = cls.bottom - osBot;
    const s = (top - bottom) / bb.h;
    const tx = (p) => ({ x: (p.x - bb.x0) * s, y: top - (p.y - bb.y0) * s });

    const contours = pathsPx.map((c) => ({
      cubics: (c.cubics || c).map((cu) => cu.map(tx)),
    }));
    const fu = ST.trace.boundsOf(contours);
    return { contours, bbox: fu, osTop, osBot, cls };
  };

  // --- Auto spacing ----------------------------------------------------------
  // Average the whitespace depth of the left/right margin profile inside the
  // measuring band, and derive sidebearings: open profiles (A, L, T) get
  // pulled in, solid stems (H, N) get the full bearing.
  const SB_BASE = 74, SB_SLOPE = 0.44, SB_MIN = 6, SB_MAX = 165, DEPTH_CLAMP = 175;

  function marginProfiles(polys, bbox, y0, y1) {
    let sumL = 0, sumR = 0, rows = 0;
    for (let y = y0; y <= y1; y += 11) {
      let lo = Infinity, hi = -Infinity;
      for (const poly of polys) {
        for (let i = 0, n = poly.length; i < n; i++) {
          const a = poly[i], b = poly[(i + 1) % n];
          if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
            const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
            if (x < lo) lo = x;
            if (x > hi) hi = x;
          }
        }
      }
      if (lo === Infinity) continue;
      sumL += Math.min(lo - bbox.x0, DEPTH_CLAMP);
      sumR += Math.min(bbox.x1 - hi, DEPTH_CLAMP);
      rows++;
    }
    if (!rows) return { avgL: 0, avgR: 0 };
    return { avgL: sumL / rows, avgR: sumR / rows };
  }

  M.spacing = function (fitted) {
    const { contours, bbox, cls } = fitted;
    const polys = ST.trace.flattenAll(contours, 6);
    const inset = Math.max(6, (cls.top - cls.bottom) * 0.06);
    const y0 = Math.max(cls.bottom, 0) + inset;
    const y1 = Math.min(cls.top, M.CAP) - inset;
    let lsb, rsb;
    if (y1 <= y0) {
      lsb = rsb = 62; // tiny marks: fixed comfortable bearings
    } else {
      const { avgL, avgR } = marginProfiles(polys, bbox, y0, y1);
      lsb = ST.clamp(Math.round(SB_BASE - SB_SLOPE * avgL), SB_MIN, SB_MAX);
      rsb = ST.clamp(Math.round(SB_BASE - SB_SLOPE * avgR), SB_MIN, SB_MAX);
    }
    if (cls.name === 'mark' && cls.top - cls.bottom < 320) {
      lsb = Math.max(lsb, 58); rsb = Math.max(rsb, 58);
    }
    const width = Math.round(bbox.w);
    return { lsb, rsb, advance: lsb + width + rsb, width };
  };

  /**
   * One captured letterform → storable variant record.
   * pathsPx: traced contours in crop-pixel space (y-down).
   */
  M.buildRecord = function (ch, pathsPx) {
    const fitted = M.fitGlyph(pathsPx, ch);
    if (!fitted) return null;
    const sp = M.spacing(fitted);
    const r2 = ST.round2;
    const rec = {
      id: ST.uid(),
      char: ch,
      contours: fitted.contours.map((c) => ({
        cubics: c.cubics.map((cu) => cu.map((p) => ({ x: r2(p.x), y: r2(p.y) }))),
      })),
      lsb: sp.lsb,
      rsb: sp.rsb,
      advance: sp.advance,
      osTop: fitted.osTop,
      osBot: fitted.osBot,
      clsName: fitted.cls.name,
      nudge: { scale: 0, dy: 0, dl: 0, dr: 0 },
      created: Date.now(),
    };
    rec.weight = M.weightOf(rec);
    return rec;
  };

  // Visual weight of a letterform: its mean stroke thickness as a fraction
  // of its class height. For a stroke shape, ink area ≈ thickness × path
  // length and perimeter ≈ 2 × path length, so thickness ≈ 2·area/perimeter
  // (counters subtract from the area). Cached on the record.
  M.weightOf = function (v) {
    if (typeof v.weight === 'number') return v.weight;
    const polys = ST.trace.flattenAll(v.contours, 6).filter((p) => p.length >= 3);
    let area = 0, per = 0;
    polys.forEach((poly, i) => {
      const a = Math.abs(V.signedArea(poly));
      let depth = 0;
      for (let j = 0; j < polys.length; j++) if (j !== i && V.pointInPoly(poly[0], polys[j])) depth++;
      area += depth % 2 ? -a : a;
      for (let k = 0; k < poly.length; k++) {
        const p = poly[k], q = poly[(k + 1) % poly.length];
        per += Math.hypot(q.x - p.x, q.y - p.y);
      }
    });
    const cls = M.classFor(v.char || 'A');
    const thickness = per > 0 ? (2 * Math.max(0, area)) / per : 0;
    v.weight = Math.round((thickness / Math.max(1, cls.top - cls.bottom)) * 1000) / 1000;
    return v.weight;
  };

  // Apply manual nudges → final outline + metrics used by preview & compiler.
  M.finalizeVariant = function (v) {
    const n = v.nudge || { scale: 0, dy: 0, dl: 0, dr: 0 };
    let contours = v.contours;
    let bbox = ST.trace.boundsOf(contours);
    if (n.scale || n.dy) {
      const s = 1 + (n.scale || 0) / 100;
      const cx = (bbox.x0 + bbox.x1) / 2;
      const tx = (p) => ({ x: cx + (p.x - cx) * s, y: p.y * s + (n.dy || 0) });
      contours = contours.map((c) => ({ cubics: c.cubics.map((cu) => cu.map(tx)) }));
      bbox = ST.trace.boundsOf(contours);
    }
    const lsb = Math.max(-120, v.lsb + (n.dl || 0));
    const rsb = Math.max(-120, v.rsb + (n.dr || 0));
    const advance = Math.max(20, Math.round(lsb + bbox.w + rsb));
    return { contours, bbox, lsb, rsb, advance };
  };

  /**
   * Assemble the compile-ready glyph set from the library.
   * glyphsByChar: { key: {variants:[...], active: index} } — a key is one
   *   character, or a ligature's letters ("ar").
   * opts.mirrorCase: map missing case onto the drawn counterpart.
   * opts.variantOffset: rotate each slot's pick by N — used to build the
   *   alternate "cycle fonts" so repeated letters vary in the tester.
   * opts.weight: 0..1 — instead of each slot's active pick, show the variant
   *   nearest a target weight that runs from the library's lightest
   *   letterform (0) to its heaviest (1). Slots with one variant repeat it.
   * Returns Map(codepoint → {contours, advance, lsb, id, char, weight}) —
   * shared objects when two codepoints reuse one drawing — with
   * `ligatures` ([{chars, glyph}]) and `liga` (Map chars → glyph) attached.
   */
  M.buildFontGlyphs = function (glyphsByChar, opts) {
    const o = opts || {};
    const map = new Map();
    map.ligatures = [];
    map.liga = new Map();
    const finalized = {};
    const offset = o.variantOffset || 0;
    let target = null;
    if (typeof o.weight === 'number') {
      let lo = Infinity, hi = -Infinity;
      for (const ch in glyphsByChar) {
        for (const v of (glyphsByChar[ch] && glyphsByChar[ch].variants) || []) {
          const wv = M.weightOf(v);
          lo = Math.min(lo, wv); hi = Math.max(hi, wv);
        }
      }
      if (isFinite(lo)) target = lo + Math.max(0, Math.min(1, o.weight)) * (hi - lo);
    }
    for (const ch in glyphsByChar) {
      const slot = glyphsByChar[ch];
      if (!slot || !slot.variants || !slot.variants.length) continue;
      const n = slot.variants.length;
      let idx = ((Math.min(slot.active || 0, n - 1) + offset) % n + n) % n;
      if (target != null) {
        let bestD = Infinity;
        slot.variants.forEach((v, i) => {
          const d = Math.abs(M.weightOf(v) - target);
          if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && i === slot.active)) { bestD = d; idx = i; }
        });
      }
      const v = slot.variants[idx];
      const fin = M.finalizeVariant(v);
      fin.id = v.id; fin.char = ch; fin.weight = M.weightOf(v);
      finalized[ch] = fin;
      if (ch.length > 1) {
        map.ligatures.push({ chars: ch, glyph: fin });
        map.liga.set(ch, fin);
      } else {
        map.set(ch.codePointAt(0), fin);
      }
    }
    if (o.mirrorCase) {
      for (const ch in finalized) {
        if (ch.length === 1 && /[a-zA-Z]/.test(ch)) {
          const other = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
          const cp = other.codePointAt(0);
          if (!map.has(cp)) map.set(cp, finalized[ch]);
        }
      }
    }
    // Space is always present so the tester reads as text immediately.
    if (!map.has(32)) map.set(32, { contours: [], advance: M.SPACE_ADV, lsb: 0 });
    return map;
  };

  // Longest-first ligature match at position i of a character array.
  M.ligatureAt = function (chars, i, keys) {
    for (const L of keys) {
      if (i + L.length > chars.length) continue;
      let ok = true;
      for (let k = 0; k < L.length; k++) if (chars[i + k] !== L[k]) { ok = false; break; }
      if (ok) return L;
    }
    return null;
  };
  M.ligatureKeys = function (map) {
    return map && map.ligatures ? map.ligatures.map((l) => l.chars).sort((a, b) => b.length - a.length) : [];
  };
})(typeof window !== 'undefined' ? window : globalThis);
