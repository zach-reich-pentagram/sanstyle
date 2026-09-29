'use strict';
// Reading letters (recognize.js), finding the letters in a fused shape and
// standing them up (letters.js), and the clean-up rules they rely on.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadST } = require('./loader');

const ST = loadST(['util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'extract.js', 'complete.js',
  'letters-model.js', 'recognize.js', 'letters.js']);
const R = ST.raster;

const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
};
// a mask of round-capped strokes [[ax, ay, bx, by], ...] of half-width r,
// plus rings [[cx, cy, rx, ry], ...]
function draw(w, h, list, r, rings) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = false;
      for (const s of list) if (segDist(x, y, ...s) <= r) { on = true; break; }
      if (!on && rings) {
        for (const [cx, cy, rx, ry] of rings) {
          const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
          if (Math.abs(d - 1) * Math.min(rx, ry) <= r) { on = true; break; }
        }
      }
      if (on) m[y * w + x] = 1;
    }
  }
  return m;
}
const top = (read, n) => read.ranked.slice(0, n).map((r) => r.ch.toUpperCase());

test('recognize.input: the ink box fills 28 px of 32, aspect kept, coverage exact', () => {
  const w = 60, h = 120;
  const m = new Uint8Array(w * h);
  for (let y = 10; y < 110; y++) for (let x = 20; x < 45; x++) m[y * w + x] = 1; // a 25×100 bar
  const inp = ST.recognize.input(m, w, h);
  let sum = 0, rows = new Set(), cols = new Set();
  for (let i = 0; i < inp.length; i++) {
    sum += inp[i];
    if (inp[i] > 1e-6) { rows.add((i / 32) | 0); cols.add(i % 32); }
  }
  // 28 tall, 7 wide: 196 cells of ink in all
  assert.ok(Math.abs(sum - 196) < 0.01, `coverage adds up to the box (${sum.toFixed(3)})`);
  assert.strictEqual(rows.size, 28);
  assert.ok(cols.size >= 7 && cols.size <= 8, `${cols.size} columns`);
});

test('recognize: clean letters read as themselves', () => {
  assert.ok(ST.recognize.ready(), 'the model loads');
  const w = 140, h = 180, r = 9;
  const L = draw(w, h, [[40, 20, 40, 160], [40, 160, 110, 160]], r);
  const T = draw(w, h, [[20, 25, 120, 25], [70, 25, 70, 160]], r);
  const O = draw(w, h, [], r, [[70, 90, 45, 65]]);
  const X = draw(w, h, [[25, 20, 115, 160], [115, 20, 25, 160]], r);
  for (const [ch, m] of [['L', L], ['T', T], ['O', O], ['X', X]]) {
    const read = ST.recognize.classify(m, w, h);
    assert.ok(top(read, 3).includes(ch), `${ch} reads as ${top(read, 3).join('/')}`);
    assert.ok(read.letterness > 0.5, `${ch} reads as one letter (${read.letterness.toFixed(2)})`);
  }
});

test('letters.find: a T fused with an O comes apart into the two letters', () => {
  const w = 320, h = 220, r = 10;
  // the T's bar runs into the O's side
  const m = draw(w, h, [[20, 30, 190, 30], [90, 30, 90, 190]], r, [[230, 110, 60, 85]]);
  const found = ST.letters.find(m, w, h, { center: { x: 90, y: 120 } });
  assert.ok(found && found.letters.length >= 1, 'letters found');
  const first = found.letters[0];
  const mask = ST.letters.render(found, m, w, h, first);
  const bb = R.maskBounds(mask, w, h);
  // the bar ran on into the O's side: it may keep that end, not the O
  assert.ok(bb.x1 < 215, `the letter under the middle stops at the O (right edge ${bb.x1})`);
  assert.ok(top(first.read, 3).includes('T'), `it reads as a T (${top(first.read, 3).join('/')})`);
  // with a click on the O, the O
  const onO = ST.letters.find(m, w, h, { center: { x: 285, y: 110 }, must: { x: 289, y: 110 } });
  const oMask = ST.letters.render(onO, m, w, h, onO.letters[0]);
  const ob = R.maskBounds(oMask, w, h);
  assert.ok(ob.x0 > 150 && ob.x1 > 280, `a click on the O gives the O (${ob.x0}–${ob.x1})`);
  // a click at the far end of the T's stem is a click on the T: the whole
  // T, not the stem alone because its middle is nearer the click
  const onFoot = ST.letters.find(m, w, h, { center: { x: 90, y: 185 }, must: { x: 90, y: 185 } });
  const fMask = ST.letters.render(onFoot, m, w, h, onFoot.letters[0]);
  const fb = R.maskBounds(fMask, w, h);
  assert.ok(fb.x0 < 30 && fb.y0 < 30 && fb.x1 < 215, `a click on the stem's foot gives the whole T (${fb.x0},${fb.y0}–${fb.x1})`);
});

