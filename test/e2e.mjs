/* Sanstyle end-to-end: drives the real app in headless Chromium.
 * Covers the manual flow (mouse lasso, polygon lasso, flatten, pick-paint),
 * the automated flow (detect → review → accept), HEIC intake,
 * variant cycling, kerning, exports, and validates every compiled font with
 * an independent parser plus fontTools. Regenerates the README screenshots.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { parse } = require('./ttfparse.js');

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(ROOT, '.tmp');
const SHOTS = path.join(ROOT, 'docs', 'shots');
mkdirSync(TMP, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
};

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ FAIL: ${msg}`); }
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname === '/') p = path.join(ROOT, 'index.html');
  try {
    const body = readFileSync(p);
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
}

const server = createServer(serveStatic);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
console.log('serving', BASE);

// ---- mock cloud: same HTTP contract as the real Drive-backed /api ----------
const cloud = {
  library: null,
  svgs: new Map(),      // variantId → {name, content}
  inbox: [],
  photoBytes: new Map(),
  uploads: [],
};

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const apiServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/api/health') return json(200, { configured: true });
  if (url.pathname.startsWith('/api/')) {
    if (req.headers['x-sanstyle-pass'] !== '3754') return json(401, { error: 'bad passcode' });
    if (url.pathname === '/api/library' && req.method === 'GET') {
      return json(200, { library: cloud.library, svgIds: [...cloud.svgs.keys()] });
    }
    if (url.pathname === '/api/library' && req.method === 'PUT') {
      const body = JSON.parse((await readAll(req)).toString('utf8'));
      cloud.library = body.library;
      for (const s of body.svgs || []) cloud.svgs.set(s.id, { name: s.name, content: s.content });
      const keep = new Set();
      for (const ch in cloud.library.glyphs) {
        for (const v of cloud.library.glyphs[ch].variants) keep.add(v.id);
      }
      for (const id of [...cloud.svgs.keys()]) if (!keep.has(id)) cloud.svgs.delete(id);
      return json(200, { ok: true, svgIds: [...cloud.svgs.keys()] });
    }
    if (url.pathname === '/api/inbox') return json(200, { photos: cloud.inbox });
    if (url.pathname === '/api/diag') {
      return json(200, {
        token: { ok: true }, inbox: { ok: true, detail: `${cloud.inbox.length} file(s)` },
        library: { ok: true }, write: { ok: true },
      });
    }
    if (url.pathname === '/api/photo') {
      const b = cloud.photoBytes.get(url.searchParams.get('id'));
      if (!b) return json(404, { error: 'nope' });
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(b);
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const bytes = await readAll(req);
      const id = 'up_' + String(cloud.uploads.length + 1).padStart(10, '0');
      let name = 'photo.jpg';
      try { name = decodeURIComponent(req.headers['x-file-name'] || name); } catch { /* default */ }
      cloud.uploads.push({ id, name, size: bytes.length, mime: req.headers['content-type'] });
      cloud.inbox.push({ id, name, mimeType: req.headers['content-type'], createdTime: new Date().toISOString() });
      cloud.photoBytes.set(id, bytes);
      return json(200, { id, name });
    }
    return json(404, { error: 'nope' });
  }
  return serveStatic(req, res);
});
await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
const API_BASE = `http://127.0.0.1:${apiServer.address().port}/`;
console.log('serving (with mock api)', API_BASE);

async function pollCloud(desc, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 15000)) {
    if (fn()) { check(true, desc); return true; }
    await new Promise((r) => setTimeout(r, 250));
  }
  check(false, desc + ' (timed out)');
  return false;
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1560, height: 940 },
  deviceScaleFactor: 1.5,
});
// Resource-status console lines (the 404 that detects local mode, the 401 of a
// deliberately wrong passcode) are expected network noise, not JS errors.
const isRealError = (t) => !/Failed to load resource/.test(t);
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && isRealError(m.text())) jsErrors.push(m.text()); });

await page.goto(BASE);
await page.waitForFunction(() => globalThis.__st && globalThis.ST);
check((await page.title()) === 'Sanstyle', 'page title is "Sanstyle"');
console.log('\n— app booted');

// ---- Flow A: real-mouse freehand lasso -------------------------------------
console.log('\n— flow A: freehand lasso on a demo “S”');
await page.evaluate(() => { __st.loadDemo('S'); ST.capture.skipFlatten(); });
const corners = await page.evaluate(() => {
  const b = ST.capture.lastDemo.letterBox;
  const r = document.getElementById('stage').getBoundingClientRect();
  return [
    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
  ].map((p) => {
    const s = ST.capture.toScreen(p);
    return { x: s.x + r.left, y: s.y + r.top };
  });
});
await page.mouse.move(corners[0].x, corners[0].y);
await page.mouse.down();
for (const c of [...corners.slice(1), corners[0]]) await page.mouse.move(c.x, c.y, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(250);
let st = await page.evaluate(() => ({
  step: __st.state().step,
  paths: ST.capture.extract ? ST.capture.extract.paths.length : 0,
}));
check(st.step === 'ink' && st.paths >= 1, `freehand lasso traced (${st.paths} contours)`);
await page.fill('#charInput', 'S');
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(SHOTS, 'capture.png') });
await page.click('#submitBtn');
check((await page.evaluate(() => __st.state().chars)).includes('S'), 'S submitted');

