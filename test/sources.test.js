'use strict';
// Where in its photo a letterform was cut (store.js, `variant.photo`): the
// record that lets the tester cut the bit of photo again on a device that
// never had the crop.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadST } = require('./loader');

const ST = loadST(['util.js', 'store.js']);

// The pipeline's straightening, done by hand: the photo (w0×h0) turned by
// `angle` about its middle onto its turned bounds (auto.rotateCanvas) and
// scaled by k; then perhaps a crop of that (fractions), read enlarged ×1.6.
function straighten(o) {
  const rad = (-o.angle * Math.PI) / 180;
  const cs = Math.abs(Math.cos(rad)), sn = Math.abs(Math.sin(rad));
  const W = o.w0 * cs + o.h0 * sn, H = o.w0 * sn + o.h0 * cs;
  const f = o.frame || { x: 0, y: 0, w: 1, h: 1 };
  const view = o.frame ? { w: Math.round(f.w * W * o.k * 1.6), h: Math.round(f.h * H * o.k * 1.6) } : { w: Math.round(W * o.k), h: Math.round(H * o.k) };
  return {
    full: { w: Math.round(W * o.k), h: Math.round(H * o.k) },
    view,
    // photo px → px on the canvas the stage shows
    at(p) {
      const dx = p.x - o.w0 / 2, dy = p.y - o.h0 / 2;
      const rx = dx * Math.cos(rad) - dy * Math.sin(rad) + W / 2;
      const ry = dx * Math.sin(rad) + dy * Math.cos(rad) + H / 2;
      return { x: ((rx / W - f.x) / f.w) * view.w, y: ((ry / H - f.y) / f.h) * view.h };
    },
  };
}

test('photoQuad: a spot on the straightened (and cropped) photo maps back onto the photo as shot', () => {
  const w0 = 1500, h0 = 1000;
  for (const angle of [0, 9, -14.5, 20]) {
    for (const frame of [null, { x: 0.2, y: 0.15, w: 0.5, h: 0.6 }]) {
      const st = straighten({ w0, h0, angle, k: 1.3, frame });
      for (const p of [{ x: 700, y: 200 }, { x: 150, y: 820 }, { x: 1300, y: 600 }]) {
        const c = st.at(p);
        const quad = ST.sources.photoQuad({
          angle, full: st.full, frame, view: st.view,
          rect: { x: c.x - 20, y: c.y - 20, w: 40, h: 40 },
        });
        assert.ok(quad, 'a quad');
        const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        assert.ok(Math.abs(cx * w0 - p.x) < 1.5 && Math.abs(cy * h0 - p.y) < 1.5,
          `angle ${angle}${frame ? ', cropped' : ''}: (${p.x}, ${p.y}) came back as (${(cx * w0).toFixed(1)}, ${(cy * h0).toFixed(1)})`);
        // the square stays square on the photo: it only turned (to the 4 decimals kept)
        const side = (i, j) => Math.hypot((quad[2 * i] - quad[2 * j]) * w0, (quad[2 * i + 1] - quad[2 * j + 1]) * h0);
        assert.ok(Math.abs(side(0, 1) - side(0, 3)) < 0.4, `turned, not sheared (${side(0, 1).toFixed(3)} × ${side(0, 3).toFixed(3)})`);
      }
    }
  }
});

test('subFrame: a crop of a crop composes', () => {
  const R = { width: 1000, height: 800 };
  const C1 = { width: 1200, height: 900, _frame: ST.sources.subFrame(R, 100, 200, 400, 300) }; // read enlarged ×3
  const f = ST.sources.subFrame(C1, 600, 450, 300, 300);
  assert.deepStrictEqual(
    [f.x, f.y, f.w, f.h].map((v) => Math.round(v * 1e6) / 1e6),
    [0.3, 0.4375, 0.1, 0.125]);
});

