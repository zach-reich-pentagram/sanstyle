'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadST } = require('./loader');

const ST = loadST();

// ---------- geometry ----------
test('rdp keeps corners, drops noise', () => {
  const pts = [];
  for (let i = 0; i <= 50; i++) pts.push({ x: i, y: (i % 2) * 0.2 });          // noisy flat
  for (let i = 1; i <= 50; i++) pts.push({ x: 50, y: i + (i % 2) * 0.2 });     // noisy vertical
  const out = ST.geom.rdp(pts, 0.6);
  assert.ok(out.length <= 5, `expected <=5 points, got ${out.length}`);
  const corner = out.find((p) => Math.abs(p.x - 50) < 1 && Math.abs(p.y) < 1);
  assert.ok(corner, 'corner at (50,0) preserved');
});

test('homography round-trips the 4 defining points and interior', () => {
  const src = [{ x: 10, y: 12 }, { x: 400, y: 40 }, { x: 380, y: 300 }, { x: 30, y: 280 }];
  const dst = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }];
  const h = ST.geom.homography(src, dst);
  assert.ok(h, 'solvable');
  for (let i = 0; i < 4; i++) {
    const p = ST.geom.applyH(h, src[i].x, src[i].y);
    assert.ok(Math.hypot(p.x - dst[i].x, p.y - dst[i].y) < 1e-6, `corner ${i}`);
  }
});

test('signedArea orientation', () => {
  const ccw = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.ok(ST.geom.signedArea(ccw) > 0);
  assert.ok(ST.geom.signedArea(ccw.slice().reverse()) < 0);
});

// ---------- fitcurves ----------
test('fitCubics reproduces a quarter arc within tolerance', () => {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = (i / 40) * (Math.PI / 2);
    pts.push({ x: 100 * Math.cos(t), y: 100 * Math.sin(t) });
  }
  const cubics = ST.fitCubics(pts, null, null, 0.8);
  assert.ok(cubics.length >= 1 && cubics.length <= 4, `got ${cubics.length} segments`);
  for (const p of pts) {
    let best = Infinity;
    for (const cu of cubics) {
      for (let s = 0; s <= 200; s++) {
        const q = ST.geom.cubicAt(cu, s / 200);
        best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
      }
    }
    assert.ok(best < 2.0, `point off by ${best}`);
  }
});

// ---------- raster ----------
test('otsu splits a bimodal image; fillPoly/despeckle behave', () => {
  const w = 60, h = 60;
  const luma = new Uint8Array(w * h).fill(200);
  for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) luma[y * w + x] = 30;
  const t = ST.raster.otsu(luma, null);
  assert.ok(t > 30 && t < 200, `otsu ${t}`);
  const mask = ST.raster.maskFromLuma(luma, null, t, false);
  assert.strictEqual(ST.raster.count(mask), 400);

  // add a speck; despeckle by fraction removes it
  mask[5] = 1;
  const clean = ST.raster.despeckle(mask, w, h, 0.05, 4);
  assert.strictEqual(ST.raster.count(clean), 400);

  const poly = ST.raster.fillPoly(10, 10, [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }, { x: 1, y: 9 }]);
  const c = ST.raster.count(poly);
  assert.ok(c >= 60 && c <= 68, `poly fill count ${c}`);
});

// ---------- trace ----------
function diskMask(w, h, cx, cy, r) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m[y * w + x] = 1;
  }
  return m;
}

test('trace: rectangle → one 4-corner loop', () => {
  const w = 40, h = 30;
  const m = new Uint8Array(w * h);
  for (let y = 5; y < 25; y++) for (let x = 5; x < 35; x++) m[y * w + x] = 1;
  const loops = ST.trace.maskToLoops(m, w, h);
  assert.strictEqual(loops.length, 1);
  assert.strictEqual(loops[0].length, 4, 'collinear collapse leaves 4 vertices');
  assert.ok(ST.geom.signedArea(loops[0]) > 0, 'outer loop positive area');
});

test('trace: ring → outer + hole with opposite orientation', () => {
  const w = 80, h = 80;
  const m = diskMask(w, h, 40, 40, 30);
  const hole = diskMask(w, h, 40, 40, 14);
  for (let i = 0; i < m.length; i++) if (hole[i]) m[i] = 0;
  const loops = ST.trace.maskToLoops(m, w, h);
  assert.strictEqual(loops.length, 2);
  const areas = loops.map((l) => ST.geom.signedArea(l)).sort((a, b) => a - b);
  assert.ok(areas[0] < 0 && areas[1] > 0, `areas ${areas}`);
  assert.ok(Math.abs(areas[1] - Math.PI * 900) / (Math.PI * 900) < 0.06, 'outer ~ πr²');

  const paths = ST.trace.vectorize(m, w, h, {});
  assert.strictEqual(paths.length, 2);
  const bb = ST.trace.boundsOf(paths);
  assert.ok(Math.abs(bb.w - 60) < 3 && Math.abs(bb.h - 60) < 3, `bounds ${bb.w}x${bb.h}`);
});

test('trace: vectorized circle is smooth (few segments, low error)', () => {
  const w = 120, h = 120;
  const m = diskMask(w, h, 60, 60, 45);
  const paths = ST.trace.vectorize(m, w, h, {});
  assert.strictEqual(paths.length, 1);
  const nSegs = paths[0].cubics.length;
  assert.ok(nSegs <= 14, `circle should fit with few cubics, got ${nSegs}`);
  // every sampled point should sit near radius 45
  for (const cu of paths[0].cubics) {
    for (let s = 0; s <= 16; s++) {
      const p = ST.geom.cubicAt(cu, s / 16);
      const r = Math.hypot(p.x - 60, p.y - 60);
      assert.ok(Math.abs(r - 45) < 2.5, `radius ${r}`);
    }
  }
});

