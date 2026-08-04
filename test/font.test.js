'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadST } = require('./loader');
const { parse } = require('./ttfparse');

const ST = loadST();

const P = (x, y) => ({ x, y });
const line = (a, b) => [a, P(a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3), P(a.x + 2 * (b.x - a.x) / 3, a.y + 2 * (b.y - a.y) / 3), b];

function rectContour(x0, y0, x1, y1) {
  return { cubics: [
    line(P(x0, y0), P(x1, y0)),
    line(P(x1, y0), P(x1, y1)),
    line(P(x1, y1), P(x0, y1)),
    line(P(x0, y1), P(x0, y0)),
  ] };
}

function circleContour(cx, cy, r) {
  // 4 cubic arcs, k = 0.5523
  const k = 0.5522847 * r;
  return { cubics: [
    [P(cx + r, cy), P(cx + r, cy + k), P(cx + k, cy + r), P(cx, cy + r)],
    [P(cx, cy + r), P(cx - k, cy + r), P(cx - r, cy + k), P(cx - r, cy)],
    [P(cx - r, cy), P(cx - r, cy - k), P(cx - k, cy - r), P(cx, cy - r)],
    [P(cx, cy - r), P(cx + k, cy - r), P(cx + r, cy - k), P(cx + r, cy)],
  ] };
}

function buildMap() {
  const map = new Map();
  // 'A' → square with square counter (tests winding + holes)
  map.set(65, {
    contours: [rectContour(0, 0, 500, 700), rectContour(120, 150, 380, 550)],
    advance: 640, lsb: 70,
  });
  // 'B' → circle (tests curves)
  map.set(66, { contours: [circleContour(250, 350, 250)], advance: 650, lsb: 75 });
  // space
  map.set(32, { contours: [], advance: 340, lsb: 0 });
  return map;
}

test('ttf.compile → structurally valid font', () => {
  const bytes = ST.ttf.compile({ fontName: 'Sanstyle Test', glyphMap: buildMap() });
  assert.ok(bytes.length > 500, `font size ${bytes.length}`);
  const font = parse(Buffer.from(bytes));
  assert.deepStrictEqual(font.errors, [], font.errors.join('; '));

  for (const t of ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']) {
    assert.ok(font.tables[t], `table ${t} present`);
  }
  assert.strictEqual(font.unitsPerEm, 1000);
  assert.strictEqual(font.numGlyphs, 4); // .notdef + A + B + space

  // cmap: A→some gid with outline, space→empty glyph
  const gidA = font.cmap.get(65), gidB = font.cmap.get(66), gidSp = font.cmap.get(32);
  assert.ok(gidA > 0 && gidB > 0 && gidSp > 0);
  assert.ok(font.glyphs[gidSp].empty, 'space has no outline');
  const gA = font.glyphs[gidA];
  assert.strictEqual(gA.contours, 2, 'A has outer + counter');
  assert.strictEqual(gA.xMin, 70, 'xMin aligned to lsb');
  assert.strictEqual(font.hmtx[gidA].advance, 640);
  assert.strictEqual(font.hmtx[gidA].lsb, 70);
  assert.ok(gA.yMax === 700 && gA.yMin === 0);

  const gB = font.glyphs[gidB];
  assert.strictEqual(gB.contours, 1);
  assert.ok(gB.points.some((p) => !p.on), 'curve glyph has off-curve points');
  assert.ok(Math.abs(gB.yMax - 600) <= 2 && Math.abs(gB.yMin - 100) <= 2, `circle bbox ${gB.yMin}..${gB.yMax}`);

  // winding: outer contour of A should be clockwise (negative shoelace, y-up)
  const outerPts = gA.points.slice(0, gA.endPts[0] + 1);
  let area = 0;
  for (let i = 0; i < outerPts.length; i++) {
    const a = outerPts[i], b = outerPts[(i + 1) % outerPts.length];
    area += a.x * b.y - b.x * a.y;
  }
  const innerPts = gA.points.slice(gA.endPts[0] + 1, gA.endPts[1] + 1);
  let area2 = 0;
  for (let i = 0; i < innerPts.length; i++) {
    const a = innerPts[i], b = innerPts[(i + 1) % innerPts.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  assert.ok(area < 0, 'outer clockwise');
  assert.ok(area2 > 0, 'counter counter-clockwise');

  // stash for the fontTools cross-check
  const outDir = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'unit-test-font.ttf'), Buffer.from(bytes));
});

test('ttf.compile: mirror-case shared outlines dedupe into one glyph', () => {
  const ST2 = loadST();
  const rec = ST2.metrics.buildRecord('n', [rectContour(0, 0, 80, 80)]);
  const map = ST2.metrics.buildFontGlyphs({ n: { variants: [rec], active: 0 } }, { mirrorCase: true });
  const bytes = ST2.ttf.compile({ fontName: 'X', glyphMap: map });
  const font = parse(Buffer.from(bytes));
  assert.deepStrictEqual(font.errors, []);
  // .notdef + n outline + space = 3 glyphs; N maps to same gid as n
  assert.strictEqual(font.numGlyphs, 3);
  assert.strictEqual(font.cmap.get(110), font.cmap.get(78));
});

test('full pipeline: mask → trace → fit → compile → parse', () => {
  // Rasterize a chunky "A": two diagonal strokes + crossbar, with counter.
  const w = 160, h = 200;
  const mask = new Uint8Array(w * h);
  const inTri = (px, py, a, b, c) => {
    const s1 = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    const s2 = (c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x);
    const s3 = (a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  // filled triangle minus inner triangle = "A" without bar; then add bar
  const A1 = { x: 80, y: 10 }, A2 = { x: 10, y: 190 }, A3 = { x: 150, y: 190 };
  const B1 = { x: 80, y: 62 }, B2 = { x: 48, y: 150 }, B3 = { x: 112, y: 150 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inTri(x + 0.5, y + 0.5, A1, A2, A3) && !inTri(x + 0.5, y + 0.5, B1, B2, B3)) {
        mask[y * w + x] = 1;
      }
    }
  }
  // crossbar over the counter
  for (let y = 150; y < 170; y++) for (let x = 36; x < 124; x++) {
    if (inTri(x + 0.5, y + 0.5, A1, A2, A3)) mask[y * w + x] = 1;
  }

  const paths = ST.trace.vectorize(mask, w, h, {});
  assert.ok(paths.length >= 2, `A should have outer + counter, got ${paths.length}`);
  const rec = ST.metrics.buildRecord('A', paths);
  assert.ok(rec, 'record built');
  assert.ok(rec.osTop > 0, 'pointed apex gets top overshoot');
  const map = ST.metrics.buildFontGlyphs({ A: { variants: [rec], active: 0 } }, {});
  const bytes = ST.ttf.compile({ fontName: 'Pipeline', glyphMap: map });
  const font = parse(Buffer.from(bytes));
  assert.deepStrictEqual(font.errors, [], font.errors.join('; '));
  const gid = font.cmap.get(65);
  const gl = font.glyphs[gid];
  assert.ok(gl.contours >= 2, 'counter survived to the font');
  assert.ok(gl.yMax >= 700 && gl.yMax <= 725, `apex with overshoot: ${gl.yMax}`);
  assert.ok(Math.abs(gl.yMin) <= 6, `baseline: ${gl.yMin}`);
  assert.strictEqual(font.hmtx[gid].lsb, gl.xMin);

  const outDir = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'pipeline-font.ttf'), Buffer.from(bytes));
});