test('photoOf: a queue item records its Drive photo and the crop with its margin; demo walls record nothing', () => {
  const canvas = { width: 1000, height: 800 };
  const item = { canvas, original: { canvas }, angle: 0, sourceId: 'ph_abc_000001', name: 'IMG_1.HEIC' };
  const rec = ST.sources.photoOf(item, { x: 400, y: 300, w: 200, h: 200 });
  assert.strictEqual(rec.id, 'ph_abc_000001');
  assert.strictEqual(rec.name, 'IMG_1.HEIC');
  // 15% margin (30 px) each side, as capture.sourceThumb keeps
  assert.deepStrictEqual(Array.from(rec.quad), [0.37, 0.3375, 0.63, 0.3375, 0.63, 0.6625, 0.37, 0.6625]);
  // clipped to the canvas like the kept crop
  const edge = ST.sources.photoOf(item, { x: -20, y: 700, w: 100, h: 150 });
  assert.deepStrictEqual(Array.from(edge.quad).map((v) => Math.round(v * 1000) / 1000), [0, 0.846, 0.103, 0.846, 0.103, 1, 0, 1]);
  assert.strictEqual(ST.sources.photoOf({ canvas, angle: 0, name: 'demo-A' }, { x: 1, y: 1, w: 9, h: 9 }), null);
  const local = ST.sources.photoOf({ canvas, angle: 0, name: 'wall.jpg' }, { x: 1, y: 1, w: 9, h: 9 });
  assert.ok(local && !local.id && local.name === 'wall.jpg', 'a local upload keeps its name');
});

test('a letterform\'s photo record rides through export and import', () => {
  const A = loadST(['util.js', 'store.js']);
  const B = loadST(['util.js', 'store.js']);
  B.store._save = () => {}; // (no timers in the test realm)
  A.store.state.glyphs = { K: { active: 0, variants: [{ id: 'v1', char: 'K', contours: [], photo: { id: 'ph_k', name: 'k.jpg', quad: [0.1, 0.1, 0.2, 0.1, 0.2, 0.3, 0.1, 0.3] } }] } };
  B.store.importJSON(A.store.exportJSON(), true);
  const v = B.store.variantById('v1');
  assert.ok(v && v.photo && v.photo.id === 'ph_k' && v.photo.quad.length === 8);
  assert.strictEqual(B.store.variantById('nope'), null);
});

test('photoOf: a flattened photo — the crop found again through the flattening', () => {
  const S = loadST(['util.js', 'raster.js', 'rectify.js', 'store.js']);
  // a photo read at 600×800 and flattened by a homography (turned and
  // keystoned), the flat canvas 826×953
  const Hm = [[1.05, 0.315, 0], [-0.212, 0.949, 127.3], [0.00023, 0, 0.93]];
  const item = { name: 'IMG_1.HEIC', sourceId: 'abc', canvas: { width: 826, height: 953 }, angle: 18.4, rect: { H: Hm, srcW: 600, srcH: 800 } };
  const crop = { x: 300, y: 300, w: 100, h: 120 };
  const from = S.sources.photoOf(item, crop);
  assert.ok(from && from.quad.length === 8, 'a quad');
  // each corner of the quad, in photo px, goes back through the flattening
  // to the corner of the crop (with its 15% margin) on the flat canvas
  const pad = Math.round(120 * 0.15);
  const want = [[crop.x - pad, crop.y - pad], [crop.x + crop.w + pad, crop.y - pad], [crop.x + crop.w + pad, crop.y + crop.h + pad], [crop.x - pad, crop.y + crop.h + pad]];
  for (let k = 0; k < 4; k++) {
    const p = S.rectify.apply(Hm, from.quad[2 * k] * 600, from.quad[2 * k + 1] * 800);
    assert.ok(Math.hypot(p[0] - want[k][0], p[1] - want[k][1]) < 0.5, `corner ${k}: ${p[0].toFixed(1)},${p[1].toFixed(1)} vs ${want[k]}`);
  }
});