test('trace: diagonally touching blobs stay separate', () => {
  const w = 20, h = 20;
  const m = new Uint8Array(w * h);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) m[y * w + x] = 1;
  for (let y = 8; y < 14; y++) for (let x = 8; x < 14; x++) m[y * w + x] = 1;
  const loops = ST.trace.maskToLoops(m, w, h);
  assert.strictEqual(loops.length, 2);
});

// ---------- fitting ----------
function rectPath(x0, y0, x1, y1) {
  // a rectangle as 4 straight cubics, pixel space (y down)
  const P = (x, y) => ({ x, y });
  const line = (a, b) => [a, ST.geom.lerpPt ? null : P(a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3), P(a.x + 2 * (b.x - a.x) / 3, a.y + 2 * (b.y - a.y) / 3), b];
  const c = [
    line(P(x0, y0), P(x1, y0)),
    line(P(x1, y0), P(x1, y1)),
    line(P(x1, y1), P(x0, y1)),
    line(P(x0, y1), P(x0, y0)),
  ];
  return { cubics: c };
}

test('fitGlyph: flat-topped cap fits exactly 0..700, no overshoot', () => {
  const fitted = ST.metrics.fitGlyph([rectPath(0, 0, 60, 100)], 'H');
  assert.ok(fitted);
  assert.strictEqual(fitted.osTop, 0);
  assert.strictEqual(fitted.osBot, 0);
  assert.ok(Math.abs(fitted.bbox.y1 - 700) < 1, `top ${fitted.bbox.y1}`);
  assert.ok(Math.abs(fitted.bbox.y0 - 0) < 1, `bottom ${fitted.bbox.y0}`);
});

test('fitGlyph: round cap overshoots above cap height and below baseline', () => {
  const w = 120, h = 120;
  const m = diskMask(w, h, 60, 60, 50);
  const paths = ST.trace.vectorize(m, w, h, {});
  const fitted = ST.metrics.fitGlyph(paths, 'O');
  assert.ok(fitted.osTop >= 8, `osTop ${fitted.osTop}`);
  assert.ok(fitted.osBot >= 8, `osBot ${fitted.osBot}`);
  assert.ok(fitted.bbox.y1 > 700 && fitted.bbox.y1 <= 720, `top ${fitted.bbox.y1}`);
  assert.ok(fitted.bbox.y0 < 0 && fitted.bbox.y0 >= -20, `bottom ${fitted.bbox.y0}`);
});

test('fitGlyph: descender class drops below baseline', () => {
  const fitted = ST.metrics.fitGlyph([rectPath(0, 0, 60, 100)], 'p');
  assert.ok(Math.abs(fitted.bbox.y0 - ST.metrics.DESC) < 1);
  assert.ok(Math.abs(fitted.bbox.y1 - ST.metrics.XH) < 1);
});

test('spacing: solid stem gets wider bearings than open triangle', () => {
  const stem = ST.metrics.fitGlyph([rectPath(0, 0, 60, 100)], 'H');
  const sStem = ST.metrics.spacing(stem);
  // triangle: wide base, pointy top → left/right margins deep on average
  const P = (x, y) => ({ x, y });
  const line = (a, b) => [a, P(a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3), P(a.x + 2 * (b.x - a.x) / 3, a.y + 2 * (b.y - a.y) / 3), b];
  const triangle = { cubics: [
    line(P(50, 0), P(100, 100)),
    line(P(100, 100), P(0, 100)),
    line(P(0, 100), P(50, 0)),
  ] };
  const fTri = ST.metrics.fitGlyph([triangle], 'A');
  const sTri = ST.metrics.spacing(fTri);
  assert.ok(sTri.lsb < sStem.lsb, `A lsb ${sTri.lsb} should be < H lsb ${sStem.lsb}`);
  assert.ok(sTri.rsb < sStem.rsb, `A rsb ${sTri.rsb} should be < H rsb ${sStem.rsb}`);
  assert.ok(sStem.lsb >= 55 && sStem.lsb <= 100, `H lsb ${sStem.lsb} plausible`);
});

test('buildRecord + finalizeVariant + nudges', () => {
  const rec = ST.metrics.buildRecord('H', [rectPath(0, 0, 60, 100)]);
  assert.ok(rec && rec.char === 'H' && rec.advance > 0);
  const fin0 = ST.metrics.finalizeVariant(rec);
  rec.nudge = { scale: 10, dy: 20, dl: 5, dr: -5 };
  const fin1 = ST.metrics.finalizeVariant(rec);
  assert.ok(Math.abs(fin1.bbox.h - fin0.bbox.h * 1.1) < 2, 'scale nudge applied');
  assert.ok(Math.abs((fin1.bbox.y0 - 20) - fin0.bbox.y0 * 1.1) < 2, 'baseline nudge applied');
  assert.strictEqual(fin1.lsb, fin0.lsb + 5);
});

test('buildFontGlyphs: mirrorCase + always includes space', () => {
  const rec = ST.metrics.buildRecord('a', [rectPath(0, 0, 60, 60)]);
  const map = ST.metrics.buildFontGlyphs({ a: { variants: [rec], active: 0 } }, { mirrorCase: true });
  assert.ok(map.has(97) && map.has(65), 'a and A both mapped');
  assert.strictEqual(map.get(97), map.get(65), 'shared outline object');
  assert.ok(map.has(32), 'space present');
});
