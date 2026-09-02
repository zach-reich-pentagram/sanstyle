'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadST } = require('./loader');

const ST = loadST(['util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'auto.js']);

test('disk morphology at any radius: closing heals a crack, and is isotropic', () => {
  const w = 60, h = 30;
  const m = new Uint8Array(w * h);
  // two 12px-tall bars with an 8px gap (a crack across a stroke)
  for (let y = 6; y < 18; y++) {
    for (let x = 5; x < 25; x++) m[y * w + x] = 1;
    for (let x = 33; x < 55; x++) m[y * w + x] = 1;
  }
  const closed = ST.raster.close(m, w, h, 6); // r>3 → distance-transform disk
  assert.ok(closed[12 * w + 29], 'crack bridged by close(6)');
  const still = ST.raster.close(m, w, h, 2);  // r<=3 → exact small disk
  assert.ok(!still[12 * w + 29], 'close(2) must not bridge an 8px gap');
  // an opening of radius 8 keeps a 20px-wide diagonal stroke (a box would
  // read it as 14px wide and erase it)
  const W = 120, H = 120;
  const d = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (Math.abs(x - y) < 20 / Math.SQRT2 && x + y > 40 && x + y < 200) d[y * W + x] = 1;
  }
  const opened = ST.raster.open(d, W, H, 8);
  assert.ok(opened[60 * W + 60] && opened[80 * W + 80], 'diagonal stroke survives a disk opening');
});

test('fillHoles: small spray gaps close, big counters survive', () => {
  const w = 80, h = 80;
  const m = new Uint8Array(w * h);
  for (let y = 10; y < 70; y++) for (let x = 10; x < 70; x++) m[y * w + x] = 1;
  // big counter 24x24 (~17% of ink) and a tiny 3x3 gap
  for (let y = 28; y < 52; y++) for (let x = 28; x < 52; x++) m[y * w + x] = 0;
  for (let y = 15; y < 18; y++) for (let x = 60; x < 63; x++) m[y * w + x] = 0;

  const filled = ST.raster.fillHoles(m, w, h, 0.05);
  assert.ok(filled[16 * w + 61], 'tiny gap filled at 5%');
  assert.ok(!filled[40 * w + 40], 'counter kept at 5%');

  const nuked = ST.raster.fillHoles(m, w, h, 0.6);
  assert.ok(nuked[40 * w + 40], 'counter filled when maxFrac is cranked');
});

test('bridgeThrough: stroke reconnects across a blocked-out overlap', () => {
  const w = 100, h = 40;
  const A = new Uint8Array(w * h);
  const X = new Uint8Array(w * h);
  // horizontal stroke, fully crossing the image
  for (let y = 16; y < 24; y++) for (let x = 5; x < 95; x++) A[y * w + x] = 1;
  // intruding letter occupies a vertical band; user blocks it out
  for (let y = 0; y < h; y++) for (let x = 42; x < 58; x++) X[y * w + x] = 1;
  // the intruder also had paint above/below our stroke inside X
  for (let y = 2; y < 38; y++) for (let x = 44; x < 56; x++) A[y * w + x] = 1;

  const out = ST.raster.bridgeThrough(A, X, w, h, 12);
  assert.ok(out[20 * w + 50], 'stroke inferred through the blocked zone');
  assert.ok(!out[5 * w + 50], 'intruder paint above the stroke removed');
  assert.ok(!out[35 * w + 50], 'intruder paint below the stroke removed');

  const noBridge = ST.raster.bridgeThrough(A, X, w, h, 0);
  assert.ok(!noBridge[20 * w + 50], 'r=0 leaves the cut open');
});

test('estimateSkewAngle recovers a synthetic tilt', () => {
  const w = 240, h = 240;
  const gray = new Uint8Array(w * h).fill(230);
  // dark bars tilted by ~7°
  const rad = (7 * Math.PI) / 180;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const yr = (y - h / 2) * Math.cos(rad) - (x - w / 2) * Math.sin(rad);
      const band = ((yr % 40) + 40) % 40;
      if (band < 12) gray[y * w + x] = 25;
    }
  }
  const ang = ST.auto.estimateSkewAngle(gray, w, h);
  assert.ok(Math.abs(ang - 7) <= 2, `estimated ${ang}, expected ≈7`);

  const flat = new Uint8Array(w * h).fill(230);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y % 40 < 12) flat[y * w + x] = 25;
  }
  const ang0 = ST.auto.estimateSkewAngle(flat, w, h);
  assert.ok(Math.abs(ang0) <= 1, `flat image should read ~0°, got ${ang0}`);
});

