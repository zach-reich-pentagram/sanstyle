'use strict';
// Marker caps: fading stroke ends become round caps in the mask, and the
// tracer keeps round ends round instead of sharpening them into corners.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadST } = require('./loader');

const ST = loadST(['util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'classify.js', 'extract.js']);

// A horizontal stroke: round left cap at x0, half-width profile r(x) to x1.
function stroke(w, h, cy, x0, x1, rOf) {
  const m = new Uint8Array(w * h);
  for (let x = x0; x <= x1; x++) {
    const r = rOf(x);
    if (!(r > 0)) continue;
    for (let y = 0; y < h; y++) if (Math.abs(y - cy) <= r) m[y * w + x] = 1;
  }
  return m;
}
const count = (m) => ST.raster.count(m);
function tipX(m, w, h) { let t = -1; for (let i = 0; i < m.length; i++) if (m[i]) t = Math.max(t, i % w); return t; }
function colWidth(m, w, h, x) { let n = 0; for (let y = 0; y < h; y++) if (m[y * w + x]) n++; return n; }

test('capEnds: a fading taper is cut back and ended with a round cap of the stroke width', () => {
  const w = 260, h = 90, cy = 45, R = 14;
  // round cap centred at 34, full width to 170, then a linear fade to a point at 230
  const r = (x) => (x < 34 ? Math.sqrt(Math.max(0, R * R - (34 - x) * (34 - x))) : x <= 170 ? R : R - (R - 1) * ((x - 170) / 60));
  const m = stroke(w, h, cy, 20, 230, r);
  const sw = 2 * R;
  const depth = Math.round(0.3 * sw);
  const before = tipX(m, w, h);
  assert.ok(colWidth(m, w, h, before - depth) < 0.3 * sw, `the taper is a point (${colWidth(m, w, h, before - depth)} px wide ${depth} px in)`);

  const out = ST.extract.capEnds(m, w, h);
  const tip = tipX(out, w, h);
  assert.ok(tip >= 185 && tip <= 212, `taper trimmed to where the stroke has most of its width (tip at x=${tip})`);
  const wid = colWidth(out, w, h, tip - depth);
  assert.ok(wid >= 0.55 * sw, `round cap: ${wid} px wide ${depth} px in from the tip (stroke ${sw})`);
  // the cap is a disc: widths shrink like a circle, never a wedge
  const w2 = colWidth(out, w, h, tip - 2), w5 = colWidth(out, w, h, tip - 5);
  assert.ok(w2 > 0 && w5 > w2 && wid > w5, `widths grow from the tip like a circle (${w2}, ${w5}, ${wid})`);
  // the far, already-round end is untouched
  let same = true;
  for (let y = 0; y < h; y++) for (let x = 0; x < 120; x++) if (m[y * w + x] !== out[y * w + x]) same = false;
  assert.ok(same, 'the round end and the body stay exactly as they were');
});

test('capEnds: a stroke that already ends in a round cap, or in an arrowhead, is left alone', () => {
  const w = 260, h = 90, cy = 45, R = 14;
  const stadium = stroke(w, h, cy, 20, 240, (x) => (x < 34 ? Math.sqrt(Math.max(0, R * R - (34 - x) ** 2)) : x <= 226 ? R : Math.sqrt(Math.max(0, R * R - (x - 226) ** 2))));
  assert.strictEqual(count(ST.extract.capEnds(stadium, w, h)), count(stadium), 'stadium unchanged');
  // thin shaft with a triangular head that comes to a point: drawn that way, not faded
  const arrow = stroke(w, h, cy, 20, 215, (x) => (x < 28 ? Math.sqrt(Math.max(0, 64 - (28 - x) ** 2)) : x <= 165 ? 8 : 24 * (215 - x) / 50));
  assert.strictEqual(count(ST.extract.capEnds(arrow, w, h)), count(arrow), 'arrowhead unchanged');
});

test('vectorize keeps a round stroke end round (no corner at the cap)', () => {
  const w = 460, h = 80, cy = 40, R = 15;
  const m = stroke(w, h, cy, 20, 440, (x) => (x < 35 ? Math.sqrt(Math.max(0, R * R - (35 - x) ** 2)) : x <= 425 ? R : Math.sqrt(Math.max(0, R * R - (x - 425) ** 2))));
  const paths = ST.trace.vectorize(m, w, h, {});
  assert.strictEqual(paths.length, 1);
  const poly = ST.trace.flattenAll(paths, 1)[0];
  // width of the outline 0.3 strokes in from its right tip
  let tip = -Infinity;
  for (const p of poly) tip = Math.max(tip, p.x);
  const line = tip - 0.3 * 2 * R;
  const ys = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a.x <= line && b.x > line) || (b.x <= line && a.x > line)) ys.push(a.y + (b.y - a.y) * ((line - a.x) / (b.x - a.x)));
  }
  assert.strictEqual(ys.length, 2, 'two crossings');
  const wid = Math.abs(ys[0] - ys[1]);
  assert.ok(wid >= 0.7 * 2 * R, `outline is ${wid.toFixed(1)} px wide ${(0.3 * 2 * R).toFixed(0)} px in (round: ~${(2 * Math.sqrt(R * R - (0.4 * R) ** 2)).toFixed(0)})`);
  // G1 everywhere: no cubic join turns sharply
  const cs = paths[0].cubics;
  let maxTurn = 0;
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i], b = cs[(i + 1) % cs.length];
    const d1 = { x: a[3].x - a[2].x, y: a[3].y - a[2].y }, d2 = { x: b[1].x - b[0].x, y: b[1].y - b[0].y };
    const l1 = Math.hypot(d1.x, d1.y), l2 = Math.hypot(d2.x, d2.y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (d1.x * d2.x + d1.y * d2.y) / (l1 * l2))));
    maxTurn = Math.max(maxTurn, ang);
  }
  assert.ok(maxTurn < (35 * Math.PI) / 180, `sharpest join ${(maxTurn * 180 / Math.PI).toFixed(1)}°`);
});