test('letters.lean: a leaning stem stands up; symmetric legs and rounds say nothing', () => {
  const w = 200, h = 240, r = 9;
  const lean = (deg) => {
    const a = (deg * Math.PI) / 180, L = 180;
    const bx = 70, by = 210, tx = bx + Math.sin(a) * L, ty = by - Math.cos(a) * L;
    // a stem with an arm off it (a k-like letter leaning `deg`)
    const mx = (bx + tx) / 2, my = (by + ty) / 2;
    return draw(w, h, [[bx, by, tx, ty], [mx, my, mx + 80, my - 50], [mx, my, mx + 80, my + 60]], r);
  };
  const k14 = ST.letters.lean(lean(14), w, h);
  assert.ok(Math.abs(k14 - 14) < 3, `a stem leaning 14° reads ${k14}°`);
  const kBack = ST.letters.lean(lean(-10), w, h);
  assert.ok(Math.abs(kBack + 10) < 3, `a stem leaning −10° reads ${kBack}°`);
  const A = draw(w, h, [[100, 20, 40, 220], [100, 20, 160, 220], [65, 140, 135, 140]], r);
  assert.strictEqual(ST.letters.lean(A, w, h), 0, 'an A stands as it is');
  const O = draw(w, h, [], r, [[100, 120, 70, 95]]);
  assert.strictEqual(ST.letters.lean(O, w, h), 0, 'an O stands as it is');
});

test('trace.rotatePaths: contours turn about a point, area kept', () => {
  const sq = [{ cubics: [[{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 7, y: 0 }, { x: 10, y: 0 }], [{ x: 10, y: 0 }, { x: 10, y: 3 }, { x: 10, y: 7 }, { x: 10, y: 10 }],
    [{ x: 10, y: 10 }, { x: 7, y: 10 }, { x: 3, y: 10 }, { x: 0, y: 10 }], [{ x: 0, y: 10 }, { x: 0, y: 7 }, { x: 0, y: 3 }, { x: 0, y: 0 }]], area: 100 }];
  const rot = ST.trace.rotatePaths(sq, 90, 5, 5);
  const p = rot[0].cubics[0][0];
  assert.ok(Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y - 0) < 1e-9, `(0,0) turns to (10,0) clockwise (${p.x.toFixed(3)}, ${p.y.toFixed(3)})`);
  assert.strictEqual(rot[0].area, 100);
  assert.strictEqual(ST.trace.rotatePaths(sq, 0, 5, 5), sq, 'no turn, same contours');
});