// ---- Flow A2: polygon lasso, second S variant --------------------------------
console.log('\n— flow A2: polygon lasso captures a second “S” variant');
await page.evaluate(() => { __st.loadDemo('S'); ST.capture.skipFlatten(); });
await page.click('#toolPoly');
const pcorners = await page.evaluate(() => {
  const b = ST.capture.lastDemo.letterBox;
  const r = document.getElementById('stage').getBoundingClientRect();
  return [
    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
  ].map((p) => {
    const s = ST.capture.toScreen(p);
    return { x: s.x + r.left, y: s.y + r.top };
  });
});
for (const c of pcorners) {
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(40);
}
await page.mouse.click(pcorners[0].x, pcorners[0].y); // close on first vertex
await page.waitForTimeout(250);
st = await page.evaluate(() => ({
  step: __st.state().step,
  paths: ST.capture.extract ? ST.capture.extract.paths.length : 0,
}));
check(st.step === 'ink' && st.paths >= 1, `polygon lasso closed and traced (${st.paths} contours)`);
check(await page.evaluate(() => __st.tagAndSubmit('S')), 'second S variant submitted');
const sVariants = await page.evaluate(() => ST.store.slot('S').variants.length);
check(sVariants === 2, `S now has ${sVariants} variants`);
await page.click('#toolLasso');

// ---- Flow B: the rest of the demo letters via hooks ---------------------------
console.log('\n— flow B: capture A E N O T 5 #');
for (const ch of ['A', 'E', 'N', 'O', 'T', '5', '#']) {
  const r = await page.evaluate((c) => {
    __st.loadDemo(c);
    ST.capture.skipFlatten();
    const ex = __st.lassoDemoLetter();
    const ok = __st.tagAndSubmit(c);
    return { ...ex, ok };
  }, ch);
  check(r.ok && r.paths >= 1, `“${ch}”: ${r.paths} contours → submitted`);
}

// ---- fill-gaps slider: counter of O fills only when cranked -------------------
console.log('\n— fill gaps');
const fillTest = await page.evaluate(() => {
  __st.loadDemo('O');
  ST.capture.skipFlatten();
  ST.capture.ink.fill = 0;
  __st.lassoDemoLetter();
  const holesAt0 = ST.capture.extract.paths.filter((p) => p.area < 0).length;
  ST.capture.ink.fill = 75;
  ST.capture.runExtraction(false);
  const holesAtMax = ST.capture.extract.paths.filter((p) => p.area < 0).length;
  ST.capture.ink.fill = 5;
  ST.capture.clearLasso();
  return { holesAt0, holesAtMax };
});
check(fillTest.holesAt0 >= 1, `O keeps its counter at fill 0 (${fillTest.holesAt0} hole)`);
check(fillTest.holesAtMax === 0, 'cranked fill-gaps makes the O solid');

// ---- Flow C: flatten + pick-paint ---------------------------------------------
console.log('\n— flow C: flatten (homography) + pick-paint mode');
const flat = await page.evaluate(() => {
  __st.loadDemo('E');
  const before = { w: ST.capture.img.width, h: ST.capture.img.height };
  const q = ST.capture.quad;
  q[0].x += 40; q[0].y += 22; q[1].x -= 25; q[3].y -= 18;
  ST.capture.applyFlatten();
  return { before, after: { w: ST.capture.img.width, h: ST.capture.img.height }, step: ST.capture.step };
});
check(flat.step === 'lasso' && (flat.after.w !== flat.before.w || flat.after.h !== flat.before.h),
  `flatten warped ${flat.before.w}×${flat.before.h} → ${flat.after.w}×${flat.after.h}`);
const colorPick = await page.evaluate(() => {
  const hex = ST.capture.lastDemo.color;
  const seed = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
  ST.capture.ink.mode = 'color';
  ST.capture.ink.seeds = [seed];
  ST.capture.ink.tol = 38;
  const b = ST.capture.lastDemo.letterBox;
  const W = ST.capture.img.width, H = ST.capture.img.height;
  const x0 = Math.max(4, b.x - 30), y0 = Math.max(4, b.y - 30);
  const x1 = Math.min(W - 4, b.x + b.w + 30), y1 = Math.min(H - 4, b.y + b.h + 30);
  ST.capture.lasso = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  ST.capture.runExtraction(false);
  const ex = ST.capture.extract;
  ST.capture.ink.mode = 'luma';
  ST.capture.ink.seeds = [];
  ST.capture.clearLasso();
  return { paths: ex ? ex.paths.length : 0, ink: ex ? ex.inkCount : 0 };
});
check(colorPick.paths >= 1 && colorPick.ink > 2000,
  `pick-paint traced the warped E (${colorPick.paths} contours, ${colorPick.ink}px)`);

