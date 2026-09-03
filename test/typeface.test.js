'use strict';
// Typeface-level features: ligature keys, weight targeting, GSUB output.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadST } = require('./loader');
const { parse } = require('./ttfparse');

const ST = loadST();

const P = (x, y) => ({ x, y });
const line = (a, b) => [a, P(a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3), P(a.x + 2 * (b.x - a.x) / 3, a.y + 2 * (b.y - a.y) / 3), b];
function rect(x0, y0, x1, y1) {
  return { cubics: [
    line(P(x0, y0), P(x1, y0)), line(P(x1, y0), P(x1, y1)),
    line(P(x1, y1), P(x0, y1)), line(P(x0, y1), P(x0, y0)),
  ] };
}

test('charKey: one character, or a two-to-four letter ligature', () => {
  const k = ST.metrics.charKey;
  assert.strictEqual(k('A'), 'A');
  assert.strictEqual(k(' a '), 'a');
  assert.strictEqual(k('ar'), 'ar');
  assert.strictEqual(k('Bl'), 'Bl');
  assert.strictEqual(k('gr2'), 'gr2');
  assert.strictEqual(k('!!'), '!', 'marks never ligate');
  assert.strictEqual(k('a-r'), 'r');
  assert.strictEqual(k('abcde'), 'e', 'five letters is not a ligature');
  assert.strictEqual(k(''), '');
  assert.strictEqual(k('  '), '');
  assert.strictEqual(k(null), '');
});

test('weightOf: a fat bar weighs more than a thin one; a counter lightens', () => {
  const thin = ST.metrics.buildRecord('I', [rect(0, 0, 20, 200)]);
  const fat = ST.metrics.buildRecord('I', [rect(0, 0, 80, 200)]);
  assert.ok(thin.weight > 0 && fat.weight > thin.weight * 2, `fat ${fat.weight} vs thin ${thin.weight}`);
  const block = ST.metrics.buildRecord('O', [rect(0, 0, 200, 200)]);
  const ring = ST.metrics.buildRecord('O', [rect(0, 0, 200, 200), rect(50, 50, 150, 150)]);
  assert.ok(ring.weight < block.weight, `ring ${ring.weight} < block ${block.weight}`);
  // older records without the field get it computed and cached
  const old = { char: 'I', contours: thin.contours };
  assert.strictEqual(ST.metrics.weightOf(old), thin.weight);
  assert.strictEqual(old.weight, thin.weight);
});

test('buildFontGlyphs: weight target picks the nearest variant per slot; lone variants repeat', () => {
  const thin = ST.metrics.buildRecord('I', [rect(0, 0, 20, 200)]);
  const mid = ST.metrics.buildRecord('I', [rect(0, 0, 45, 200)]);
  const fat = ST.metrics.buildRecord('I', [rect(0, 0, 80, 200)]);
  const only = ST.metrics.buildRecord('L', [rect(0, 0, 30, 200)]);
  const lib = { I: { variants: [fat, thin, mid], active: 0 }, L: { variants: [only], active: 0 } };
  const base = ST.metrics.buildFontGlyphs(lib, {});
  assert.strictEqual(base.get(73).id, fat.id, 'active pick without weight mode');
  assert.strictEqual(base.get(73).char, 'I');
  const light = ST.metrics.buildFontGlyphs(lib, { weight: 0 });
  assert.strictEqual(light.get(73).id, thin.id, 'lightest at 0');
  assert.strictEqual(light.get(76).id, only.id, 'lone variant repeats at every weight');
  const middle = ST.metrics.buildFontGlyphs(lib, { weight: 0.45 });
  assert.strictEqual(middle.get(73).id, mid.id, 'middle weight');
  const heavy = ST.metrics.buildFontGlyphs(lib, { weight: 1 });
  assert.strictEqual(heavy.get(73).id, fat.id, 'heaviest at 1');
  assert.strictEqual(heavy.get(76).id, only.id);
});