test('pruneThin: a worn run of necks between two strokes holds; a drip goes', () => {
  const w = 200, h = 80;
  const m = new Uint8Array(w * h);
  const box = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1; };
  box(10, 20, 70, 60);   // a stroke
  box(130, 20, 190, 60); // another
  // between them a worn stretch: thin necks with small crumbs of paint between
  box(70, 37, 85, 43); box(85, 32, 95, 48); box(95, 37, 105, 43); box(105, 32, 115, 48); box(115, 37, 130, 43);
  // a drip hanging off the first stroke
  box(30, 60, 34, 78);
  const out = R.pruneThin(m, w, h, 6);
  const comps = R.components(out, w, h).sizes.filter((s, i) => i > 0 && s > 0).length;
  assert.strictEqual(comps, 1, 'the worn stretch still joins the two strokes');
  assert.strictEqual(out[70 * w + 32], 0, 'the drip is gone');
  // a strand thinner than bridgeMin joins nothing
  const thin = new Uint8Array(w * h);
  for (let y = 20; y < 60; y++) for (let x = 10; x < 70; x++) thin[y * w + x] = 1;
  for (let y = 20; y < 60; y++) for (let x = 130; x < 190; x++) thin[y * w + x] = 1;
  for (let y = 39; y < 41; y++) for (let x = 70; x < 130; x++) thin[y * w + x] = 1;
  const cutStrand = R.pruneThin(thin, w, h, 6, null, { bridgeMin: 3 });
  assert.strictEqual(cutStrand[40 * w + 100], 0, 'a hair-thin strand is not a stroke');
});

test('cutMask: a cut takes only from the far side of its line', () => {
  const w = 60, h = 40;
  const excl = ST.extract.cutMask(w, h, [{ x0: 30, y0: 0, x1: 30, y1: 39, width: 12 }], { x: 10, y: 20 });
  assert.strictEqual(excl[20 * w + 26], 0, 'the letter keeps its side up to the line');
  assert.strictEqual(excl[20 * w + 30], 1, 'the line itself is cut');
  assert.strictEqual(excl[20 * w + 35], 1, 'the far side loses a band');
  const both = ST.extract.cutMask(w, h, [{ x0: 30, y0: 0, x1: 30, y1: 39, width: 12 }]);
  assert.strictEqual(both[20 * w + 26], 1, 'without a letter to keep, both sides go');
});

test('trace: a slanted stroke end is not pulled out into a spike', () => {
  const w = 220, h = 160;
  // a fat stroke cut off at a slant: its end has an acute outside corner
  const m = new Uint8Array(w * h);
  for (let y = 40; y < 110; y++) for (let x = 10; x < 200; x++) if (x < 140 + (y - 40) * 0.8) m[y * w + x] = 1;
  const paths = ST.trace.vectorize(m, w, h, { autoScale: true });
  const bb = ST.trace.boundsOf(paths);
  assert.ok(bb.x1 <= 197 + 3, `the trace stays within the paint (right edge ${bb.x1.toFixed(1)} of 196)`);
});

test('renderStrokes: a stroke kept where a neighbor crossed it keeps its own width through the crossing', () => {
  const w = 200, h = 140;
  // a bar crossed at 45° by a neighbor's stroke, both 19 px wide
  const m = draw(w, h, [[20, 70, 180, 70], [40, 10, 160, 130]], 9);
  const sc = ST.extract.strokeChains(m, w, h);
  const bar = new Set();
  for (let c = 1; c <= sc.n; c++) {
    let y0 = h, y1 = -1;
    for (const p of sc.skel[c]) { const y = (p / w) | 0; y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (y1 - y0 < 12) bar.add(c);
  }
  assert.ok(bar.size >= 1 && bar.size < sc.n, 'the bar is told apart from the diagonal');
  const out = ST.extract.renderStrokes(sc, m, w, h, bar);
  let off = 0, gap = 0;
  for (let x = 30; x <= 170; x++) {
    if (!out[70 * w + x]) gap++;
    for (let y = 0; y < h; y++) if (out[y * w + x] && Math.abs(y - 70) > 10) off++;
  }
  assert.strictEqual(off, 0, `no bump of the neighbor's ink on the bar (${off} px off its band)`);
  assert.strictEqual(gap, 0, 'the bar runs on unbroken through the crossing');
});

test('localWall: a letter on a surface other than the photo border\'s is judged against its own wall', () => {
  const w = 300, h = 300;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // a gray wall at the border, a dark wooden post filling the middle,
      // a light-blue stroke on the post
      let c = [155, 154, 148];
      if (x > 30 && x < 270 && y > 30 && y < 270) c = [72, 66, 56];
      if (segDist(x, y, 110, 90, 190, 210) <= 10) c = [140, 205, 232];
      const n = ((x * 7 + y * 13) % 9) - 4, p = (y * w + x) * 4;
      data[p] = c[0] + n; data[p + 1] = c[1] + n; data[p + 2] = c[2] + n; data[p + 3] = 255;
    }
  }
  const border = ST.extract.backgroundColor(data, w, h);
  assert.ok(Math.abs(border.r - 155) < 12, 'the border reads as the gray wall');
  const local = ST.extract.localWall(data, w, h, 150, 150, border);
  assert.ok(local && Math.abs(local.bg.r - 72) < 12 && Math.abs(local.bg.b - 56) < 12, `the letter's wall is the post (${local && [local.bg.r, local.bg.g, local.bg.b].map(Math.round)})`);
  assert.strictEqual(ST.extract.localWall(data, w, h, 10, 10, border), null, 'where the border shows, its color stands');
});