// ---- HEIC intake ----------------------------------------------------------------
console.log('\n— HEIC (vendored libheif decode)');
await page.setInputFiles('#fileInput', path.join(ROOT, 'test', 'fixtures', 'letter-L.heic'));
await page.waitForFunction(() => ST.capture.img && ST.capture.img.width === 480, { timeout: 30000 });
const heicRes = await page.evaluate(() => {
  ST.capture.skipFlatten();
  ST.capture.lasso = [{ x: 120, y: 30 }, { x: 360, y: 30 }, { x: 360, y: 330 }, { x: 120, y: 330 }];
  ST.capture.runExtraction(true);
  const ex = ST.capture.extract;
  return { paths: ex ? ex.paths.length : 0, ink: ex ? ex.inkCount : 0, ok: __st.tagAndSubmit('L') };
});
check(heicRes.paths >= 1 && heicRes.ok, `HEIC decoded, L traced (${heicRes.ink}px ink) and submitted`);

// ---- auto flow: photo-at-a-time review, no guessing ------------------------------
console.log('\n— auto capture + review queue');
const autoRes = await page.evaluate(() => __st.autoFromDemo('T'));
check(autoRes.candidates >= 1, `auto pipeline found ${autoRes.candidates} candidate(s) on a demo wall`);
await page.evaluate(() => ST.batch.reopen());
await page.waitForTimeout(250);
const revState = await page.evaluate(() => ({
  open: document.getElementById('reviewModal').classList.contains('open'),
  hint: document.getElementById('reviewHint').textContent,
  progress: document.getElementById('reviewProgress').textContent,
}));
check(revState.open, 'review modal opened straight onto the traced shape');
check(/Shape 1 of/.test(revState.hint), `hint shows shape count (“${revState.hint.slice(0, 48)}…”)`);
await page.screenshot({ path: path.join(SHOTS, 'review.png') });
const beforeT = await page.evaluate(() => (ST.store.slot('T') ? ST.store.slot('T').variants.length : 0));
await page.fill('#reviewChar', 'T');
await page.click('#reviewAccept');
await page.waitForTimeout(250);
const afterT = await page.evaluate(() => (ST.store.slot('T') ? ST.store.slot('T').variants.length : 0));
check(afterT === beforeT + 1, 'Add to typeface stored the letterform');
const closedAfter = await page.evaluate(() => !document.getElementById('reviewModal').classList.contains('open'));
check(closedAfter, 'accepting the only photo finishes the queue');

// click-to-trace: click the letter in the photo pane → seeded extraction
console.log('\n— click-to-trace + studio auto-advance');
const clickInfo = await page.evaluate(() => {
  const wall = ST.demo.makeWall('N', 999);
  ST.batch.addCanvas(wall.canvas, 'click-n');
  ST.batch.reopen();
  const b = wall.letterBox;
  const item = ST.batch.queue[ST.batch.idx];
  // demo walls draw the letter centred in letterBox; the N's diagonal
  // passes through the centre
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const before = item.candidates.length;
  const n = ST.batch.clickTrace(cx, cy);
  const cnv = document.getElementById('reviewSource');
  const rect = cnv.getBoundingClientRect();
  const s = Math.min(cnv.width / item.canvas.width, cnv.height / item.canvas.height);
  const ox = (cnv.width - item.canvas.width * s) / 2, oy = (cnv.height - item.canvas.height * s) / 2;
  return {
    n, before, after: item.candidates.length,
    kind: item.candidates[0].kind,
    hint: document.getElementById('reviewHint').textContent,
    screen: {
      x: rect.left + (ox + cx * s) * (rect.width / cnv.width),
      y: rect.top + (oy + cy * s) * (rect.height / cnv.height),
    },
  };
});
check(clickInfo.n >= 1 && clickInfo.after > clickInfo.before,
  `clickTrace grew a traced letterform from one click (${clickInfo.n} candidate(s), kind ${clickInfo.kind})`);
check(/Shape 1 of/.test(clickInfo.hint), 'clicked shape becomes the current one');
await page.mouse.click(clickInfo.screen.x, clickInfo.screen.y);
await page.waitForTimeout(400);
const afterRealClick = await page.evaluate(() => ST.batch.queue[ST.batch.idx].candidates.length);
check(afterRealClick > clickInfo.after, 'a real click on the photo pane traces too');
// cut gesture through the N's middle: region shrinks, Undo restores
const cutRes = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  const before = ST.raster.count(item.candidates[0].mask);
  const c = item.canvas;
  const cx = item.lastClick.x, cy = item.lastClick.y;
  // a vertical cut just right of the click severs the right stem of the N
  ST.batch.addCut(cx + 45, cy - 260, cx + 45, cy + 260);
  const after = ST.raster.count(item.candidates[0].mask);
  const undoVisible = document.getElementById('reviewUndoCut').style.display !== 'none';
  ST.batch.undoCut();
  const restored = ST.raster.count(item.candidates[0].mask);
  return { before, after, restored, undoVisible, w: c.width };
});
check(cutRes.after < cutRes.before * 0.8 && cutRes.undoVisible,
  `a cut across the letter removes the far side (${cutRes.before} → ${cutRes.after} px)`);
check(cutRes.restored > cutRes.after, `Undo cut regrows the region (${cutRes.restored} px)`);

