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
    const occurrence = {};
    const lines = [];
    let maxW = 0;
    let charIndex = 0;

    for (const lineText of String(text).split('\n')) {
      const glyphs = [];
      let x = 0;
      for (const ch of lineText) {
        const cp = ch.codePointAt(0);
        const idx = charIndex++;
        const kern = (o.kerns && o.kerns[idx]) ? o.kerns[idx] * o.size : 0;
        x += kern;
        let outline = null;
        if (maps[0].has(cp)) {
          let m = maps[0];
          if (o.cycle && maps.length > 1) {
            const occ = occurrence[ch] || 0;
            occurrence[ch] = occ + 1;
            m = maps[occ % maps.length];
            if (!m.has(cp)) m = maps[0];
          }
          outline = m.get(cp);
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

  ex.download = function (blob, filename) {
    const a = ST.el('a', { href: URL.createObjectURL(blob), download: filename });
    g.document.body.appendChild(a);
    a.click();
    a.remove();
  };
})(typeof window !== 'undefined' ? window : globalThis);