test('inks: every paint read apart — a bleed halo is not the letter, a gray bar beside it is a paint of its own', () => {
  const A = loadST(['util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'extract.js', 'complete.js', 'auto.js']);
  const W = 240, H = 240;
  const L = [[60, 40, 60, 200], [60, 200, 130, 200]]; // a red marker L
  const photo = (extra) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.min(...L.map((s) => segDist(x, y, ...s)));
        let c = [222, 214, 198];
        if (extra === 'halo' && d <= 24) c = [240, 170, 175]; // its pink bleed
        if (extra === 'pipe' && segDist(x, y, 200, 30, 200, 210) <= 8) c = [120, 120, 125]; // a gray bar beside it
        if (d <= 8) c = [185, 30, 45];
        const n = ((x * 7 + y * 13) % 9) - 4, p = (y * W + x) * 4;
        data[p] = c[0] + n; data[p + 1] = c[1] + n; data[p + 2] = c[2] + n; data[p + 3] = 255;
      }
    }
    return A.auto.inks(data, W, H, {});
  };
  const red = (r) => r.inks.find((k) => k.seed.r > 150 && k.seed.g < 90);
  const halo = photo('halo');
  const rh = red(halo);
  assert.ok(rh, 'the red L is read as a paint');
  assert.ok(rh.raw[100 * W + 60] && !rh.raw[100 * W + 60 + 18], 'its core is in, its pink bleed out');
  const pipe = photo('pipe');
  const rp = red(pipe), gray = pipe.inks.find((k) => Math.abs(k.seed.r - k.seed.b) < 20 && k.seed.r < 160);
  assert.ok(rp && gray, `the L and the bar are two paints (${pipe.inks.map((k) => [k.seed.r, k.seed.g, k.seed.b].map(Math.round).join(',')).join(' / ')})`);
  let shared = 0;
  for (let i = 0; i < W * H; i++) if (rp.raw[i] && gray.raw[i]) shared++;
  assert.strictEqual(shared, 0, 'the red L is not read again as part of the gray paint');
  assert.ok(gray.raw[100 * W + 200] && !gray.raw[100 * W + 60], 'the bar is the gray paint, the L is not');
});

test('sync.dedupe: the same photo shared twice is one entry that knows its copies', () => {
  const S = loadST(['util.js', 'sync.js']);
  const photos = [
    { id: 'a1', name: 'IMG_1.HEIC', size: '100' },
    { id: 'b1', name: 'IMG_2.HEIC', size: '200' },
    { id: 'a2', name: 'IMG_1.HEIC', size: '100' },
    { id: 'c1', name: 'IMG_2.HEIC', size: '201' }, // same name, another photo
  ];
  const out = S.sync.dedupe(photos);
  // (arrays from the app's realm: compared as text)
  assert.strictEqual(out.map((p) => p.id).join(), 'a1,b1,c1');
  assert.strictEqual(out[0].copies.join(), 'a1,a2');
  assert.strictEqual(out[1].copies.join(), 'b1');
});