// isolate: template-guided trim of the typed character
const isoRes = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  const cand = item.candidates[0];
  const found = ST.classify.locate(cand.mask, cand.w, cand.h, 'N');
  document.getElementById('reviewChar').value = 'N';
  document.getElementById('reviewChar').dispatchEvent(new Event('input'));
  const ok = ST.batch.isolate();
  return { found: found ? found.score : 0, ok, kind: item.candidates[0].kind,
    label: document.getElementById('reviewIsolate').textContent };
});
check(isoRes.found > 0.2, `locate scores the N against its templates (${isoRes.found.toFixed(2)})`);
check(isoRes.label === 'Isolate “N”', 'Isolate button names the typed character');
check(isoRes.ok === true && isoRes.kind === 'isolated', 'Isolate produced a trimmed candidate');

await page.fill('#reviewChar', 'N');
await page.click('#reviewAccept');
await page.waitForTimeout(250);
check((await page.evaluate(() => ST.store.slot('N').variants.length)) >= 2, 'click-traced N added');

// fused letters on fibrous paper: a red-marker "F2" whose F touches the 2,
// with a pink bleed halo. Auto and a click in the halo must both stay
// stroke-thin (no solid masses), and Isolate “2” must cut the F off.
console.log('\n— fused marker letters: halo click + Isolate');
const f2Res = await page.evaluate(() => {
  const W = 900, H = 1100;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#ece8e2'; x.fillRect(0, 0, W, H);
  const img = x.getImageData(0, 0, W, H);
  let s = 3;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 22;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  const d2r = Math.PI / 180;
  const a0 = [560 + 150 * Math.cos(200 * d2r), 300 + 140 * Math.sin(200 * d2r)];
  const a1 = [560 + 150 * Math.cos(416 * d2r), 300 + 140 * Math.sin(416 * d2r)];
  const strokes = (lw, style) => {
    x.lineWidth = lw; x.strokeStyle = style; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath();
    x.moveTo(160, 150); x.lineTo(160, 900);
    x.moveTo(160, 160); x.lineTo(470, 160);
    x.moveTo(160, 520); x.lineTo(430, 520);
    x.moveTo(a0[0], a0[1]); x.ellipse(560, 300, 150, 140, 0, 200 * d2r, 416 * d2r);
    x.lineTo(330, 880); x.lineTo(820, 860);
    x.stroke();
  };
  strokes(26 * 4, 'rgba(236,172,176,0.55)'); // bleed halo
  strokes(26, '#b91e2d');
  ST.batch.addCanvas(c, 'f2');
  ST.batch.reopen();
  const item = ST.batch.queue[ST.batch.idx];
  const auto = item.candidates[0];
  const autoFill = auto ? ST.raster.count(auto.mask) / (auto.w * auto.h) : 1;
  // click 18 px right of the 2's diagonal at y=700 — in the halo, not on the paint
  const cx = Math.round(a1[0] + (330 - a1[0]) * ((700 - a1[1]) / (880 - a1[1])));
  const n = ST.batch.clickTrace(cx + 18, 700);
  const clicked = item.candidates[0];
  const clickFill = ST.raster.count(clicked.mask) / (clicked.w * clicked.h);
  const clickedBB = ST.raster.maskBounds(clicked.mask, clicked.w, clicked.h);
  const lc = { x: item.lastClick.x - clicked.crop.x, y: item.lastClick.y - clicked.crop.y };
  const located = ST.classify.isolate(clicked.mask, clicked.w, clicked.h, '2', lc.x, lc.y);
  const strokeInfo = located ? ST.extract.isolateStrokes(clicked.mask, clicked.w, clicked.h, located.margin, lc.x, lc.y) : null;
  document.getElementById('reviewChar').value = '2';
  document.getElementById('reviewChar').dispatchEvent(new Event('input'));
  const ok = ST.batch.isolate();
  const iso = item.candidates[0];
  const bb = ST.raster.maskBounds(iso.mask, iso.w, iso.h);
  return {
    autoFill, n, clickFill, ok, kind: iso.kind, snapped: item.lastClick,
    fusedWidth: clickedBB.w, score: located ? located.score : 0,
    box: located ? located.box : null, strokes: strokeInfo ? { strokes: strokeInfo.strokes, foreign: strokeInfo.foreign } : null,
    left: iso.crop.x + bb.x0, width: bb.w, fill: ST.raster.count(iso.mask) / (bb.w * bb.h),
  };
});
check(f2Res.autoFill < 0.3, `auto keeps marker strokes thin on fibrous paper (fill ${f2Res.autoFill.toFixed(2)} of crop)`);
check(f2Res.n >= 1 && f2Res.clickFill < 0.3 && f2Res.snapped.x <= f2Res.snapped.x && f2Res.fusedWidth > 600,
  `a click in the bleed halo snaps to the paint and traces the fused F2 (fill ${f2Res.clickFill.toFixed(2)}, ${f2Res.fusedWidth} px wide)`);
