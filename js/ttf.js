/* SANSTYLE — ttf.js
 * A dependency-free TrueType compiler. Takes the fitted glyph set (cubic
 * contours in font units) and emits a complete, installable .ttf:
 * cubics → quadratics, winding normalization, and the ten required tables
 * (head, hhea, maxp, OS/2, hmtx, cmap, loca, glyf, name, post) with correct
 * checksums.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const V = ST.geom;
  const M = ST.metrics;
  const ttf = (ST.ttf = {});

  // --- byte writer -----------------------------------------------------------
  class W {
    constructor() { this.a = []; }
    u8(v) { this.a.push(v & 0xff); }
    u16(v) { this.a.push((v >> 8) & 0xff, v & 0xff); }
    i16(v) { this.u16(v < 0 ? v + 0x10000 : v); }
    u32(v) { this.a.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }
    tag(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
    bytes(arr) { for (let i = 0; i < arr.length; i++) this.a.push(arr[i] & 0xff); }
    pad4() { while (this.a.length % 4) this.a.push(0); }
    get length() { return this.a.length; }
    toU8() { return Uint8Array.from(this.a); }
  }

  function checksum(u8, off, len) {
    let sum = 0;
    const end = off + len;
    for (let i = off; i < end; i += 4) {
      const b0 = u8[i] || 0, b1 = u8[i + 1] || 0, b2 = u8[i + 2] || 0, b3 = u8[i + 3] || 0;
      sum = (sum + ((b0 << 24) >>> 0) + (b1 << 16) + (b2 << 8) + b3) >>> 0;
    }
    return sum >>> 0;
  }

  // --- cubic → quadratic ------------------------------------------------------
  function splitCubic(c) {
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const [p0, c1, c2, p3] = c;
    const a = mid(p0, c1), b = mid(c1, c2), d = mid(c2, p3);
    const e = mid(a, b), f = mid(b, d), m = mid(e, f);
    return [[p0, a, e, m], [m, f, d, p3]];
  }

  function cubicToQuads(c, tol, out, depth) {
    const [p0, c1, c2, p3] = c;
    // Max deviation of the single-quad approximation: (√3/36)·|p3−3c2+3c1−p0|
    const ex = p3.x - 3 * c2.x + 3 * c1.x - p0.x;
    const ey = p3.y - 3 * c2.y + 3 * c1.y - p0.y;
    const err = (Math.sqrt(3) / 36) * Math.hypot(ex, ey);
    if (err <= tol || depth >= 5) {
      out.push({
        c: { x: (3 * (c1.x + c2.x) - p0.x - p3.x) / 4, y: (3 * (c1.y + c2.y) - p0.y - p3.y) / 4 },
        p: p3,
      });
      return;
    }
    const [l, r] = splitCubic(c);
    cubicToQuads(l, tol, out, depth + 1);
    cubicToQuads(r, tol, out, depth + 1);
  }

  // --- outline → TrueType points ----------------------------------------------
  // Enforce TrueType winding: outer contours clockwise (negative shoelace in
  // y-up), counters counter-clockwise.
  function normalizeWinding(contours) {
    const polys = contours.map((c) => V.flattenContour(c.cubics, 8));
    return contours.map((c, i) => {
      let depth = 0;
      const probe = polys[i][0];
      for (let j = 0; j < polys.length; j++) {
        if (j !== i && V.pointInPoly(probe, polys[j])) depth++;
      }
      const area = V.signedArea(polys[i]);
      const wantClockwise = depth % 2 === 0; // outer
      const isClockwise = area < 0;
      if (isClockwise === wantClockwise) return c;
      return { cubics: c.cubics.slice().reverse().map((cu) => [cu[3], cu[2], cu[1], cu[0]]) };
    });
  }

  // One contour → list of {x, y, on} integer points.
  function contourPoints(cubics, dx) {
    const quads = [];
    for (const cu of cubics) cubicToQuads(cu, 2.6, quads, 0);
    if (!quads.length) return null;
    const R = Math.round;
    const pts = [];
    const start = { x: R(cubics[0][0].x + dx), y: R(cubics[0][0].y), on: 1 };
    pts.push(start);
    for (let i = 0; i < quads.length; i++) {
      const q = quads[i];
      const cx = R(q.c.x + dx), cy = R(q.c.y);
      const px = R(q.p.x + dx), py = R(q.p.y);
      const prev = pts[pts.length - 1];
      const isLine = Math.abs(cx - (prev.x + px) / 2) <= 1 && Math.abs(cy - (prev.y + py) / 2) <= 1;
      if (!isLine) pts.push({ x: cx, y: cy, on: 0 });
      const last = i === quads.length - 1;
      if (!(last && px === start.x && py === start.y)) {
        if (!(pts.length && pts[pts.length - 1].on && pts[pts.length - 1].x === px && pts[pts.length - 1].y === py)) {
          pts.push({ x: px, y: py, on: 1 });
        }
      }
    }
    // Drop a trailing on-curve duplicate of the start point.
    while (pts.length > 1) {
      const lastPt = pts[pts.length - 1];
      if (lastPt.on && lastPt.x === start.x && lastPt.y === start.y) pts.pop();
      else break;
    }
    return pts.length >= 3 ? pts : null;
  }

  // Build one glyf entry. Returns {bytes: W, xMin, yMin, xMax, yMax, nPoints, nContours}
  function buildGlyf(glyph) {
    if (!glyph.contours || !glyph.contours.length) return null; // empty glyph
    const normalized = normalizeWinding(glyph.contours);
    // Translate so xMin lands exactly on the lsb.
    let minX = Infinity;
    for (const c of normalized) for (const cu of c.cubics) for (const p of cu) if (p.x < minX) minX = p.x;
    const dx = (glyph.lsb || 0) - minX;

    const contourPts = [];
    for (const c of normalized) {
      const pts = contourPoints(c.cubics, dx);
      if (pts) contourPts.push(pts);
    }
    if (!contourPts.length) return null;

    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity, nPoints = 0;
    for (const pts of contourPts) {
      nPoints += pts.length;
      for (const p of pts) {
        if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
        if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
      }
    }

    const w = new W();
    w.i16(contourPts.length);
    w.i16(xMin); w.i16(yMin); w.i16(xMax); w.i16(yMax);
    let end = -1;
    for (const pts of contourPts) { end += pts.length; w.u16(end); }
    w.u16(0); // no instructions

    const flags = [], xs = [], ys = [];
    let px = 0, py = 0;
    for (const pts of contourPts) {
      for (const p of pts) {
        let f = p.on ? 1 : 0;
        const ddx = p.x - px, ddy = p.y - py;
        if (ddx === 0) f |= 0x10;
        else if (Math.abs(ddx) <= 255) { f |= 0x02; if (ddx > 0) f |= 0x10; xs.push(Math.abs(ddx)); }
        else xs.push(ddx);
        if (ddy === 0) f |= 0x20;
        else if (Math.abs(ddy) <= 255) { f |= 0x04; if (ddy > 0) f |= 0x20; ys.push(Math.abs(ddy)); }
        else ys.push(ddy);
        flags.push(f);
        px = p.x; py = p.y;
      }
    }
    for (const f of flags) w.u8(f);
    let xi = 0;
    for (const f of flags) {
      if (f & 0x02) w.u8(xs[xi++]);
      else if (!(f & 0x10)) w.i16(xs[xi++]);
    }
    let yi = 0;
    for (const f of flags) {
      if (f & 0x04) w.u8(ys[yi++]);
      else if (!(f & 0x20)) w.i16(ys[yi++]);
    }
    w.pad4();
    return { w, xMin, yMin, xMax, yMax, nPoints, nContours: contourPts.length };
  }

  function notdefGlyph() {
    const rect = (x0, y0, x1, y1, cw) => {
      const c = [
        [{ x: x0, y: y0 }, { x: x0, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y1 }],
        [{ x: x0, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y1 }],
        [{ x: x1, y: y1 }, { x: x1, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y0 }],
        [{ x: x1, y: y0 }, { x: x0, y: y0 }, { x: x0, y: y0 }, { x: x0, y: y0 }],
      ];
      return { cubics: cw ? c : c.reverse().map((cu) => [cu[3], cu[2], cu[1], cu[0]]) };
    };
    return {
      contours: [rect(55, 0, 645, 700, true), rect(120, 65, 580, 635, false)],
      advance: 745,
      lsb: 55,
    };
  }

  function macDate() {
    // seconds since 1904-01-01T00:00:00Z
    return Math.floor(Date.now() / 1000) + 2082844800;
  }

  function nameTable(records) {
    // records: [{id, str}]  → platform 1/0/0 (mac ascii) + 3/1/0x409 (utf16be)
    const entries = [];
    const storage = [];
    let offset = 0;
    const pushStr = (bytes) => {
      const off = offset;
      storage.push(bytes);
      offset += bytes.length;
      return off;
    };
    for (const r of records) {
      const ascii = [];
      for (let i = 0; i < r.str.length; i++) ascii.push(r.str.charCodeAt(i) & 0x7f);
      entries.push({ pid: 1, eid: 0, lang: 0, id: r.id, len: ascii.length, off: pushStr(ascii) });
    }
    for (const r of records) {
      const utf16 = [];
      for (let i = 0; i < r.str.length; i++) {
        const c = r.str.charCodeAt(i);
        utf16.push((c >> 8) & 0xff, c & 0xff);
      }
      entries.push({ pid: 3, eid: 1, lang: 0x409, id: r.id, len: utf16.length, off: pushStr(utf16) });
    }
    entries.sort((a, b) => a.pid - b.pid || a.eid - b.eid || a.lang - b.lang || a.id - b.id);
    const w = new W();
    w.u16(0);
    w.u16(entries.length);
    w.u16(6 + entries.length * 12);
    for (const e of entries) {
      w.u16(e.pid); w.u16(e.eid); w.u16(e.lang); w.u16(e.id); w.u16(e.len); w.u16(e.off);
    }
    for (const s of storage) w.bytes(s);
    return w;
  }

  function cmapTable(cpToGid) {
    const cps = Array.from(cpToGid.keys()).sort((a, b) => a - b);
    // Segments: runs where codepoints and gids both advance by 1.
    const segs = [];
    for (const cp of cps) {
      const gid = cpToGid.get(cp);
      const last = segs[segs.length - 1];
      if (last && cp === last.endCp + 1 && gid === last.endGid + 1) {
        last.endCp = cp; last.endGid = gid;
      } else {
        segs.push({ startCp: cp, endCp: cp, startGid: gid, endGid: gid });
      }
    }
    segs.push({ startCp: 0xffff, endCp: 0xffff, startGid: 0, endGid: 0, final: true });

    const segCount = segs.length;
    const sub = new W();
    sub.u16(4); // format
    sub.u16(16 + segCount * 8); // length
    sub.u16(0); // language
    sub.u16(segCount * 2);
    const floorLog2 = Math.floor(Math.log2(segCount));
    const searchRange = 2 * Math.pow(2, floorLog2);
    sub.u16(searchRange);
    sub.u16(floorLog2);
    sub.u16(segCount * 2 - searchRange);
    for (const s of segs) sub.u16(s.endCp);
    sub.u16(0); // reservedPad
    for (const s of segs) sub.u16(s.startCp);
    for (const s of segs) {
      const delta = s.final ? 1 : (s.startGid - s.startCp) & 0xffff;
      sub.u16(delta);
    }
    for (let i = 0; i < segCount; i++) sub.u16(0); // idRangeOffset

    const w = new W();
    w.u16(0); // version
    w.u16(2); // two encoding records → same subtable
    const subOff = 4 + 2 * 8;
    w.u16(0); w.u16(3); w.u32(subOff);       // Unicode BMP
    w.u16(3); w.u16(1); w.u32(subOff);       // Windows BMP
    w.bytes(sub.toU8());
    return w;
  }

  /**
   * Compile a TrueType font.
   * @param opts { fontName, glyphMap: Map(cp → {contours, advance, lsb}), styleName }
   * @returns Uint8Array
   */
  ttf.compile = function (opts) {
    const fontName = (opts.fontName || 'Sanstyle').trim() || 'Sanstyle';
    const styleName = opts.styleName || 'Regular';
    const UPM = M ? M.UPM : 1000;
    const CAP = M ? M.CAP : 700, XH = M ? M.XH : 490;

    // ---- glyph order: .notdef + unique outline objects by first codepoint
    const cps = Array.from(opts.glyphMap.keys()).filter((cp) => cp >= 0 && cp <= 0xfffd).sort((a, b) => a - b);
    const outlineGid = new Map(); // outline object → gid
    const glyphs = [notdefGlyph()];
    const cpToGid = new Map();
    for (const cp of cps) {
      const gl = opts.glyphMap.get(cp);
      let gid = outlineGid.get(gl);
      if (gid === undefined) {
        gid = glyphs.length;
        glyphs.push(gl);
        outlineGid.set(gl, gid);
      }
      cpToGid.set(cp, gid);
    }
    const numGlyphs = glyphs.length;

    // ---- glyf + loca + per-glyph metrics
    const glyfW = new W();
    const loca = [0];
    const gm = []; // {advance, lsb, xMin.. or null}
    let maxPoints = 0, maxContours = 0;
    let fxMin = Infinity, fyMin = Infinity, fxMax = -Infinity, fyMax = -Infinity;
    for (const gl of glyphs) {
      const rec = buildGlyf(gl);
      if (rec) {
        glyfW.bytes(rec.w.toU8());
        maxPoints = Math.max(maxPoints, rec.nPoints);
        maxContours = Math.max(maxContours, rec.nContours);
        fxMin = Math.min(fxMin, rec.xMin); fyMin = Math.min(fyMin, rec.yMin);
        fxMax = Math.max(fxMax, rec.xMax); fyMax = Math.max(fyMax, rec.yMax);
        gm.push({ advance: Math.round(gl.advance), lsb: rec.xMin, xMax: rec.xMax, empty: false });
      } else {
        gm.push({ advance: Math.round(gl.advance || 0), lsb: 0, xMax: 0, empty: true });
      }
      loca.push(glyfW.length);
    }
    if (!isFinite(fxMin)) { fxMin = 0; fyMin = 0; fxMax = 0; fyMax = 0; }

    const ascender = Math.max(760, fyMax + 12);
    const descender = Math.min(-240, fyMin - 12);

    // ---- tables
    const tables = {};

    const head = new W();
    head.u32(0x00010000); // version
    head.u32(0x00010000); // fontRevision 1.0
    head.u32(0);          // checkSumAdjustment (patched later)
    head.u32(0x5f0f3cf5); // magic
    head.u16(0x0003);     // flags: baseline at 0, lsb at xMin
    head.u16(UPM);
    const dt = macDate();
    head.u32(0); head.u32(dt); // created
    head.u32(0); head.u32(dt); // modified
    head.i16(fxMin); head.i16(fyMin); head.i16(fxMax); head.i16(fyMax);
    head.u16(0);   // macStyle
    head.u16(8);   // lowestRecPPEM
    head.i16(2);   // fontDirectionHint
    head.i16(1);   // indexToLocFormat: long
    head.i16(0);   // glyphDataFormat (table is 54 bytes; assembler pads)
    tables.head = head;

    const hhea = new W();
    hhea.u32(0x00010000);
    hhea.i16(ascender);
    hhea.i16(descender);
    hhea.i16(90); // lineGap
    let advMax = 0;
    for (const m of gm) advMax = Math.max(advMax, m.advance);
    hhea.u16(advMax);
    let minLsb = 0x7fff, minRsb = 0x7fff, maxExtent = 0;
    for (const m of gm) {
      if (m.empty) continue;
      minLsb = Math.min(minLsb, m.lsb);
      minRsb = Math.min(minRsb, m.advance - m.xMax);
      maxExtent = Math.max(maxExtent, m.xMax);
    }
    if (minLsb === 0x7fff) { minLsb = 0; minRsb = 0; }
    hhea.i16(minLsb);
    hhea.i16(minRsb);
    hhea.i16(maxExtent);
    hhea.i16(1); hhea.i16(0); // caretSlope rise/run
    hhea.i16(0);              // caretOffset
    hhea.i16(0); hhea.i16(0); hhea.i16(0); hhea.i16(0); // reserved
    hhea.i16(0);              // metricDataFormat
    hhea.u16(numGlyphs);      // numberOfHMetrics
    tables.hhea = hhea;

    const maxp = new W();
    maxp.u32(0x00010000);
    maxp.u16(numGlyphs);
    maxp.u16(maxPoints);
    maxp.u16(maxContours);
    maxp.u16(0); maxp.u16(0); // composite points/contours
    maxp.u16(2); // maxZones
    maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0);
    maxp.u16(0); maxp.u16(0);
    tables.maxp = maxp;

    const os2 = new W();
    os2.u16(4); // version
    let advSum = 0, advN = 0;
    for (const m of gm) { if (m.advance) { advSum += m.advance; advN++; } }
    os2.i16(advN ? Math.round(advSum / advN) : 500);
    os2.u16(400); // weight
    os2.u16(5);   // width
    os2.u16(0);   // fsType: installable
    os2.i16(650); os2.i16(600); os2.i16(0); os2.i16(75);    // subscript
    os2.i16(650); os2.i16(600); os2.i16(0); os2.i16(350);   // superscript
    os2.i16(50); os2.i16(255);                              // strikeout
    os2.i16(0);                                             // sFamilyClass
    os2.bytes([2, 0, 5, 3, 0, 0, 0, 0, 0, 0]);              // panose
    os2.u32(1); os2.u32(0); os2.u32(0); os2.u32(0);         // unicode ranges: Basic Latin
    os2.tag('SNST');
    os2.u16(0x00c0); // fsSelection: REGULAR | USE_TYPO_METRICS
    os2.u16(cps.length ? Math.max(0x20, cps[0]) : 0x20);
    os2.u16(cps.length ? Math.min(0xffff, cps[cps.length - 1]) : 0x20);
    os2.i16(760);            // sTypoAscender
    os2.i16(-240);           // sTypoDescender
    os2.i16(90);             // sTypoLineGap
    os2.u16(ascender);       // usWinAscent
    os2.u16(-descender);     // usWinDescent
    os2.u32(1); os2.u32(0);  // codepage: Latin 1
    os2.i16(XH);
    os2.i16(CAP);
    os2.u16(0);      // usDefaultChar
    os2.u16(32);     // usBreakChar
    os2.u16(1);      // usMaxContext
    tables['OS/2'] = os2;

    const hmtx = new W();
    for (const m of gm) { hmtx.u16(m.advance); hmtx.i16(m.lsb); }
    hmtx.pad4();
    tables.hmtx = hmtx;

    tables.cmap = cmapTable(cpToGid);

    const locaW = new W();
    for (const off of loca) locaW.u32(off);
    tables.loca = locaW;

    glyfW.pad4();
    tables.glyf = glyfW;

    const psName = (fontName + '-' + styleName).replace(/[^A-Za-z0-9-]/g, '');
    tables.name = nameTable([
      { id: 0, str: 'Sourced from the streets. Built with SANSTYLE.' },
      { id: 1, str: fontName },
      { id: 2, str: styleName },
      { id: 3, str: 'SANSTYLE:' + psName },
      { id: 4, str: fontName + ' ' + styleName },
      { id: 5, str: 'Version 1.000' },
      { id: 6, str: psName },
    ]);

    const post = new W();
    post.u32(0x00030000);
    post.u32(0);          // italicAngle
    post.i16(-100);       // underlinePosition
    post.i16(60);         // underlineThickness
    post.u32(0);          // isFixedPitch
    post.u32(0); post.u32(0); post.u32(0); post.u32(0);
    tables.post = post;

    // ---- assemble ------------------------------------------------------------
    const tags = Object.keys(tables).sort();
    const numTables = tags.length;
    const out = new W();
    out.u32(0x00010000);
    out.u16(numTables);
    const fl2 = Math.floor(Math.log2(numTables));
    const searchRange = 16 * Math.pow(2, fl2);
    out.u16(searchRange);
    out.u16(fl2);
    out.u16(numTables * 16 - searchRange);

    let offset = 12 + numTables * 16;
    const dir = [];
    for (const tag of tags) {
      const data = tables[tag].toU8();
      const padded = (data.length + 3) & ~3;
      dir.push({ tag, offset, length: data.length, data, checksum: checksum(data, 0, padded) });
      offset += padded;
    }
    for (const d of dir) {
      out.tag(d.tag);
      out.u32(d.checksum);
      out.u32(d.offset);
      out.u32(d.length);
    }
    let headOffset = -1;
    for (const d of dir) {
      if (d.tag === 'head') headOffset = out.length;
      out.bytes(d.data);
      while (out.length % 4) out.u8(0);
    }
    const bytes = out.toU8();
    // checkSumAdjustment
    const total = checksum(bytes, 0, (bytes.length + 3) & ~3);
    const adj = (0xb1b0afba - total) >>> 0;
    bytes[headOffset + 8] = (adj >>> 24) & 0xff;
    bytes[headOffset + 9] = (adj >>> 16) & 0xff;
    bytes[headOffset + 10] = (adj >>> 8) & 0xff;
    bytes[headOffset + 11] = adj & 0xff;
    return bytes;
  };
})(typeof window !== 'undefined' ? window : globalThis);