test('autoScale smoothing: big noisy contour comes out with far fewer segments', () => {
  const w = 860, h = 860;
  const m = new Uint8Array(w * h);
  // disk r≈380 with a 6px high-frequency wobble — photo-texture stand-in
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - 430, dy = y - 430;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      if (r <= 380 + 6 * Math.sin(37 * th)) m[y * w + x] = 1;
    }
  }
  const smooth = ST.trace.vectorize(m, w, h, {});
  const rough = ST.trace.vectorize(m, w, h, { autoScale: false });
  assert.strictEqual(smooth.length, 1);
  assert.ok(smooth[0].cubics.length <= 30, `smooth trace has ${smooth[0].cubics.length} segments`);
  assert.ok(rough[0].cubics.length > smooth[0].cubics.length * 1.8,
    `autoScale reduces segments (${rough[0].cubics.length} → ${smooth[0].cubics.length})`);
  // the smoothed curve should hug the mean radius, not chase the wobble
  let maxDev = 0;
  for (const cu of smooth[0].cubics) {
    for (let s = 0; s <= 12; s++) {
      const p = ST.geom.cubicAt(cu, s / 12);
      maxDev = Math.max(maxDev, Math.abs(Math.hypot(p.x - 430, p.y - 430) - 380));
    }
  }
  assert.ok(maxDev < 9, `stays near the mean radius (max dev ${maxDev.toFixed(1)}px)`);
});

test('field blur + stroke width power the one-knob smoothing', () => {
  const w = 200, h = 120;
  // ribbon 20px tall → strokeWidth ≈ 2·area/perimeter ≈ 18-20
  const m = new Uint8Array(w * h);
  for (let y = 50; y < 70; y++) for (let x = 10; x < 190; x++) m[y * w + x] = 1;
  const sw = ST.raster.strokeWidth(m, w, h);
  assert.ok(sw > 16 && sw < 21, `ribbon stroke width ${sw.toFixed(1)}`);

  // blur flattens a salt-and-pepper field toward its mean
  const noisy = new Uint8Array(w * h);
  for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 2654435761 >>> 0) % 2 ? 255 : 0;
  const blurred = ST.raster.blur(noisy, w, h, 3);
  let dev = 0;
  for (let i = 0; i < blurred.length; i++) dev = Math.max(dev, Math.abs(blurred[i] - 127.5));
  assert.ok(dev < 80, `blurred checker deviates ${dev.toFixed(0)} from mean (raw: 127.5)`);

  // colorDistMap: zero at the seed color, large far away
  const data = new Uint8ClampedArray(4 * 2);
  data.set([200, 30, 40, 255, 20, 200, 60, 255]);
  const map = ST.raster.colorDistMap(data, 2, 1, [{ r: 200, g: 30, b: 40 }]);
  assert.ok(map[0] < 1 && map[1] > 200, `distances ${map[0].toFixed(1)}, ${map[1].toFixed(1)}`);
});

test('classifier grid + scoring separates a bar from a ring', () => {
  const w = 60, h = 60;
  const bar = new Uint8Array(w * h);
  for (let y = 5; y < 55; y++) for (let x = 26; x < 34; x++) bar[y * w + x] = 1;
  const ring = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 30, y - 30);
    if (d < 25 && d > 15) ring[y * w + x] = 1;
  }
  const gBar = ST.classify.gridFromMask(bar, w, h);
  const gRing = ST.classify.gridFromMask(ring, w, h);
  const gBar2 = ST.classify.gridFromMask(bar, w, h);
  assert.ok(ST.classify.gridIoU(gBar.grid, gBar2.grid) > 0.99, 'self IoU ≈ 1');
  assert.ok(ST.classify.gridIoU(gBar.grid, gRing.grid) < 0.4, 'bar vs ring dissimilar');

  const sSame = ST.classify.compare({ ...gBar, holes: 0 }, { ...gBar2, holes: 0 });
  const sHole = ST.classify.compare({ ...gBar, holes: 0 }, { ...gBar2, holes: 1 });
  assert.ok(sSame > sHole, 'hole-count mismatch penalized');
});