check(f2Res.ok === true && f2Res.kind === 'isolated', `Isolate “2” found the 2 in the fused shape (match ${f2Res.score.toFixed(2)})`);
check(f2Res.left > 250 && f2Res.width > 480 && f2Res.width < 530,
  `Isolate cut the F off at the join and kept the whole 2, tail included (starts at x=${f2Res.left}, ${f2Res.width} px wide; box ${JSON.stringify(f2Res.box)}, strokes ${JSON.stringify(f2Res.strokes)})`);
check(f2Res.fill < 0.4, `isolated 2 is a stroke shape, not a filled block (fill ${f2Res.fill.toFixed(2)} of its box)`);
await page.screenshot({ path: path.join(SHOTS, 'isolate-2.png') });
await page.evaluate(() => ST.batch.skip());

// a chisel-marker "#" (thick verticals, thin horizontals with fading,
// tapering ends), leaning so it gets auto-straightened, fused with a
// neighbor's diagonal at the top right. Auto must find one fused shape,
// Isolate “#” must cut the diagonal off and keep the whole #, and the thin
// bars must end in round caps rather than needle points.
console.log('\n— chisel marker #: deskew, Isolate, round stroke ends');
const hashRes = await page.evaluate(() => {
  const W = 900, H = 1000;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#eeeae4'; x.fillRect(0, 0, W, H);
  const img = x.getImageData(0, 0, W, H);
  let s = 5;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 24; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  x.putImageData(img, 0, 0);
  const lean = 60;
  const strokes = [
    [[300, 200], [300 + lean, 800], 30, 0.08], [[470, 190], [470 + lean, 800], 30, 0.08],
    [[200, 420], [700, 400], 14, 0.14], [[180, 600], [680, 585], 14, 0.14],
    [[478, 200], [820, 60], 22, 0.1], [[820, 60], [880, 300], 22, 0.1],
  ];
  x.lineCap = 'round';
  for (const [a, b, w] of strokes) {
    x.lineWidth = w + 70; x.strokeStyle = 'rgba(236,170,175,0.45)';
    x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke();
  }
  for (const [a, b, w, taper] of strokes) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.ceil(len / 3);
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n, tm = (t0 + t1) / 2;
      const k = Math.min(1, Math.min(tm, 1 - tm) / taper);
      x.lineWidth = w * (0.35 + 0.65 * Math.sqrt(k));
      x.strokeStyle = `rgba(186,28,44,${(0.45 + 0.55 * k).toFixed(3)})`;
      x.beginPath();
      x.moveTo(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0);
      x.lineTo(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1);
      x.stroke();
    }
  }
  ST.batch.addCanvas(c, 'hash');
  ST.batch.reopen();
  const item = ST.batch.queue[ST.batch.idx];
  const auto = item.candidates[0];
  const out = { angle: item.angle, n: item.candidates.length, autoFill: auto ? ST.raster.count(auto.mask) / (auto.w * auto.h) : 1 };
  document.getElementById('reviewChar').value = '#';
  out.ok = ST.batch.isolate();
  const iso = item.candidates[0];
  const bb = ST.raster.maskBounds(iso.mask, iso.w, iso.h);
  out.kind = iso.kind;
  out.bounds = { x: bb.x0 + iso.crop.x, y: bb.y0 + iso.crop.y, w: bb.w, h: bb.h };
  out.canvasW = item.canvas.width;
  // stroke-end bluntness: the leftmost ink of the isolated shape (a thin
  // bar's tip) and how tall the ink is 6 px in from it
  let tipX = Infinity, tipY = 0;
  for (let y = 0; y < iso.h; y++) for (let xx = 0; xx < iso.w; xx++) if (iso.mask[y * iso.w + xx] && xx < tipX) { tipX = xx; tipY = y; }
  let tall = 0;
  for (let y = 0; y < iso.h; y++) if (iso.mask[y * iso.w + Math.min(iso.w - 1, tipX + 6)]) tall++;
  out.tip = { tall };
  return out;
});
check(hashRes.angle !== 0 && hashRes.n === 1 && hashRes.autoFill < 0.3,
  `leaning # auto-straightened (${hashRes.angle}°) into one thin-stroked shape (fill ${hashRes.autoFill.toFixed(2)})`);
check(hashRes.ok === true && hashRes.kind === 'isolated', 'Isolate “#” accepted the fused shape');
check(hashRes.bounds.w > 400 && hashRes.bounds.w < 560 && hashRes.bounds.x + hashRes.bounds.w < hashRes.canvasW * 0.8,
  `Isolate cut the neighbor's diagonal off and kept the whole # (${hashRes.bounds.w}×${hashRes.bounds.h})`);
check(hashRes.tip.tall >= 9, `thin bars end in round caps, not needle points (${hashRes.tip.tall} px tall 6 px from the tip)`);
await page.screenshot({ path: path.join(SHOTS, 'isolate-hash.png') });
await page.evaluate(() => ST.batch.skip());

