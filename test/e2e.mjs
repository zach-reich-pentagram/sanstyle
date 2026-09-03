/* Sanstyle end-to-end: drives the real app in headless Chromium.
 * Covers the capture flow on the stage (demo walls, HEIC intake, the review
 * queue, click-to-trace, cuts, shift-click pieces, Isolate, Detail),
 * ligatures, the weight slider, variant cycling, kerning, exports, and
 * validates every compiled font with an independent parser plus fontTools;
 * then the whole cloud flow against a mock of the api. Regenerates the
 * README screenshots.
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

// ---- Flow A: a demo wall lands on the stage, traced; type S, add ------------
console.log('\n— flow A: demo “S” on the stage → Add to typeface');
await page.evaluate(() => __st.loadDemo('S'));
await page.waitForTimeout(250);
let st = await page.evaluate(() => ({
  s: __st.state(),
  hint: document.getElementById('reviewHint').textContent,
  progress: document.getElementById('reviewProgress').textContent,
  char: document.getElementById('reviewChar').value,
  addOn: !document.getElementById('reviewAccept').disabled,
  shapeStep: document.getElementById('step-shape').classList.contains('active'),
}));
check(st.s.current === 'demo-S' && st.s.shapes >= 1, `demo wall queued and traced on the stage (${st.s.shapes} shape(s))`);
check(/Shape 1 of/.test(st.hint) && /^Photo 1 of 1/.test(st.progress), `stage shows the shape and the progress (“${st.progress}”)`);
check(st.char === 'S' && st.addOn && st.shapeStep, 'demo pre-types its letter; Add is live');
await page.screenshot({ path: path.join(SHOTS, 'capture.png') });
await page.click('#reviewAccept');
await page.waitForTimeout(150);
st = await page.evaluate(() => __st.state());
check(st.chars.includes('S') && st.queue === 0, 'S submitted, queue empty');

// ---- Flow A2: a real click on the stage re-traces; second S variant -----------
console.log('\n— flow A2: a click on the stage traces the letter under it');
await page.evaluate(() => __st.loadDemo('S'));
await page.waitForTimeout(200);
const clickAt = await page.evaluate(() => {
  const b = ST.capture.lastDemo.letterBox;
  const r = document.getElementById('stage').getBoundingClientRect();
  const sp = ST.capture.toScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  return { x: r.left + sp.x, y: r.top + sp.y, before: ST.capture.item.candidates.length };
});
await page.mouse.click(clickAt.x, clickAt.y);
await page.waitForTimeout(400);
const afterClick = await page.evaluate(() => ({
  n: ST.capture.item.candidates.length, kind: ST.capture.item.candidates[0].kind, paths: ST.capture.cand.paths.length,
}));
check(afterClick.n > clickAt.before && afterClick.paths >= 1,
  `a real click on the stage traced the S (${afterClick.n} shapes, kind ${afterClick.kind})`);
check(await page.evaluate(() => __st.tagAndSubmit('S')), 'second S variant submitted');
const sVariants = await page.evaluate(() => ST.store.slot('S').variants.length);
check(sVariants === 2, `S now has ${sVariants} variants`);

// ---- Flow B: the rest of the demo letters via hooks ---------------------------
console.log('\n— flow B: capture A E N O T 5 #');
for (const ch of ['A', 'E', 'N', 'O', 'T', '5', '#']) {
  const r = await page.evaluate((c) => {
    __st.loadDemo(c);
    const shapes = __st.state().shapes;
    return { shapes, ok: __st.tagAndSubmit(c) };
  }, ch);
  check(r.ok && r.shapes >= 1, `“${ch}”: ${r.shapes} shape(s) → submitted`);
}

// ---- HEIC intake ----------------------------------------------------------------
console.log('\n— HEIC (vendored libheif decode)');
await page.setInputFiles('#fileInput', path.join(ROOT, 'test', 'fixtures', 'letter-L.heic'));
await page.waitForFunction(() => ST.capture.item && /letter-L/.test(ST.capture.item.name), { timeout: 30000 });
const heicRes = await page.evaluate(() => ({
  shapes: __st.state().shapes, w: ST.capture.item.canvas.width, ok: __st.tagAndSubmit('L'),
}));
check(heicRes.shapes >= 1 && heicRes.ok, `HEIC decoded (${heicRes.w} px wide on the stage), L traced and submitted`);

// ---- auto flow: photo-at-a-time review on the stage --------------------------------
console.log('\n— auto capture + review queue');
const autoRes = await page.evaluate(() => __st.autoFromDemo('T'));
check(autoRes.candidates >= 1, `auto pipeline found ${autoRes.candidates} candidate(s) on a demo wall`);
await page.evaluate(() => ST.batch.reopen());
await page.waitForTimeout(250);
const revState = await page.evaluate(() => ({
  current: __st.state().current,
  hint: document.getElementById('reviewHint').textContent,
  progress: document.getElementById('reviewProgress').textContent,
  tab: document.getElementById('tab-capture').classList.contains('active'),
}));
check(revState.current === 'demo-T' && revState.tab, 'the queued photo shows on the capture stage');
check(/Shape 1 of/.test(revState.hint), `hint shows shape count (“${revState.hint.slice(0, 48)}…”)`);
const beforeT = await page.evaluate(() => (ST.store.slot('T') ? ST.store.slot('T').variants.length : 0));
await page.fill('#reviewChar', 'T');
await page.click('#reviewAccept');
await page.waitForTimeout(250);
const afterT = await page.evaluate(() => (ST.store.slot('T') ? ST.store.slot('T').variants.length : 0));
check(afterT === beforeT + 1, 'Add to typeface stored the letterform');
const emptyAfter = await page.evaluate(() => ({
  queue: __st.state().queue, current: __st.state().current, hint: document.getElementById('stageHint').textContent,
}));
check(emptyAfter.queue === 0 && emptyAfter.current === null, `accepting the only photo empties the stage (“${emptyAfter.hint}”)`);

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
  const rect = document.getElementById('stage').getBoundingClientRect();
  const sp = ST.capture.toScreen({ x: cx, y: cy });
  return {
    n, before, after: item.candidates.length,
    kind: item.candidates[0].kind,
    hint: document.getElementById('reviewHint').textContent,
    screen: { x: rect.left + sp.x, y: rect.top + sp.y },
  };
});
check(clickInfo.n >= 1 && clickInfo.after > clickInfo.before,
  `clickTrace grew a traced letterform from one click (${clickInfo.n} candidate(s), kind ${clickInfo.kind})`);
check(/Shape 1 of/.test(clickInfo.hint), 'clicked shape becomes the current one');
await page.mouse.click(clickInfo.screen.x, clickInfo.screen.y);
await page.waitForTimeout(400);
const afterRealClick = await page.evaluate(() => ST.batch.queue[ST.batch.idx].candidates.length);
check(afterRealClick > clickInfo.after, 'a real click on the stage traces too');
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

// Shift-click adds a piece: after a cut severs the right stem, a shift-click
// on the severed stem brings just that piece back; a shift-click on ink
// already in the shape adds nothing
const partRes = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  const whole = item.candidates[0];
  const before = ST.raster.count(whole.mask);
  const cx = item.lastClick.x, cy = item.lastClick.y;
  ST.batch.addCut(cx + 45, cy - 260, cx + 45, cy + 260);
  const cut = ST.raster.count(item.candidates[0].mask);
  const same = ST.batch.addPart(cx, cy);
  const afterSame = ST.raster.count(item.candidates[0].mask);
  // the rightmost ink of the whole N level with the click: its right stem
  const row = Math.round(cy - whole.crop.y);
  let tx = -1;
  for (let x = whole.w - 1; x >= 0; x--) if (whole.mask[row * whole.w + x]) { tx = x; break; }
  const target = { x: whole.crop.x + tx - 6, y: cy };
  const rect = document.getElementById('stage').getBoundingClientRect();
  const sp = ST.capture.toScreen(target);
  return { before, cut, same, afterSame, target, screen: { x: rect.left + sp.x, y: rect.top + sp.y } };
});
check(partRes.same === 0 && partRes.afterSame === partRes.cut, 'shift-click on ink already in the shape adds nothing');
await page.keyboard.down('Shift');
await page.mouse.click(partRes.screen.x, partRes.screen.y);
await page.keyboard.up('Shift');
await page.waitForTimeout(400);
const merged = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  const c = item.candidates[0];
  return { kind: c.kind, ink: ST.raster.count(c.mask), parts: (item.parts || []).length, paths: c.paths.length };
});
check(merged.kind === 'parts' && merged.parts === 1 && merged.ink > partRes.cut * 1.25 && merged.ink >= partRes.before * 0.85,
  `shift-click brings the severed stem back into the shape (${partRes.cut} → ${merged.ink} px of ${partRes.before})`);
const undone = await page.evaluate(() => {
  ST.batch.undoCut();
  const item = ST.batch.queue[ST.batch.idx];
  return { ink: ST.raster.count(item.candidates[0].mask), cuts: item.cuts.length, parts: item.parts.length };
});
check(undone.cuts === 0 && undone.parts === 1 && undone.ink >= partRes.before * 0.95,
  `Undo cut after a shift-click restores the whole letter (${undone.ink} px)`);

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

// two photos queued: adding one brings up the next; a photo leaves the queue
// only through Add or Skip, and waits on the stage across tab switches
await page.evaluate(() => {
  ST.batch.addCanvas(ST.demo.makeWall('E', 1001).canvas, 'two-e');
  ST.batch.addCanvas(ST.demo.makeWall('T', 1002).canvas, 'two-t');
});
await page.waitForTimeout(150);
await page.evaluate(() => __st.tagAndSubmit('E'));
await page.waitForTimeout(200);
const afterFirst = await page.evaluate(() => ({
  queued: __st.state().queue, current: __st.state().current, progress: document.getElementById('reviewProgress').textContent,
}));
check(afterFirst.queued === 1 && afterFirst.current === 'two-t', `adding one photo brings up the next (${afterFirst.progress})`);
await page.evaluate(() => { __st.switchTab('tester'); __st.switchTab('capture'); });
await page.waitForTimeout(100);
const stillThere = await page.evaluate(() => ({
  queued: __st.state().queue, current: __st.state().current, pill: document.getElementById('queuePill').textContent,
}));
check(stillThere.queued === 1 && stillThere.current === 'two-t' && /1/.test(stillThere.pill),
  `leaving and returning keeps the photo on the stage (pill “${stillThere.pill}”)`);
await page.click('#reviewSkip');
await page.waitForTimeout(150);
const queued = await page.evaluate(() => __st.state().queue);
check(queued === 0, 'Skip removes the photo from the queue');

// Detail knob re-extracts; a cut with no click keeps the bigger side
const cutSide = await page.evaluate(() => {
  const wall = ST.demo.makeWall('L', 321);
  ST.batch.addCanvas(wall.canvas, 'cut-l');
  ST.batch.reopen();
  const item = ST.batch.queue[ST.batch.idx];
  ST.batch.setDetail(8);
  const detail = { detail: item.detail, slider: document.getElementById('reviewDetail').value, n: item.candidates.length };
  const cand = item.candidates[0];
  const bb = ST.raster.maskBounds(cand.mask, cand.w, cand.h);
  // a level cut through the L's stem a fifth of the way down: the top
  // fifth is the small piece, the rest of the stem plus the foot the letter
  const y = cand.crop.y + bb.y0 + bb.h * 0.2;
  const before = ST.raster.count(cand.mask);
  ST.batch.addCut(cand.crop.x + bb.x0 - 10, y, cand.crop.x + bb.x1 + 10, y);
  const after = item.candidates[0];
  const abb = ST.raster.maskBounds(after.mask, after.w, after.h);
  ST.batch.skip();
  return { detail, before, after: ST.raster.count(after.mask), keptTop: after.crop.y + abb.y0, cutY: y };
});
check(cutSide.detail.detail === 8 && cutSide.detail.slider === '8' && cutSide.detail.n >= 1, 'Detail knob re-extracts the photo at the new setting');
check(cutSide.after < cutSide.before && cutSide.after > cutSide.before * 0.5 && cutSide.keptTop > cutSide.cutY - 5,
  `a cut with no click keeps the larger side (${cutSide.before} → ${cutSide.after} px; kept piece starts below the cut)`);

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

// ---- ligatures, weight slider, source popup ----------------------------------
console.log('\n— ligatures, weight slider, source popup');
const ligRes = await page.evaluate(async () => {
  const P = (x, y) => ({ x, y });
  const line = (a, b) => [a, P(a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3), P(a.x + 2 * (b.x - a.x) / 3, a.y + 2 * (b.y - a.y) / 3), b];
  const rect = (x0, y0, x1, y1) => ({ cubics: [line(P(x0, y0), P(x1, y0)), line(P(x1, y0), P(x1, y1)), line(P(x1, y1), P(x0, y1)), line(P(x0, y1), P(x0, y0))] });
  const M = ST.metrics;
  // an "a" in two weights, plus an "ar" ligature drawn as one wide block
  const thin = M.buildRecord('a', [rect(0, 0, 16, 100)]);
  const fat = M.buildRecord('a', [rect(0, 0, 70, 100)]);
  const lig = M.buildRecord('ar', [rect(0, 0, 400, 100)]);
  ST.store.addVariant('a', thin);
  ST.store.addVariant('a', fat);
  ST.store.addVariant('ar', lig);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await ST.sources.put(lig.id, png);
  await ST.fontlive.rebuild();
  await document.fonts.ready;
  const t = document.getElementById('tester');
  t.textContent = 'ar a r';
  ST.fontlive.rewrap();
  const spans = Array.from(document.querySelectorAll('#tester span.tl'));
  const c = document.createElement('canvas').getContext('2d');
  c.font = '100px SanstyleLive';
  const w = (s) => c.measureText(s).width;
  return {
    ids: { thin: thin.id, fat: fat.id, lig: lig.id }, png,
    spans: spans.map((s) => ({ text: s.textContent, lig: s.dataset.lig || null, i: s.dataset.i })),
    wAR: w('ar'), wA: w('a'), wR: w('r'), ligAdvance: M.finalizeVariant(lig).advance,
    coverage: document.getElementById('coverage').textContent,
    meta: document.getElementById('compileMeta').textContent,
    fromLoaded: (await ST.sources.get(lig.id)) === png,
  };
});
check(ligRes.spans.length === 5 && ligRes.spans[0].lig === 'ar' && ligRes.spans[0].text === 'ar' && ligRes.spans[2].text === 'a' && ligRes.spans[2].i === '3',
  `tester keeps a captured ligature's letters in one span (${ligRes.spans.map((s) => s.text).join('|')})`);
check(Math.abs(ligRes.wAR - ligRes.ligAdvance / 10) < 3 && Math.abs(ligRes.wAR - (ligRes.wA + ligRes.wR)) > 20,
  `typing "ar" shapes the ligature glyph through GSUB (${ligRes.wAR.toFixed(1)} px = its advance ${(ligRes.ligAdvance / 10).toFixed(1)}, not a+r ${(ligRes.wA + ligRes.wR).toFixed(1)})`);
check(ligRes.coverage === 'Missing: r', `coverage counts the r inside "ar" as covered (“${ligRes.coverage}”)`);
check(ligRes.meta.includes('1 ligature'), `tester meta lists the ligature (“${ligRes.meta}”)`);
check(ligRes.fromLoaded, 'source crop stored and read back');

await page.check('#weightToggle');
await page.waitForTimeout(500);
const weightOn = await page.evaluate(() => ({
  sets: ST.fontlive.glyphMaps.length,
  cycleParked: document.getElementById('cycleToggle').disabled,
  rangeOn: !document.getElementById('weightRange').disabled,
}));
check(weightOn.sets === 1 && weightOn.cycleParked && weightOn.rangeOn, 'weight mode compiles one set and parks variant cycling');
await page.fill('#weightRange', '0');
await page.waitForTimeout(500);
const lightPick = await page.evaluate(() => ST.fontlive.glyphMaps[0].get(97).id);
await page.fill('#weightRange', '100');
await page.waitForTimeout(500);
const heavyPick = await page.evaluate(() => ({ id: ST.fontlive.glyphMaps[0].get(97).id, meta: document.getElementById('compileMeta').textContent }));
check(lightPick === ligRes.ids.thin && heavyPick.id === ligRes.ids.fat, 'weight slider swaps the a from its thin variant to its fat one');
check(heavyPick.meta.includes('weight 100%'), `tester meta reports the weight (“${heavyPick.meta}”)`);
await page.uncheck('#weightToggle');
await page.waitForTimeout(500);
const weightOff = await page.evaluate(() => ({ sets: ST.fontlive.glyphMaps.length, id: ST.fontlive.glyphMaps[0].get(97).id }));
check(weightOff.sets > 1 && weightOff.id === ligRes.ids.fat, 'weight off: active picks and cycling alternates return');

await page.locator('#tester span.tl').first().hover();
await page.waitForSelector('.src-pop.on', { timeout: 3000 });
const popInfo = await page.evaluate(() => {
  const p = document.querySelector('.src-pop.on');
  return p ? { src: p.querySelector('img').src, label: p.querySelector('.src-pop-label').textContent } : null;
});
check(popInfo && popInfo.src === ligRes.png && popInfo.label === 'ar', 'hovering a letterform pops up the photo it was cut from');
await page.mouse.move(5, 5);
await page.waitForTimeout(150);
check(await page.evaluate(() => !document.querySelector('.src-pop.on')), 'the popup hides when the pointer leaves');
await page.evaluate(() => {
  const t = document.getElementById('tester');
  t.textContent = 'SANS\nSTYLE 5#';
  ST.fontlive.rewrap();
});

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
// first photo lands on the stage as soon as it's fetched+analyzed (incremental intake)
await page2.waitForFunction(() => __st.state().current !== null, { timeout: 20000 });
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
await page2.setInputFiles('#fileInput', path.join(ROOT, 'test', 'fixtures', 'letter-L.heic'));
await pollCloud('uploaded photo stored in the Drive inbox', () => cloud.uploads.length === 1, 30000);
check(cloud.uploads[0] && cloud.uploads[0].name.endsWith('.jpg') && cloud.uploads[0].size > 1500,
  `upload is a re-encoded jpeg (${cloud.uploads[0] && cloud.uploads[0].size} bytes)`);
await page2.waitForFunction(() => __st.state().current !== null, { timeout: 20000 });
await page2.fill('#reviewChar', 'L');
await page2.click('#reviewAccept');
await pollCloud('uploaded letterform synced (L in Drive library)', () =>
  cloud.library && cloud.library.glyphs && cloud.library.glyphs.L);
await pollCloud('uploaded photo marked processed', () =>
  cloud.library && (cloud.library.processedPhotos || []).some((id) => id.startsWith('up_')));

console.log('\n— cloud sync: Drive photo gallery + re-scan');
// a fourth photo nobody has extracted from yet
const freshUrl = await page.evaluate(() => ST.demo.makeWall('E', 777).canvas.toDataURL('image/png'));
cloud.inbox.push({ id: 'ph_e_00000009', name: 'wall-e.png', mimeType: 'image/png', createdTime: '2026-08-28T09:00:00Z' });
cloud.photoBytes.set('ph_e_00000009', Buffer.from(freshUrl.split(',')[1], 'base64'));
await page2.evaluate(() => __st.switchTab('glyphs'));
await page2.waitForFunction(() => document.querySelectorAll('.photo-card').length >= 4, { timeout: 15000 });
const gallery = await page2.evaluate(() =>
  Array.from(document.querySelectorAll('.photo-card')).map((c) => ({ id: c.dataset.photo, done: c.classList.contains('done') })));
check(gallery.length === 4 && gallery.filter((c) => c.done).length === 3 && gallery.some((c) => c.id === 'ph_e_00000009' && !c.done),
  `Glyphs tab lists every Drive photo, used ones grayed, the new one not (${gallery.map((c) => (c.done ? 'used' : 'new')).join(' ')})`);
await page2.waitForFunction(() =>
  Array.from(document.querySelectorAll('.photo-card img')).every((i) => i.src.startsWith('blob:') && i.naturalWidth > 0), { timeout: 15000 });
check(true, 'photo thumbnails loaded through the api');
await page2.click('.photo-card[data-photo="ph_n_00000001"]');
await page2.waitForFunction(() => ST.capture.item && ST.capture.item.sourceId === 'ph_n_00000001', { timeout: 20000 });
const reQ = await page2.evaluate(() => ({
  tab: document.getElementById('tab-capture').classList.contains('active'), shapes: __st.state().shapes,
}));
check(reQ.tab && reQ.shapes >= 1, 'clicking a used photo puts it back on the capture stage, traced');
await page2.click('#reviewSkip');
await page2.waitForTimeout(150);
await page2.click('#rescanBtn');
await page2.waitForFunction(() => ST.batch.remaining() >= 4, { timeout: 30000 });
check(true, 'Re-scan Drive photos queues every photo again');
await page2.evaluate(() => { while (ST.batch.remaining()) ST.batch.skip(); });

const pillText = await page2.evaluate(() => document.getElementById('syncPill').textContent);
check(pillText === 'Synced', `sync pill reads “${pillText}”`);
check(jsErrors2.length === 0, `no JS errors in the sync session ${jsErrors2.length ? '→ ' + jsErrors2.slice(0, 3).join(' | ') : ''}`);
await ctx2.close();

await browser.close();
server.close();
apiServer.close();

console.log(failures === 0 ? '\nE2E: ALL CHECKS PASSED' : `\nE2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
