'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadST } = require('./loader');

const ST = loadST(['util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'extract.js']);

// A fake canvas: enough of the 2D API for extract.seeded.
function fakeCanvas(w, h, paint) {
  const data = new Uint8ClampedArray(w * h * 4);
  const rnd = ST.rng(7);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const c = paint(x, y);
      // textured gray wall vs. red paint, with per-pixel noise on both
      const n = (rnd() - 0.5) * 30;
      if (c) { data[p] = 190 + n; data[p + 1] = 40 + n; data[p + 2] = 50 + n; }
      else { data[p] = 175 + n; data[p + 1] = 172 + n; data[p + 2] = 165 + n; }
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, getContext: () => ({ getImageData: () => ({ data }) }) };
}

test('seeded: click grows exactly the painted letter, auto-calibrated', () => {
  const w = 420, h = 420;
  // a fat "L": vertical bar + foot, plus a separate red blob far away
  const cnv = fakeCanvas(w, h, (x, y) =>
    (x >= 90 && x < 150 && y >= 60 && y < 340) ||
    (x >= 90 && x < 300 && y >= 290 && y < 340) ||
    ((x - 370) ** 2 + (y - 70) ** 2 < 25 ** 2));
  const res = ST.extract.seeded(cnv, 120, 200, {});
  assert.ok(res, 'extraction succeeded');
  assert.ok(res.tolerance >= 26 && res.tolerance <= 100, `tolerance auto-picked (${res.tolerance})`);
  const cand = res.candidates[0];
  // region covers the L but not the far blob
  assert.ok(cand.crop.x <= 92 && cand.crop.x + cand.crop.w >= 298, 'crop spans the L horizontally');
  assert.ok(cand.crop.y <= 62 && cand.crop.y + cand.crop.h >= 338, 'crop spans the L vertically');
  assert.ok(cand.crop.x + cand.crop.w < 340, 'the unrelated blob is not part of the region');
  assert.ok(cand.paths.length >= 1, 'traced');
  const bb = ST.trace.boundsOf(cand.paths);
  assert.ok(Math.abs(bb.w - 210) < 14 && Math.abs(bb.h - 280) < 14, `trace bbox ${bb.w.toFixed(0)}×${bb.h.toFixed(0)} ≈ 210×280`);
});

test('seeded: click on the wall finds nothing paint-like', () => {
  const w = 200, h = 200;
  const cnv = fakeCanvas(w, h, (x, y) => x >= 80 && x < 120 && y >= 40 && y < 160);
  // clicking the wall: region grows to the whole wall → rejected by maxFrac
  const res = ST.extract.seeded(cnv, 20, 20, {});
  assert.ok(!res || res.candidates[0].crop.w < 60, 'wall click does not produce a wall-sized letterform');
});

test('separateTouching: two bars joined by a thin bridge come apart', () => {
  const w = 300, h = 120;
  const m = new Uint8Array(w * h);
  for (let y = 20; y < 100; y++) {
    for (let x = 20; x < 120; x++) m[y * w + x] = 1;   // left block
    for (let x = 180; x < 280; x++) m[y * w + x] = 1;  // right block
  }
  for (let y = 55; y < 65; y++) for (let x = 120; x < 180; x++) m[y * w + x] = 1; // thin bridge
  const sep = ST.extract.separateTouching(m, w, h, 60, 60);
  assert.ok(sep, 'separation produced a piece');
  assert.ok(sep[60 * w + 60], 'clicked block kept');
  assert.ok(!sep[60 * w + 230], 'neighbor across the bridge dropped');
  const kept = ST.raster.count(sep);
  assert.ok(kept > 100 * 80 * 0.9, `stroke width reconstructed (${kept} px of ~8000)`);
});

test('floodFrom + reconstruct primitives', () => {
  const w = 10, h = 10;
  const m = new Uint8Array(w * h);
  for (let x = 0; x < 10; x++) { m[3 * w + x] = 1; m[7 * w + x] = 1; }
  const f = ST.raster.floodFrom(w, h, 4, 3, (i) => m[i] === 1);
  assert.strictEqual(f.count, 10, 'flood stays on its row');
  const marker = new Uint8Array(w * h); marker[3 * w + 4] = 1;
  const rec = ST.raster.reconstruct(marker, m, w, h, 20);
  assert.strictEqual(ST.raster.count(rec), 10, 'reconstruct refills the row, not the other row');
});