// studio round-trip: Edit manually → add in the studio → next photo pops up
await page.evaluate(() => {
  ST.batch.addCanvas(ST.demo.makeWall('E', 1001).canvas, 'studio-e');
  ST.batch.addCanvas(ST.demo.makeWall('T', 1002).canvas, 'studio-t');
  ST.batch.reopen();
});
await page.waitForTimeout(150);
await page.click('#reviewEdit');
await page.waitForTimeout(200);
const inStudio = await page.evaluate(() => ({
  step: ST.capture.step, queued: __st.state().queue,
  open: document.getElementById('reviewModal').classList.contains('open'),
}));
check(inStudio.step === 'ink' && !inStudio.open && inStudio.queued === 2,
  'Edit manually loads the studio and keeps the photo queued');
await page.evaluate(() => __st.tagAndSubmit('E'));
await page.waitForTimeout(500);
const afterStudio = await page.evaluate(() => ({
  queued: __st.state().queue,
  open: document.getElementById('reviewModal').classList.contains('open'),
  progress: document.getElementById('reviewProgress').textContent,
}));
check(afterStudio.queued === 1 && afterStudio.open,
  `studio submit clears that photo and brings up the next (${afterStudio.progress})`);
await page.click('#reviewSkip');
await page.waitForTimeout(200);

// skip-only removal: a photo stays queued through save-for-later
await page.evaluate(() => __st.autoFromDemo('O'));
await page.evaluate(() => ST.batch.reopen());
await page.waitForTimeout(200);
await page.keyboard.press('Escape'); // save for later
await page.waitForTimeout(150);
let queued = await page.evaluate(() => __st.state().queue);
check(queued === 1, 'Esc / save-for-later keeps the photo in the queue');
await page.evaluate(() => ST.batch.reopen());
await page.waitForTimeout(150);
await page.click('#reviewSkip');
await page.waitForTimeout(150);
queued = await page.evaluate(() => __st.state().queue);
check(queued === 0, 'Skip removes the photo from the queue');

// ---- live font + variant cycling ---------------------------------------------
console.log('\n— live font, cycling, kerning');
await page.waitForFunction(() => __st.state().glyphsMapped >= 14 && __st.fontB64(), { timeout: 15000 });
st = await page.evaluate(() => __st.state());
check(st.cycleFonts >= 2, `${st.cycleFonts} font set(s) compiled (base + alternates)`);
const cycLive = await page.evaluate(async () => {
  await document.fonts.ready;
  return document.fonts.check('20px SanstyleCyc1', 'S');
});
check(cycLive, 'alternate cycle font is live');

await page.evaluate(() => __st.switchTab('tester'));
await page.evaluate(() => {
  const t = document.getElementById('tester');
  t.textContent = 'SS SS';
  ST.fontlive.rewrap();
});
await page.waitForTimeout(300);
const spanInfo = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('#tester span.tl'));
  return {
    n: spans.length,
    classes: spans.map((s) => s.className),
    cycled: spans.some((s) => s.classList.contains('cyc1')),
  };
});
check(spanInfo.n === 5, `tester wrapped into ${spanInfo.n} letter spans`);
check(spanInfo.cycled, 'repeated letters use the alternate variant font');

// kern: select second span, arrow right
await page.click('#kernToggle');
const spanBox = await page.locator('#tester span.tl').nth(1).boundingBox();
await page.mouse.click(spanBox.x + spanBox.width / 2, spanBox.y + spanBox.height / 2);
for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
const kerned = await page.evaluate(() => ({
  kerns: { ...ST.fontlive.kerns },
  margin: document.querySelectorAll('#tester span.tl')[1].style.marginLeft,
}));
check(Object.keys(kerned.kerns).length === 1 && kerned.margin.endsWith('em'),
  `arrow keys kerned the letter (${kerned.margin})`);
await page.keyboard.press('Escape');
await page.click('#kernClear');

// tracking to −0.25em, colors, alignment, aspect
await page.fill('#trackRange', '-0.25');
await page.fill('#bgColor', '#0a0a0a');
await page.fill('#fgColor', '#f2f0e9');
await page.click('.align-btn[data-align="center"]');
await page.click('.aspect-btn[data-aspect="9:19.5"]');
await page.waitForTimeout(250);
const visual = await page.evaluate(() => {
  const t = document.getElementById('tester');
  const sheet = document.getElementById('testerSheet');
  return {
    ls: t.style.letterSpacing,
    align: t.style.textAlign,
    bg: sheet.style.background,
    aspect: sheet.style.aspectRatio,
  };
});
check(visual.ls === '-0.25em', `tracking reaches ${visual.ls}`);
check(visual.align === 'center', 'alignment control works');
check(visual.bg.includes('10, 10, 10') || visual.bg.includes('#0a0a0a'), 'background color applied');
check(visual.aspect.replace(/\s/g, '') === '9/19.5', `iPhone canvas aspect (${visual.aspect})`);

await page.evaluate(() => {
  const t = document.getElementById('tester');
  t.textContent = 'SANS\nSTYLE 5#';
  ST.fontlive.rewrap();
});
await page.waitForTimeout(350);
await page.screenshot({ path: path.join(SHOTS, 'tester.png') });

