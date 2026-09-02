'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadST } = require('./loader');

const ST = loadST(['util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'extract.js']);

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

test('seeded: dry-brush density — the click patch still grows to the whole letter', () => {
  const w = 420, h = 420;
  const rnd = ST.rng(11);
  const data = new Uint8ClampedArray(w * h * 4);
  const inL = (x, y) => (x >= 90 && x < 150 && y >= 60 && y < 340) || (x >= 90 && x < 300 && y >= 290 && y < 340);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const n = (rnd() - 0.5) * 24;
      if (inL(x, y)) {
        // blocky density: 20px cells alternate between dense and faint paint
        const dense = ((Math.floor(x / 20) + Math.floor(y / 20)) % 3) !== 0;
        const k = dense ? 1.0 : 0.45;
        data[p] = 175 + (190 - 175) * k + n; data[p + 1] = 172 + (40 - 172) * k + n; data[p + 2] = 165 + (50 - 165) * k + n;
      } else {
        data[p] = 175 + n; data[p + 1] = 172 + n; data[p + 2] = 165 + n;
      }
      data[p + 3] = 255;
    }
  }
  const cnv = { width: w, height: h, getContext: () => ({ getImageData: () => ({ data }) }) };
  const res = ST.extract.seeded(cnv, 120, 200, {});
  assert.ok(res, 'extraction succeeded');
  const bb = ST.trace.boundsOf(res.candidates[0].paths);
  assert.ok(bb.w > 190 && bb.h > 260, `whole letter captured despite density gaps (${bb.w.toFixed(0)}×${bb.h.toFixed(0)})`);
});

test('seeded with a cut: a full-width junction is severed', () => {
  const w = 400, h = 200;
  // two blocks joined by a bridge as tall as the blocks (no thin contact)
  const cnv = fakeCanvas(w, h, (x, y) => y >= 60 && y < 140 && x >= 40 && x < 360);
  const whole = ST.extract.seeded(cnv, 80, 100, {});
  assert.ok(whole && whole.region.w > 300, 'without a cut the region spans both blocks');
  const cut = ST.extract.seeded(cnv, 80, 100, { cuts: [{ x0: 200, y0: 40, x1: 200, y1: 160, width: 12 }] });
  assert.ok(cut, 'cut extraction succeeded');
  assert.ok(cut.region.x + cut.region.w < 215, `cut region stops at the cut (right edge ${cut.region.x + cut.region.w})`);
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

test('background estimate + click snap: a click beside the stroke seeds from the paint', () => {
  const w = 420, h = 420;
  const cnv = fakeCanvas(w, h, (x, y) =>
    (x >= 90 && x < 150 && y >= 60 && y < 340) || (x >= 90 && x < 300 && y >= 290 && y < 340));
  const data = cnv.getContext('2d').getImageData(0, 0, w, h).data;
  const bg = ST.extract.backgroundColor(data, w, h);
  assert.ok(bg && Math.abs(bg.r - 175) < 6 && Math.abs(bg.g - 172) < 6 && Math.abs(bg.b - 165) < 6,
    `border ring votes the wall color (${bg && [bg.r, bg.g, bg.b].map((c) => c.toFixed(0))})`);
  // 10 px left of the stem, on the wall
  const res = ST.extract.seeded(cnv, 80, 200, {});
  assert.ok(res, 'extraction succeeded from a near-miss click');
  assert.ok(res.click.x >= 90 && res.click.x < 150, `click snapped onto the stem (x=${res.click.x})`);
  const bb = ST.trace.boundsOf(res.candidates[0].paths);
  assert.ok(Math.abs(bb.w - 210) < 14 && Math.abs(bb.h - 280) < 14, `whole L traced (${bb.w.toFixed(0)}×${bb.h.toFixed(0)})`);
  // a click squarely on the paint stays (essentially) where it is
  const on = ST.extract.seeded(cnv, 120, 200, {});
  assert.ok(on && Math.abs(on.click.x - 120) <= 3 && Math.abs(on.click.y - 200) <= 3,
    `a click on the paint is not moved (${on && on.click.x},${on && on.click.y})`);
});

test('isolateStrokes: a neighbor stroke joining the letter at a T is dropped at the join', () => {
  const w = 300, h = 300;
  const full = new Uint8Array(w * h);
  const bar = (x, y) => x >= 150 && x < 190 && y >= 40 && y < 260;   // the letter
  const arm = (x, y) => x >= 5 && x < 150 && y >= 140 && y < 180;    // neighbor's stroke, touching the bar
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bar(x, y) || arm(x, y)) full[y * w + x] = 1;
  const box = { x0: 130, y0: 20, x1: 210, y1: 280 };
  const res = ST.extract.isolateStrokes(full, w, h, box, 170, 100);
  assert.ok(res && res.foreign >= 1, `the arm is recognized as a stroke that leaves the box (${res && res.strokes} strokes, ${res && res.foreign} foreign)`);
  const out = res.mask;
  assert.ok(!out[160 * w + 60] && !out[160 * w + 125], 'the arm is gone, stub included');
  assert.ok(out[160 * w + 170] && out[60 * w + 170] && out[250 * w + 170], 'the bar is intact');
  const barArea = 40 * 220;
  const n = ST.raster.count(out);
  assert.ok(n >= barArea * 0.97 && n <= barArea + 40 * 10, `at most a nub of the arm remains (${n} px vs bar ${barArea})`);
  // the letter's own foot poking 30 px past a tight box is not a neighbor
  const full2 = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (bar(x, y) || (y >= 230 && y < 260 && x >= 150 && x < 240)) full2[y * w + x] = 1; // bar + foot to x=240
  }
  const res2 = ST.extract.isolateStrokes(full2, w, h, box, 170, 100);
  assert.ok(res2 && res2.foreign === 0 && res2.mask[245 * w + 230], 'the overhanging foot is kept');
  assert.strictEqual(ST.raster.count(res2.mask), ST.raster.count(full2), 'nothing of the letter is lost');
});