test('ligature keys: unmapped glyphs plus a GSUB liga/rlig lookup that shapers can apply', () => {
  const a = ST.metrics.buildRecord('a', [rect(0, 0, 60, 100)]);
  const r = ST.metrics.buildRecord('r', [rect(0, 0, 40, 100)]);
  const ar = ST.metrics.buildRecord('ar', [rect(0, 0, 160, 100)]);
  const bl = ST.metrics.buildRecord('bl', [rect(0, 0, 150, 150)]); // b and l never drawn on their own
  const lib = {
    a: { variants: [a], active: 0 }, r: { variants: [r], active: 0 },
    ar: { variants: [ar], active: 0 }, bl: { variants: [bl], active: 0 },
  };
  const map = ST.metrics.buildFontGlyphs(lib, {});
  assert.deepStrictEqual(Array.from(ST.metrics.ligatureKeys(map)), ['ar', 'bl']);
  assert.strictEqual(map.get(97).id, a.id);
  assert.strictEqual(map.liga.get('ar').id, ar.id);
  assert.strictEqual(map.liga.get('ar').char, 'ar');
  const keys = ST.metrics.ligatureKeys(map);
  assert.strictEqual(ST.metrics.ligatureAt(['x', 'a', 'r'], 1, keys), 'ar');
  assert.strictEqual(ST.metrics.ligatureAt(['a', 'r'], 1, keys), null);
  assert.strictEqual(ST.metrics.ligatureAt(['a', 'x'], 0, keys), null);

  const bytes = ST.ttf.compile({ fontName: 'Liga', glyphMap: map });
  const font = parse(Buffer.from(bytes));
  assert.deepStrictEqual(font.errors, [], font.errors.join('; '));
  assert.ok(font.tables.GSUB, 'GSUB present');
  assert.deepStrictEqual(font.gsubScripts, ['DFLT', 'latn']);
  assert.deepStrictEqual(font.gsubFeatures, ['liga', 'rlig']);
  const gA = font.cmap.get(97), gR = font.cmap.get(114), gB = font.cmap.get(98), gL = font.cmap.get(108);
  assert.ok(gA && gR && gB && gL, 'every member letter is mapped (undrawn ones as boxes)');
  assert.strictEqual(font.glyphs[gB].contours, 2, 'an undrawn member renders as the .notdef box');
  const ligAR = font.ligatures.find((l) => l.comps.length === 2 && l.comps[0] === gA && l.comps[1] === gR);
  assert.ok(ligAR, 'a + r → ligature rule');
  assert.strictEqual(font.hmtx[ligAR.gid].advance, ST.metrics.finalizeVariant(ar).advance, 'ligature glyph carries its own advance');
  const ligBL = font.ligatures.find((l) => l.comps.length === 2 && l.comps[0] === gB && l.comps[1] === gL);
  assert.ok(ligBL, 'b + l → ligature rule through the box members');
  for (const [, gid] of font.cmap) assert.notStrictEqual(gid, ligAR.gid, 'no codepoint maps to the ligature glyph');
  assert.strictEqual(font.numGlyphs, 1 + 2 + 2 + 2 + 1, '.notdef, a, r, two boxes, two ligatures, space');

  const outDir = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'liga-font.ttf'), Buffer.from(bytes));
});

test('a font without ligatures has no GSUB and the same glyph order as before', () => {
  const a = ST.metrics.buildRecord('a', [rect(0, 0, 60, 100)]);
  const map = ST.metrics.buildFontGlyphs({ a: { variants: [a], active: 0 } }, {});
  const font = parse(Buffer.from(ST.ttf.compile({ fontName: 'Plain', glyphMap: map })));
  assert.deepStrictEqual(font.errors, []);
  assert.ok(!font.tables.GSUB);
  assert.strictEqual(font.numGlyphs, 3);
});