// ---- exports --------------------------------------------------------------------
console.log('\n— exports');
const [svgDl] = await Promise.all([page.waitForEvent('download'), page.click('#expSvg')]);
const svgPath = path.join(TMP, 'specimen.svg');
await svgDl.saveAs(svgPath);
const svgText = readFileSync(svgPath, 'utf8');
check(svgText.startsWith('<svg') && svgText.includes('<path'), 'SVG export contains vector paths');
check(svgText.includes('fill="#f2f0e9"'), 'SVG export uses the chosen text color');

const [pngDl] = await Promise.all([page.waitForEvent('download'), page.click('#expPng')]);
const pngPath = path.join(TMP, 'specimen.png');
await pngDl.saveAs(pngPath);
const pngBytes = readFileSync(pngPath);
check(pngBytes.length > 2000 && pngBytes[0] === 0x89 && pngBytes[1] === 0x50, 'PNG export is a real PNG');

const [jpgDl] = await Promise.all([page.waitForEvent('download'), page.click('#expJpg')]);
const jpgPath = path.join(TMP, 'specimen.jpg');
await jpgDl.saveAs(jpgPath);
const jpgBytes = readFileSync(jpgPath);
check(jpgBytes.length > 2000 && jpgBytes[0] === 0xff && jpgBytes[1] === 0xd8, 'JPG export is a real JPEG');

// ---- TTF download + validation -----------------------------------------------
console.log('\n— download & validate TTF');
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
const dlPath = path.join(TMP, 'e2e-download.ttf');
await download.saveAs(dlPath);
const b64 = await page.evaluate(() => __st.fontB64());
const bytes = Buffer.from(b64, 'base64');
writeFileSync(path.join(TMP, 'e2e-font.ttf'), bytes);
check(Buffer.compare(bytes, readFileSync(dlPath)) === 0, 'download matches compiled bytes');

const font = parse(bytes);
check(font.errors.length === 0, `independent parser: 0 errors ${font.errors.length ? JSON.stringify(font.errors) : ''}`);
for (const ch of ['S', 'A', 'E', 'N', 'O', 'T', 'L', '5', '#', ' ', 's', 'l']) {
  check(font.cmap.get(ch.codePointAt(0)) !== undefined, `cmap maps ${JSON.stringify(ch)}`);
}
try {
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'validate_font.py'), path.join(TMP, 'e2e-font.ttf')], { encoding: 'utf8' });
  check(out.includes('VALID'), 'fontTools round-trip: VALID');
} catch (e) {
  failures++;
  console.error('  ✗ fontTools validation failed:\n', e.stdout || e.message);
}

// ---- glyphs tab screenshot -----------------------------------------------------
await page.evaluate(() => __st.switchTab('glyphs'));
await page.waitForTimeout(250);
await page.click('[data-char="S"]');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(SHOTS, 'glyphs.png') });
await page.click('#drawerClose');

// ---- design playground ----------------------------------------------------------
console.log('\n— design playground');
await page.evaluate(() => __st.switchTab('design'));
await page.fill('#dvPad', '28');
await page.fill('#dvBorder', '2');
await page.waitForTimeout(200);
const designVars = await page.evaluate(() => ({
  pad: getComputedStyle(document.documentElement).getPropertyValue('--pad').trim(),
  bw: getComputedStyle(document.documentElement).getPropertyValue('--bw').trim(),
}));
check(designVars.pad === '28px' && designVars.bw === '2px',
  `design vars live-update (padding ${designVars.pad}, line ${designVars.bw})`);
await page.screenshot({ path: path.join(SHOTS, 'design.png') });
await page.click('#designReset');
await page.waitForTimeout(200);
const resetPad = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--pad').trim());
check(resetPad === '16px', 'design reset restores defaults');

// ---- persistence -----------------------------------------------------------------
console.log('\n— persistence');
await page.reload();
await page.waitForFunction(() => globalThis.__st);
await page.waitForTimeout(500);
const after = await page.evaluate(() => __st.state().chars);
check(after.length >= 9, `library survived reload (${after.length} chars: ${after.join(' ')})`);

check(jsErrors.length === 0, `no JS errors on the page ${jsErrors.length ? '→ ' + jsErrors.slice(0, 3).join(' | ') : ''}`);

// =============================================================================
// Cloud sync against the mock API (fresh browser context = "another device")
// =============================================================================
console.log('\n— cloud sync: passcode gate');
// synthesize two inbox photos with the demo-wall generator on the old page
for (const [ch, id, when] of [['N', 'ph_n_00000001', '2026-08-29T10:00:00Z'], ['T', 'ph_t_00000002', '2026-08-29T09:00:00Z']]) {
  const dataUrl = await page.evaluate((c) => ST.demo.makeWall(c, 424242 + c.charCodeAt(0)).canvas.toDataURL('image/png'), ch);
  cloud.inbox.push({ id, name: `wall-${ch.toLowerCase()}.png`, mimeType: 'image/png', createdTime: when });
  cloud.photoBytes.set(id, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

const ctx2 = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 1.5 });
const page2 = await ctx2.newPage();
const jsErrors2 = [];
page2.on('pageerror', (e) => jsErrors2.push(String(e)));
page2.on('console', (m) => { if (m.type() === 'error' && isRealError(m.text())) jsErrors2.push(m.text()); });

