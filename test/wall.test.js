'use strict';
// The wall a letter is on: how far its own color wanders, and the light
// across it (extract.wallTolerance, extract.flatField).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadST } = require('./loader');

const ST = loadST(['util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'extract.js', 'complete.js']);
const R = ST.raster;

const WALL = [142, 105, 66], WHITE = [232, 233, 233], BLACK = [26, 22, 24];
// a brown wall (optionally lit brighter at the top), black strokes running
// off its bottom and left edges, a white stroke across the middle
function photo(w, h, light) {
  const data = new Uint8ClampedArray(w * h * 4);
  const rnd = ST.rng(3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      let c = WALL;
      if ((y > h - 70 && (x % 90) < 40) || (x < 50 && (y % 80) < 35)) c = BLACK;
      if (Math.abs(y - h / 2) < 14 && x > 80 && x < w - 80) c = WHITE;
      const k = light ? 1.25 - 0.5 * (y / h) : 1;
      const n = (rnd() - 0.5) * 16;
      data[p] = c[0] * k + n; data[p + 1] = c[1] * k + n; data[p + 2] = c[2] * k + n; data[p + 3] = 255;
    }
  }
  return data;
}

test('wallTolerance: letters running off the frame into the border ring do not widen it to their paint', () => {
  const w = 400, h = 500;
  const data = photo(w, h, false);
  const bg = ST.extract.backgroundColor(data, w, h);
  const tol = ST.extract.wallTolerance(data, w, h, bg);
  const black = R.colorDist(BLACK[0], BLACK[1], BLACK[2], bg.r, bg.g, bg.b);
  assert.ok(tol < 80, `the wall's grain, not its paint (${tol.toFixed(0)})`);
  assert.ok(tol < 0.5 * black, `black paint is well outside the wall (${tol.toFixed(0)} vs ${black.toFixed(0)})`);
});

test('flatField: a wall lit brighter at one end reads as one wall; evenly lit, nothing changes', () => {
  const w = 400, h = 500;
  assert.strictEqual(ST.extract.flatField(photo(w, h, false), w, h), null, 'even light: left alone');
  const data = photo(w, h, true);
  const f = ST.extract.flatField(data, w, h);
  assert.ok(f, 'uneven light is measured');
  const mean = (d, x0, y0, x1, y1) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * w + x) * 4; r += d[p]; g += d[p + 1]; b += d[p + 2]; n++; }
    return [r / n, g / n, b / n];
  };
  const top = mean(f.data, 150, 20, 250, 60), bottom = mean(f.data, 150, 360, 250, 400);
  const before = R.colorDist(...mean(data, 150, 20, 250, 60), ...mean(data, 150, 360, 250, 400));
  const after = R.colorDist(...top, ...bottom);
  assert.ok(before > 60 && after < 20, `the wall at top and bottom: ${before.toFixed(0)} apart before, ${after.toFixed(0)} after`);
  // the paint keeps its contrast with the wall
  const white = mean(f.data, 150, h / 2 - 8, 250, h / 2 + 8);
  assert.ok(R.colorDist(...white, ...top) > 250, 'the white stroke still stands out');
  // and a color picked off the photo is evened the same way
  const kt = f.gain(200, 30), kb = f.gain(200, 470);
  assert.ok(kt[0] < 0.8 * kb[0] && kt[2] < 0.8 * kb[2], `the bright end is toned down against the dark (${kt[0].toFixed(2)} vs ${kb[0].toFixed(2)})`);
});