test('roundEnds: needle-sharp stroke ends become caps, thin bridges survive', () => {
  const w = 300, h = 120;
  const m = new Uint8Array(w * h);
  // a 20-px bar whose left end tapers to a 60-px needle, plus a 10-px bridge to a block on the right
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ink = false;
      if (x >= 80 && x < 200 && y >= 50 && y < 70) ink = true;                         // bar
      if (x >= 20 && x < 80) { const half = ((x - 20) / 60) * 10; ink = Math.abs(y - 60) < half; } // needle taper
      if (x >= 200 && x < 240 && y >= 55 && y < 65) ink = true;                        // thin bridge
      if (x >= 240 && x < 290 && y >= 30 && y < 90) ink = true;                        // block
      if (ink) m[y * w + x] = 1;
    }
  }
  const out = ST.extract.roundEnds(m, w, h, null);
  assert.ok(!out[60 * w + 30], 'the needle tip is gone');
  assert.ok(out[60 * w + 100] && out[52 * w + 100], 'the bar is intact');
  assert.ok(out[60 * w + 220], 'the thin bridge that connects the block is kept');
  assert.ok(out[60 * w + 260], 'the block is intact');
  // the new left end is blunt: a few px in from the new tip the bar is already several px tall
  let tip = w;
  for (let x = 0; x < w; x++) { let any = false; for (let y = 0; y < h; y++) if (out[y * w + x]) { any = true; break; } if (any) { tip = x; break; } }
  let tall = 0;
  for (let y = 0; y < h; y++) if (out[y * w + tip + 3]) tall++;
  assert.ok(tip > 26 && tall >= 6, `blunt cap (${tall} px tall 3 px in from the tip at x=${tip})`);
});

test('isolateStrokes: a neighbor joining a stroke END around a corner is cut at the corner', () => {
  const w = 300, h = 300;
  const full = new Uint8Array(w * h);
  const bar = (x, y) => x >= 130 && x < 160 && y >= 120 && y < 260;     // the letter: a vertical bar
  const foot = (x, y) => x >= 100 && x < 200 && y >= 240 && y < 260;    // with a foot
  // neighbor: a diagonal from the bar's top going up-right, far beyond the box
  const diag = (x, y) => {
    const t = ((x - 145) + (120 - y)) / 2;                                // along the 45° line
    const d = Math.abs((x - 145) - (120 - y)) / Math.SQRT2;               // distance from it
    return t >= 0 && t <= 200 && d < 15;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bar(x, y) || foot(x, y) || diag(x, y)) full[y * w + x] = 1;
  // the template box: the letter with a generous top (some of the neighbor inside)
  const box = { x0: 90, y0: 80, x1: 210, y1: 270 };
  const res = ST.extract.isolateStrokes(full, w, h, box, 145, 200);
  assert.ok(res && res.foreign >= 1, `the diagonal is a stroke of its own that leaves the box (${res && res.strokes} strokes, ${res && res.foreign} foreign)`);
  const out = res.mask;
  assert.ok(!out[95 * w + 170] && !out[60 * w + 205], 'the diagonal is gone, inside the box too');
  assert.ok(out[130 * w + 145] && out[140 * w + 145] && out[200 * w + 145], 'the bar keeps its top');
  assert.ok(out[250 * w + 110], 'the foot is intact');
  const n = ST.raster.count(out), letter = 30 * 140 + 100 * 20 - 30 * 20;
  assert.ok(n >= letter * 0.93 && n <= letter * 1.1, `letter preserved (${n} px vs ${letter})`);
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
