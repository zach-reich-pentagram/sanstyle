/* SANSTYLE — export.js
 * A small specimen layout engine over the compiled glyph outlines, so the
 * tester's exact text (with variant cycling and manual kerns) can be exported
 * as SVG, PNG, or JPG without depending on browser text layout.
 * Explicit newlines break lines; no auto-wrapping in exports.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const ex = (ST.exporter = {});
  const UPM = 1000;

  /**
   * Lay out text with the live glyph maps.
   * opts: { size, tracking (em), leading, align, cycle, kerns {index→em},
   *         glyphMaps: [baseMap, cycMap1, ...] }
   * Returns { lines: [{glyphs: [{outline, x}], width, y}], width, height,
   *           ascent, size }
   */
  ex.layout = function (text, opts) {
    const o = opts;
    const scale = o.size / UPM;
    const lineH = o.size * o.leading;
    const ascent = o.size * 0.76;
    const maps = o.glyphMaps && o.glyphMaps.length ? o.glyphMaps : [new Map()];
    const ligKeys = ST.metrics.ligatureKeys(maps[0]);
    const lookup = (m, key) => key.length > 1
      ? (m.liga && m.liga.get(key)) || null
      : (m.has(key.codePointAt(0)) ? m.get(key.codePointAt(0)) : null);
    const occurrence = {};
    const lines = [];
    let maxW = 0;
    let charIndex = 0;

    for (const lineText of String(text).split('\n')) {
      const glyphs = [];
      let x = 0;
      const chars = Array.from(lineText);
      for (let i = 0; i < chars.length;) {
        // a captured ligature swallows its letters, like the font's GSUB does
        const key = ST.metrics.ligatureAt(chars, i, ligKeys) || chars[i];
        const idx = charIndex;
        charIndex += key.length;
        i += key.length;
        const kern = (o.kerns && o.kerns[idx]) ? o.kerns[idx] * o.size : 0;
        x += kern;
        let outline = lookup(maps[0], key);
        if (outline && o.cycle && maps.length > 1) {
          const occ = occurrence[key] || 0;
          occurrence[key] = occ + 1;
          outline = lookup(maps[occ % maps.length], key) || outline;
        }
        if (outline) {
          glyphs.push({ outline, x });
          x += outline.advance * scale + o.tracking * o.size;
        } else {
          // unknown character: leave a visible gap
          x += o.size * 0.38 + o.tracking * o.size;
        }
      }
      charIndex++; // the newline itself
      lines.push({ glyphs, width: x });
      maxW = Math.max(maxW, x);
    }
    lines.forEach((ln, i) => { ln.y = ascent + i * lineH; });
    return {
      lines,
      width: maxW,
      height: (lines.length - 1) * lineH + o.size * 1.05,
      ascent,
      size: o.size,
      align: o.align,
    };
  };

  function eachGlyphPath(layout, canvasW, pad, cb) {
    const scale = layout.size / UPM;
    for (const ln of layout.lines) {
      let shift = pad;
      if (layout.align === 'center') shift = (canvasW - ln.width) / 2;
      else if (layout.align === 'right') shift = canvasW - pad - ln.width;
      for (const gl of ln.glyphs) {
        cb(gl.outline, shift + gl.x + gl.outline.lsb * scale, pad + ln.y, scale);
      }
    }
  }

  ex.svg = function (layout, opts) {
    const pad = opts.pad != null ? opts.pad : Math.round(layout.size * 0.35);
    const W = Math.max(4, Math.ceil(layout.width + pad * 2));
    const H = Math.max(4, Math.ceil(layout.height + pad * 2));
    const n2 = (v) => Math.round(v * 100) / 100;
    let body = '';
    eachGlyphPath(layout, W, pad, (outline, ox, oy, s) => {
      let d = '';
      for (const c of outline.contours) {
        const cs = c.cubics;
        d += `M${n2(ox + cs[0][0].x * s)} ${n2(oy - cs[0][0].y * s)}`;
        for (const cu of cs) {
          d += `C${n2(ox + cu[1].x * s)} ${n2(oy - cu[1].y * s)} ${n2(ox + cu[2].x * s)} ${n2(oy - cu[2].y * s)} ${n2(ox + cu[3].x * s)} ${n2(oy - cu[3].y * s)}`;
        }
        d += 'Z';
      }
      if (d) body += `<path d="${d}"/>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="${opts.bg}"/>` +
      `<g fill="${opts.fg}" fill-rule="nonzero">${body}</g></svg>`;
  };

  ex.raster = function (layout, opts) {
    const pad = opts.pad != null ? opts.pad : Math.round(layout.size * 0.35);
    const scaleUp = opts.scaleUp || 2;
    const W = Math.max(4, Math.ceil(layout.width + pad * 2));
    const H = Math.max(4, Math.ceil(layout.height + pad * 2));
    const cnv = g.document.createElement('canvas');
    cnv.width = W * scaleUp; cnv.height = H * scaleUp;
    const c = cnv.getContext('2d');
    c.scale(scaleUp, scaleUp);
    c.fillStyle = opts.bg;
    c.fillRect(0, 0, W, H);
    c.fillStyle = opts.fg;
    eachGlyphPath(layout, W, pad, (outline, ox, oy, s) => {
      const path = new Path2D();
      for (const cont of outline.contours) {
        const cs = cont.cubics;
        path.moveTo(ox + cs[0][0].x * s, oy - cs[0][0].y * s);
        for (const cu of cs) {
          path.bezierCurveTo(
            ox + cu[1].x * s, oy - cu[1].y * s,
            ox + cu[2].x * s, oy - cu[2].y * s,
            ox + cu[3].x * s, oy - cu[3].y * s
          );
        }
        path.closePath();
      }
      c.fill(path, 'nonzero');
    });
    return cnv;
  };

  // ---------- single-letterform SVG (the Drive mirror) ----------
  const MARK_NAMES = {
    '.': 'period', ',': 'comma', ':': 'colon', ';': 'semicolon', '!': 'exclaim',
    '?': 'question', "'": 'apostrophe', '"': 'quote', '-': 'hyphen',
    '_': 'underscore', '#': 'hash', '@': 'at', '&': 'ampersand', '$': 'dollar',
    '%': 'percent', '(': 'paren-open', ')': 'paren-close', '[': 'bracket-open',
    ']': 'bracket-close', '*': 'asterisk', '+': 'plus', '=': 'equals',
    '/': 'slash', '\\': 'backslash', '<': 'less', '>': 'greater',
    '`': 'backtick', '{': 'brace-open', '}': 'brace-close', '|': 'pipe',
    '~': 'tilde', '^': 'caret',
  };

  ex.charLabel = function (ch) {
    if (/^[A-Za-z0-9]{2,4}$/.test(ch)) return ch + '-liga';
    if (/^[A-Z]$/.test(ch)) return ch + '-caps';
    if (/^[a-z]$/.test(ch)) return ch + '-lower';
    if (/^[0-9]$/.test(ch)) return ch;
    if (MARK_NAMES[ch]) return MARK_NAMES[ch];
    return 'u' + ch.codePointAt(0).toString(16);
  };

  ex.svgFileName = function (record) {
    return `${ex.charLabel(record.char)}__${record.id}.svg`;
  };

  /** One letterform as a standalone SVG, em-box viewBox (asc 760 → desc −240). */
  ex.variantSVG = function (record) {
    const fin = ST.metrics.finalizeVariant(record);
    const n2 = (v) => Math.round(v * 100) / 100;
    const yTop = 760;
    let d = '';
    for (const c of fin.contours) {
      const cs = c.cubics;
      d += `M${n2(cs[0][0].x + fin.lsb)} ${n2(yTop - cs[0][0].y)}`;
      for (const cu of cs) {
        d += `C${n2(cu[1].x + fin.lsb)} ${n2(yTop - cu[1].y)} ` +
          `${n2(cu[2].x + fin.lsb)} ${n2(yTop - cu[2].y)} ` +
          `${n2(cu[3].x + fin.lsb)} ${n2(yTop - cu[3].y)}`;
      }
      d += 'Z';
    }
    const esc = record.char === '<' ? '&lt;' : record.char === '&' ? '&amp;' : record.char;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(1, fin.advance)} 1000" ` +
      `data-char="${esc}" data-advance="${fin.advance}" data-lsb="${fin.lsb}">` +
      `<title>${esc}</title>` +
      `<path fill="#000" fill-rule="nonzero" d="${d}"/></svg>`;
  };

  ex.download = function (blob, filename) {
    const a = ST.el('a', { href: URL.createObjectURL(blob), download: filename });
    g.document.body.appendChild(a);
    a.click();
    a.remove();
  };
})(typeof window !== 'undefined' ? window : globalThis);
