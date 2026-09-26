'use strict';
// Seeing past what hides the letter (complete.js) and splitting fused
// same-colored letters stroke by stroke (extract.strokeChains/growLetter).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadST } = require('./loader');

const ST = loadST(['util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'extract.js', 'complete.js']);
const C = ST.complete, R = ST.raster;
const { WALL, PAINT, HIDDEN } = C;

const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
};
// a mask of round-capped strokes [[ax, ay, bx, by], ...] of half-width r
function strokes(w, h, list, r) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (const s of list) if (segDist(x, y, ...s) <= r) { m[y * w + x] = 1; break; }
  }
  return m;
}
// classes: paint where the mask is, hidden inside the rects, wall elsewhere
function classes(w, h, paint, hiddenRects) {
  const cls = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (paint[i]) cls[i] = PAINT;
    else if (hiddenRects.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)) cls[i] = HIDDEN;
    else cls[i] = WALL;
  }
  return cls;
}
const cut = (m, w, rects) => { const o = new Uint8Array(m); for (let i = 0; i < o.length; i++) { const x = i % w, y = (i / w) | 0; if (rects.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)) o[i] = 0; } return o; };

test('classify: other colors are hidden, the paint\'s own halo is not', () => {
  const w = 120, h = 60;
  const data = new Uint8ClampedArray(w * h * 4);
  const paint = new Uint8Array(w * h), wall = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, p = i * 4;
    let c = [200, 200, 196]; // wall
    if (x >= 20 && x < 40) { c = [190, 30, 40]; paint[i] = 1; } // red paint
    else if (x >= 40 && x < 46) c = [196, 120, 122]; // its blend/halo: on the wall→red axis
    else if (x >= 70 && x < 100) c = [40, 150, 60]; // a green object
    else wall[i] = 1;
    data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = 255;
  }
  const cls = C.classify(data, w, h, { bg: { r: 200, g: 200, b: 196 }, seed: { r: 190, g: 30, b: 40 }, paint, wall, sw: 20 });
  assert.strictEqual(cls[30 * w + 30], PAINT);
  assert.strictEqual(cls[30 * w + 43], C.FAMILY, 'the blend beside the paint is its own');
  assert.strictEqual(cls[30 * w + 85], HIDDEN, 'a green object hides what is behind it');
  assert.strictEqual(cls[30 * w + 60], WALL);
});

test('probe: an end at an occluder is cut short, a free end is not, the frame hides too', () => {
  const w = 400, h = 200;
  const bar = strokes(w, h, [[40, 100, 200, 100]], 14);
  const at = C.sampler(classes(w, h, bar, [[214, 0, 260, h]]), w, h);
  const ends = C.strokeEnds(bar, w, h, null).map((e) => ({ e, st: C.probe(e, at) }));
  const right = ends.find((q) => q.e.dx > 0.9), left = ends.find((q) => q.e.dx < -0.9);
  assert.ok(right && left, 'both ends found');
  assert.strictEqual(right.st, 'hidden', 'the end facing the occluder is cut short');
  assert.strictEqual(left.st, 'wall', 'the end in the open is a real end');
  const edge = strokes(w, h, [[200, 100, 420, 100]], 14);
  const eEnds = C.strokeEnds(edge, w, h, null);
  const atE = C.sampler(classes(w, h, edge, []), w, h);
  const toFrame = eEnds.find((e) => e.dx > 0.9);
  assert.ok(toFrame, 'the end at the frame edge is found');
  assert.strictEqual(C.probe(toFrame, atE), 'frame');
});

test('complete: a bar broken by an occluder is joined; one broken by bare wall is not', () => {
  const w = 400, h = 200;
  const bar = cut(strokes(w, h, [[40, 100, 360, 100]], 14), w, [[180, 0, 240, h]]);
  const hid = C.complete(bar, w, h, { at: C.sampler(classes(w, h, bar, [[180, 0, 240, h]]), w, h), pad: 0, minArea: 50 });
  assert.strictEqual(hid.pairs.length, 1, 'the two pieces are paired across the occluder');
  assert.strictEqual(R.components(hid.mask, hid.W2, hid.H2).sizes.length - 1, 1, 'one bar again');
  assert.strictEqual(hid.mask[100 * hid.W2 + 210], 1, 'the hidden stretch is filled in');
  const open = C.complete(bar, w, h, { at: C.sampler(classes(w, h, bar, []), w, h), pad: 0, minArea: 50 });
  assert.strictEqual(open.pairs.length, 0, 'never bridged across visible wall');
});