await page2.goto(API_BASE);
await page2.waitForSelector('#gateModal.open', { timeout: 10000 });
check(true, 'passcode gate blocks the app when the api is configured');
await page2.fill('#gateInput', '0000');
await page2.click('#gateForm button[type="submit"]');
await page2.waitForTimeout(300);
const gateErr = await page2.evaluate(() => document.getElementById('gateError').textContent);
check(gateErr.length > 0, `wrong passcode rejected (“${gateErr}”)`);
await page2.fill('#gateInput', '3754');
await page2.click('#gateForm button[type="submit"]');
await page2.waitForFunction(() => !document.getElementById('gateModal').classList.contains('open'), { timeout: 10000 });
check(true, 'correct passcode unlocks');

console.log('\n— cloud sync: inbox extraction');
await page2.waitForSelector('#inboxModal.open', { timeout: 10000 });
const inboxText = await page2.evaluate(() => document.getElementById('inboxCount').textContent);
check(inboxText.includes('2'), `inbox prompt: “${inboxText}”`);
await page2.screenshot({ path: path.join(SHOTS, 'sync.png') });
await page2.click('#inboxExtract');
// first photo appears as soon as it's fetched+analyzed (incremental intake)
await page2.waitForFunction(() =>
  document.getElementById('reviewModal').classList.contains('open') &&
  document.getElementById('reviewBody').style.display !== 'none', { timeout: 20000 });
for (let p = 0; p < 2; p++) {
  const ch = await page2.evaluate(() =>
    /wall-n/.test(ST.batch.queue[ST.batch.idx].name) ? 'N' : 'T');
  await page2.fill('#reviewChar', ch);
  await page2.click('#reviewAccept');
  await page2.waitForTimeout(350);
}
const acceptedChars = await page2.evaluate(() => __st.state().chars);
check(acceptedChars.includes('N') && acceptedChars.includes('T'), `Drive photos became glyphs (${acceptedChars.join(' ')})`);

await pollCloud('library.json pushed to Drive with N and T', () =>
  cloud.library && cloud.library.glyphs && cloud.library.glyphs.N && cloud.library.glyphs.T);
await pollCloud('SVG mirrors written for every variant', () => cloud.svgs.size >= 2);
await pollCloud('both inbox photos marked processed', () =>
  cloud.library && ['ph_n_00000001', 'ph_t_00000002'].every((id) => (cloud.library.processedPhotos || []).includes(id)));
const oneSvg = [...cloud.svgs.values()][0];
check(oneSvg && oneSvg.content.startsWith('<svg') && oneSvg.content.includes('data-char'),
  `mirrored SVGs are standalone letterforms (${oneSvg && oneSvg.name})`);
check(!JSON.stringify(cloud.library).includes('data:image'), 'thumbs stay local (not pushed to Drive)');

console.log('\n— cloud sync: restore on a wiped device');
await page2.evaluate(() => localStorage.removeItem('sanstyle.library.v1'));
await page2.reload();
await page2.waitForFunction(() =>
  globalThis.__st &&
  !document.getElementById('gateModal').classList.contains('open') &&
  __st.state().chars.length >= 2, { timeout: 15000 });
const restored = await page2.evaluate(() => __st.state().chars);
check(restored.includes('N') && restored.includes('T'), `library restored from Drive (${restored.join(' ')})`);
await page2.waitForTimeout(1600);
const reprompt = await page2.evaluate(() => document.getElementById('inboxModal').classList.contains('open'));
check(!reprompt, 'processed photos are not offered again');

console.log('\n— cloud sync: site upload → Drive inbox');
await page2.setInputFiles('#autoInput', path.join(ROOT, 'test', 'fixtures', 'letter-L.heic'));
await pollCloud('uploaded photo stored in the Drive inbox', () => cloud.uploads.length === 1, 30000);
check(cloud.uploads[0] && cloud.uploads[0].name.endsWith('.jpg') && cloud.uploads[0].size > 1500,
  `upload is a re-encoded jpeg (${cloud.uploads[0] && cloud.uploads[0].size} bytes)`);
await page2.waitForFunction(() =>
  document.getElementById('reviewModal').classList.contains('open') &&
  document.getElementById('reviewBody').style.display !== 'none', { timeout: 20000 });
await page2.fill('#reviewChar', 'L');
await page2.click('#reviewAccept');
await pollCloud('uploaded letterform synced (L in Drive library)', () =>
  cloud.library && cloud.library.glyphs && cloud.library.glyphs.L);
await pollCloud('uploaded photo marked processed', () =>
  cloud.library && (cloud.library.processedPhotos || []).some((id) => id.startsWith('up_')));

const pillText = await page2.evaluate(() => document.getElementById('syncPill').textContent);
check(pillText === 'Synced', `sync pill reads “${pillText}”`);
check(jsErrors2.length === 0, `no JS errors in the sync session ${jsErrors2.length ? '→ ' + jsErrors2.slice(0, 3).join(' | ') : ''}`);
await ctx2.close();

await browser.close();
server.close();
apiServer.close();

console.log(failures === 0 ? '\nE2E: ALL CHECKS PASSED' : `\nE2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
