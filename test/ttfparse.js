// Minimal independent TrueType reader used to verify compiler output.
// Deliberately written against the spec, not against ttf.js internals.
'use strict';

function u8(b, o) { return b[o]; }
function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function i16(b, o) { const v = u16(b, o); return v >= 0x8000 ? v - 0x10000 : v; }
function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function tag(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

function checksum(b, off, len) {
  let sum = 0;
  for (let i = off; i < off + len; i += 4) {
    sum = (sum + ((b[i] || 0) * 0x1000000) + ((b[i + 1] || 0) << 16) + ((b[i + 2] || 0) << 8) + (b[i + 3] || 0)) >>> 0;
  }
  return sum >>> 0;
}

function parse(bytes) {
  const b = bytes;
  const font = { errors: [], tables: {} };
  if (u32(b, 0) !== 0x00010000) font.errors.push('bad sfnt version');
  const numTables = u16(b, 4);
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const t = tag(b, off);
    font.tables[t] = { checksum: u32(b, off + 4), offset: u32(b, off + 8), length: u32(b, off + 12) };
  }

  // table checksums
  for (const t in font.tables) {
    const e = font.tables[t];
    let sum;
    if (t === 'head') {
      // NB: Buffer.slice is a view — force a real copy before zeroing.
      const copy = Uint8Array.prototype.slice.call(b, e.offset, e.offset + ((e.length + 3) & ~3));
      copy[8] = copy[9] = copy[10] = copy[11] = 0;
      sum = checksum(copy, 0, copy.length);
    } else {
      sum = checksum(b, e.offset, (e.length + 3) & ~3);
    }
    if (sum !== e.checksum) font.errors.push(`checksum mismatch for ${t}`);
  }
  // whole font checksum
  if (font.tables.head) {
    const whole = checksum(b, 0, (b.length + 3) & ~3);
    if (whole !== 0xb1b0afba) font.errors.push(`whole-font checksum ${whole.toString(16)} != b1b0afba`);
    const h = font.tables.head.offset;
    if (u32(b, h + 12) !== 0x5f0f3cf5) font.errors.push('bad head magic');
    font.unitsPerEm = u16(b, h + 18);
    font.indexToLocFormat = i16(b, h + 50);
    font.xMin = i16(b, h + 36); font.yMin = i16(b, h + 38);
    font.xMax = i16(b, h + 40); font.yMax = i16(b, h + 42);
  }
  if (font.tables.maxp) font.numGlyphs = u16(b, font.tables.maxp.offset + 4);
  if (font.tables.hhea) {
    const o = font.tables.hhea.offset;
    font.ascender = i16(b, o + 4);
    font.descender = i16(b, o + 6);
    font.numberOfHMetrics = u16(b, o + 34);
  }
  if (font.tables.hmtx && font.numberOfHMetrics) {
    const o = font.tables.hmtx.offset;
    font.hmtx = [];
    for (let i = 0; i < font.numberOfHMetrics; i++) {
      font.hmtx.push({ advance: u16(b, o + i * 4), lsb: i16(b, o + i * 4 + 2) });
    }
  }
  // loca + glyf
  if (font.tables.loca && font.numGlyphs != null) {
    const o = font.tables.loca.offset;
    font.loca = [];
    if (font.indexToLocFormat === 1) {
      for (let i = 0; i <= font.numGlyphs; i++) font.loca.push(u32(b, o + i * 4));
    } else {
      for (let i = 0; i <= font.numGlyphs; i++) font.loca.push(u16(b, o + i * 2) * 2);
    }
    font.glyphs = [];
    const go = font.tables.glyf.offset;
    for (let i = 0; i < font.numGlyphs; i++) {
      if (font.loca[i] === font.loca[i + 1]) { font.glyphs.push({ empty: true }); continue; }
      const off = go + font.loca[i];
      const nc = i16(b, off);
      const gl = {
        contours: nc,
        xMin: i16(b, off + 2), yMin: i16(b, off + 4),
        xMax: i16(b, off + 6), yMax: i16(b, off + 8),
      };
      if (nc >= 0) {
        gl.endPts = [];
        for (let c = 0; c < nc; c++) gl.endPts.push(u16(b, off + 10 + c * 2));
        gl.nPoints = nc ? gl.endPts[nc - 1] + 1 : 0;
        // decode points to verify flag/coord streams parse cleanly
        let p = off + 10 + nc * 2;
        const insLen = u16(b, p); p += 2 + insLen;
        const flags = [];
        while (flags.length < gl.nPoints) {
          const f = u8(b, p++);
          flags.push(f);
          if (f & 0x08) { let rep = u8(b, p++); while (rep--) flags.push(f); }
        }
        let x = 0; const xs = [];
        for (const f of flags) {
          if (f & 0x02) { const d = u8(b, p++); x += (f & 0x10) ? d : -d; }
          else if (!(f & 0x10)) { x += i16(b, p); p += 2; }
          xs.push(x);
        }
        let y = 0; const ys = [];
        for (const f of flags) {
          if (f & 0x04) { const d = u8(b, p++); y += (f & 0x20) ? d : -d; }
          else if (!(f & 0x20)) { y += i16(b, p); p += 2; }
          ys.push(y);
        }
        gl.points = flags.map((f, k) => ({ x: xs[k], y: ys[k], on: !!(f & 1) }));
        const axMin = Math.min(...xs), axMax = Math.max(...xs);
        const ayMin = Math.min(...ys), ayMax = Math.max(...ys);
        if (axMin !== gl.xMin || axMax !== gl.xMax || ayMin !== gl.yMin || ayMax !== gl.yMax) {
          font.errors.push(`glyph ${i}: bbox header (${gl.xMin},${gl.yMin},${gl.xMax},${gl.yMax}) != actual (${axMin},${ayMin},${axMax},${ayMax})`);
        }
      }
      font.glyphs.push(gl);
    }
  }
  // cmap format 4
  if (font.tables.cmap) {
    const o = font.tables.cmap.offset;
    const n = u16(b, o + 2);
    let subOff = -1;
    for (let i = 0; i < n; i++) {
      const pid = u16(b, o + 4 + i * 8);
      const eid = u16(b, o + 6 + i * 8);
      if ((pid === 3 && eid === 1) || (pid === 0)) subOff = o + u32(b, o + 8 + i * 8);
    }
    font.cmap = new Map();
    if (subOff >= 0 && u16(b, subOff) === 4) {
      const segX2 = u16(b, subOff + 6);
      const segs = segX2 / 2;
      const endO = subOff + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (let s = 0; s < segs; s++) {
        const end = u16(b, endO + s * 2), start = u16(b, startO + s * 2);
        const delta = u16(b, deltaO + s * 2), range = u16(b, rangeO + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid;
          if (range === 0) gid = (c + delta) & 0xffff;
          else {
            const gi = rangeO + s * 2 + range + (c - start) * 2;
            gid = u16(b, gi);
            if (gid) gid = (gid + delta) & 0xffff;
          }
          if (gid) font.cmap.set(c, gid);
        }
      }
    } else {
      font.errors.push('no format-4 cmap subtable found');
    }
  }
  // GSUB: scripts, feature tags, and every type-4 (ligature) rule
  if (font.tables.GSUB) {
    const o = font.tables.GSUB.offset;
    if (u16(b, o) !== 1) font.errors.push('bad GSUB major version');
    const sl = o + u16(b, o + 4), fl = o + u16(b, o + 6), ll = o + u16(b, o + 8);
    font.gsubScripts = [];
    const sc = u16(b, sl);
    for (let i = 0; i < sc; i++) {
      font.gsubScripts.push(tag(b, sl + 2 + i * 6));
      const script = sl + u16(b, sl + 6 + i * 6);
      const langSys = script + u16(b, script);
      const nFeat = u16(b, langSys + 4);
      if (u16(b, langSys + 2) !== 0xffff) font.errors.push('required feature index set');
      if (nFeat < 1) font.errors.push('default LangSys lists no features');
    }
    font.gsubFeatures = [];
    const fc = u16(b, fl);
    for (let i = 0; i < fc; i++) font.gsubFeatures.push(tag(b, fl + 2 + i * 6));
    font.ligatures = [];
    const lc = u16(b, ll);
    for (let i = 0; i < lc; i++) {
      const lk = ll + u16(b, ll + 2 + i * 2);
      const type = u16(b, lk), nSub = u16(b, lk + 4);
      if (type !== 4) continue;
      for (let s = 0; s < nSub; s++) {
        const st = lk + u16(b, lk + 6 + s * 2);
        if (u16(b, st) !== 1) { font.errors.push('unknown ligature subst format'); continue; }
        const cov = st + u16(b, st + 2);
        const nSets = u16(b, st + 4);
        const covGlyphs = [];
        if (u16(b, cov) === 1) {
          const n = u16(b, cov + 2);
          for (let k = 0; k < n; k++) covGlyphs.push(u16(b, cov + 4 + k * 2));
        } else {
          font.errors.push('test parser only reads coverage format 1');
        }
        for (let k = 1; k < covGlyphs.length; k++) {
          if (covGlyphs[k] <= covGlyphs[k - 1]) { font.errors.push('coverage glyphs not ascending'); break; }
        }
        if (covGlyphs.length !== nSets) font.errors.push('coverage/ligature-set count mismatch');
        for (let k = 0; k < nSets; k++) {
          const set = st + u16(b, st + 6 + k * 2);
          const n = u16(b, set);
          for (let m = 0; m < n; m++) {
            const lig = set + u16(b, set + 2 + m * 2);
            const gid = u16(b, lig), compCount = u16(b, lig + 2);
            const comps = [covGlyphs[k]];
            for (let c = 1; c < compCount; c++) comps.push(u16(b, lig + 4 + (c - 1) * 2));
            if (font.numGlyphs != null && (gid >= font.numGlyphs || comps.some((g) => g >= font.numGlyphs))) {
              font.errors.push('ligature rule references a glyph past numGlyphs');
            }
            font.ligatures.push({ gid, comps });
          }
        }
      }
    }
  }
  return font;
}

module.exports = { parse };