test('complete: a U cut off by the frame is closed past it; parallel legs (an H) are not', () => {
  const w = 400, h = 300;
  // legs curving toward each other at the bottom edge
  const u = strokes(w, h, [[120, 40, 120, 220], [120, 220, 150, 290], [150, 290, 160, 330], [280, 40, 280, 220], [280, 220, 250, 290], [250, 290, 240, 330]], 16);
  const done = C.complete(u, w, h, { at: C.sampler(classes(w, h, u, []), w, h), minArea: 50 });
  assert.strictEqual(done.pairs.length, 1, 'the legs are joined');
  assert.strictEqual(done.pairs[0].kind, 'frame');
  let below = 0;
  for (let y = done.P + h; y < done.H2; y++) for (let x = 0; x < done.W2; x++) below += done.mask[y * done.W2 + x];
  assert.ok(below > 500, `the bottom is drawn past the frame (${below} px)`);
  assert.strictEqual(R.components(done.mask, done.W2, done.H2).sizes.length - 1, 1, 'one letter');
  const hh = strokes(w, h, [[120, 40, 120, 330], [280, 40, 280, 330], [120, 150, 280, 150]], 16);
  const done2 = C.complete(hh, w, h, { at: C.sampler(classes(w, h, hh, []), w, h), minArea: 50 });
  assert.strictEqual(done2.pairs.length, 0, 'parallel legs stay apart');
  assert.ok(done2.extensions.length === 2 && done2.extensions.every((e) => e.kind === 'frame'), 'each leg gets a cap past the frame');
});

test('restoreWidth: a stroke bitten along its side by an occluder gets its width back', () => {
  const w = 300, h = 200;
  const full = strokes(w, h, [[30, 100, 270, 100]], 16);
  const bitten = cut(full, w, [[110, 60, 190, 97]]); // a sticker over the top half
  const at = C.sampler(classes(w, h, bitten, [[110, 60, 190, 97]]), w, h);
  const add = C.restoreWidth(bitten, w, h, at, { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }, 16);
  assert.ok(add, 'something restored');
  let back = 0, stray = 0;
  for (let i = 0; i < add.length; i++) if (add[i]) { if (full[i]) back++; else stray++; }
  assert.ok(back > 0.7 * (80 * 13), `the hidden half is back (${back} px)`);
  assert.ok(stray < 0.25 * back, `hardly anything beyond the stroke (${stray} px of ${back})`);
});

test('fillHiddenHoles and absorbOutline: stickers fill, counters stay, a throw-up outline joins', () => {
  const w = 200, h = 200;
  // a ring letter with a hidden (other-colored) patch inside the stroke
  const ring = new Uint8Array(w * h), cls = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 100, y - 100), i = y * w + x;
    if (d >= 40 && d <= 70) ring[i] = 1;
    cls[i] = ring[i] ? PAINT : d > 70 && d <= 78 ? HIDDEN : WALL; // an outline round the outside
  }
  for (let y = 45; y < 60; y++) for (let x = 95; x < 105; x++) { ring[y * w + x] = 0; cls[y * w + x] = HIDDEN; }
  const at = C.sampler(cls, w, h);
  const filled = C.fillHiddenHoles(ring, w, h, at, 0, 0);
  assert.strictEqual(filled[50 * w + 100], 1, 'the patch inside the stroke is filled');
  assert.strictEqual(filled[100 * w + 100], 0, 'the counter stays open');
  const ol = C.absorbOutline(filled, w, h, cls, w, h, 0, 0);
  assert.strictEqual(ol.mask[100 * w + 25], 1, 'the outline hugging the letter is part of it');
  assert.strictEqual(ol.mask[100 * w + 100], 0, 'the counter is still a counter');
});

test('growLetter: a T whose bar crosses an O is split off it stroke by stroke', () => {
  const w = 700, h = 600;
  const T = strokes(w, h, [[60, 100, 400, 100], [200, 100, 200, 520]], 20);
  const m = new Uint8Array(T);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - 460) / 130, dy = (y - 200) / 170, rr = Math.hypot(dx, dy), gr = Math.hypot(dx / 130, dy / 170);
    if (Math.abs(rr - 1) / gr <= 20) m[y * w + x] = 1;
  }
  const sc = ST.extract.strokeChains(m, w, h);
  assert.ok(sc && sc.n >= 3, `stem, bar and ring are separate strokes (${sc && sc.n})`);
  // score: agreement with the T (what a template match for "T" would reward)
  const score = (s) => { let i = 0, u = 0; for (let k = 0; k < s.length; k++) { if (s[k] && T[k]) i++; if (s[k] || T[k]) u++; } return i / u; };
  const got = ST.extract.growLetter(m, w, h, 200, 400, score);
  assert.ok(got, 'grown');
  assert.ok(score(got.mask) > 0.9, `the T comes out (IoU ${score(got.mask).toFixed(3)})`);
  assert.strictEqual(got.mask[100 * w + 330], 1, 'the bar is whole where it crosses the ring');
});
