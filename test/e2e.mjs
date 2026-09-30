/* Sanstyle end-to-end: drives the real app in headless Chromium.
 * Covers the capture flow on the stage (demo walls, HEIC intake, the photo
 * analysis — paints by color, flattening — the letter strip, the review
 * queue, clicks answered from the analysis, crop, Reset, cuts, shift-click
 * pieces, Option-click removal, undo), ligatures, the weight slider,
 * variant cycling, kerning, exports, and
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
  executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium',
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

// Page-side helpers for the capture checks. A photo is read at a working
// size (800 px on its long edge) and, when its wall's lines agree, flattened
// (item.rect): a spot on a test photo is found on the stage through both.
await page.addInitScript(() => {
  globalThis.__e2e = {
    // photo px → px on its queue item's canvas
    at(item, srcW, x, y) {
      if (item.rect && item.rect.H) {
        const s = item.rect.srcW / srcW, p = ST.rectify.apply(item.rect.H, x * s, y * s);
        return { x: p[0], y: p[1] };
      }
      const k = item.canvas.width / srcW;
      return { x: x * k, y: y * k };
    },
    // …and back
    src(item, srcW, x, y) {
      if (item.rect && item.rect.H) {
        const s = item.rect.srcW / srcW, p = ST.rectify.apply(ST.rectify.inv3(item.rect.H), x, y);
        return { x: p[0] / s, y: p[1] / s };
      }
      const k = item.canvas.width / srcW;
      return { x: x / k, y: y / k };
    },
    // a shape's ink bounds in photo px
    bounds(item, srcW, c) {
      const bb = ST.raster.maskBounds(c.mask, c.w, c.h);
      const a = this.src(item, srcW, c.crop.x + bb.x0, c.crop.y + bb.y0), b = this.src(item, srcW, c.crop.x + bb.x1, c.crop.y + bb.y1);
      return { x0: Math.round(a.x), y0: Math.round(a.y), x1: Math.round(b.x), y1: Math.round(b.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) };
    },
    // canvas px → page px on the stage
    screen(p) {
      const r = document.getElementById('stage').getBoundingClientRect(), sp = ST.capture.toScreen(p);
      return { x: r.left + sp.x, y: r.top + sp.y };
    },
  };
});
// the stage is busy (cursor “progress”) while a click, cut, piece or undo is
// worked out in the background worker
const idle = () => page.waitForFunction(() => document.getElementById('stage').style.cursor !== 'progress', null, { timeout: 20000 }).catch(() => {});
// a photo uploaded through the file input, analyzed in the worker; with the
// queue empty it lands on the stage
async function upload(name, dataUrl) {
  const n0 = await page.evaluate(() => ST.batch.queue.length);
  await page.setInputFiles('#fileInput', { name, mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
  await page.waitForFunction((n) => ST.batch.queue.length > n && !ST.batch.intakeActive, n0, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(100);
}

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
  stripHidden: document.getElementById('letterStrip').hidden,
}));
check(st.s.current === 'demo-S' && st.s.shapes >= 1, `demo wall queued and traced on the stage (${st.s.shapes} shape(s))`);
check(/click it in the photo/i.test(st.hint) && /^Photo 1 of 1/.test(st.progress), `stage shows the shape, what to do with it, and the progress (“${st.progress}”)`);
check(st.s.shapes < 2 ? st.stripHidden : !st.stripHidden,
  `the letter strip shows only when there is more than one shape to pick (${st.s.shapes} shape(s), strip ${st.stripHidden ? 'hidden' : 'shown'})`);
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
  const wall = ST.capture.lastDemo, b = wall.letterBox, item = ST.batch.queue[ST.batch.idx];
  const p = __e2e.at(item, wall.canvas.width, b.x + b.w / 2, b.y + b.h / 2);
  return Object.assign(__e2e.screen(p), { before: item.candidates.length });
});
await page.mouse.click(clickAt.x, clickAt.y);
await page.waitForFunction((n) => ST.capture.item.candidates.length > n, clickAt.before, { timeout: 8000 }).catch(() => {});
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
  shapes: __st.state().shapes, w: ST.capture.item.canvas.width, analysis: ST.capture.item.analysis, ok: __st.tagAndSubmit('L'),
}));
check(heicRes.shapes >= 1 && heicRes.ok, `HEIC decoded (${heicRes.w} px wide on the stage), L traced and submitted`);
check(typeof heicRes.analysis === 'number', `an uploaded photo is analyzed in the background worker, which keeps the analysis for clicks (analysis #${heicRes.analysis})`);

// ---- the analysis: light evened out, paints told apart, flattening ------------
console.log('\n— analysis: paints told apart by color in uneven light, the letter strip, flattening');
// two tags in two paints on pocked concrete, a shadow across the left: each
// paint is read on its own (auto.inks clusters by color) and each letter found
const twoUrl = await page.evaluate(() => {
  const W = 1100, H = 700;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#d9d4ca'; x.fillRect(0, 0, W, H);
  let s = 11;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  x.fillStyle = 'rgba(90,86,80,0.8)'; // pocks
  for (let i = 0; i < 260; i++) { x.beginPath(); x.arc(rnd() * W, rnd() * H, 1 + rnd() * 2.5, 0, Math.PI * 2); x.fill(); }
  x.lineCap = 'round'; x.lineJoin = 'round'; x.lineWidth = 42;
  x.strokeStyle = 'rgb(28,70,170)';
  x.beginPath(); x.moveTo(110, 170); x.lineTo(450, 170); x.moveTo(280, 170); x.lineTo(280, 560); x.stroke();
  x.strokeStyle = 'rgb(200,40,36)';
  x.beginPath(); x.moveTo(700, 150); x.lineTo(700, 560); x.lineTo(960, 560); x.stroke();
  const g = x.createLinearGradient(0, 0, W, 0); // the light: darker to the left
  g.addColorStop(0, 'rgba(0,0,0,0.42)'); g.addColorStop(0.6, 'rgba(0,0,0,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  return c.toDataURL('image/png');
});
await upload('two-paints.png', twoUrl);
const two = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  const W = item.canvas.width, H = item.canvas.height;
  const read = ST.auto.inks(ST.extract.flatData(item.canvas).data, W, H, {});
  const hue = (s) => (s.b > s.r + 60 ? 'blue' : s.r > s.b + 60 ? 'red' : 'gray');
  const btns = Array.from(document.querySelectorAll('#letterStrip .letter-pick'));
  return {
    name: item.name,
    inks: read.inks.filter((k) => k.score >= 0.3).map((k) => hue(k.seed)),
    reads: item.candidates.map((c) => (c.read && c.read.ranked[0] ? c.read.ranked[0].ch : '?')),
    hidden: document.getElementById('letterStrip').hidden,
    labels: btns.map((b) => b.textContent),
    on: btns.map((b) => b.classList.contains('on')),
    hint: document.getElementById('reviewHint').textContent,
  };
});
check(two.name === 'two-paints.png' && two.inks.includes('blue') && two.inks.includes('red'), `the paints are told apart by color (${two.inks.join(', ')})`);
check(two.reads.includes('T') && two.reads.includes('L'), `each paint's letter is found, the shadow across the wall notwithstanding (${two.reads.join(' ')})`);
check(!two.hidden && two.labels.length === Math.min(12, two.reads.length) && two.on.indexOf(true) === 0 && two.on.filter(Boolean).length === 1 && /Pick the letter below/.test(two.hint),
  `the letter strip offers every letter found (${two.labels.join(' ')}), the current one marked`);
await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.className = ''; }); // (the last photo's “added”)
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(SHOTS, 'letters.png') });
const lIdx = two.reads.indexOf('L');
await page.click(`#letterStrip .letter-pick:nth-child(${lIdx + 1})`);
const pickedL = await page.evaluate((k) => {
  const item = ST.batch.queue[ST.batch.idx];
  const btns = Array.from(document.querySelectorAll('#letterStrip .letter-pick'));
  return { ci: item.ci, shown: ST.capture.cand === item.candidates[k], on: btns.findIndex((b) => b.classList.contains('on')), char: document.getElementById('reviewChar').value };
}, lIdx);
check(pickedL.ci === lIdx && pickedL.shown && pickedL.on === lIdx && pickedL.char === 'L',
  `clicking a letter in the strip picks it: on the stage, marked, its letter filled in (“${pickedL.char}”)`);
const beforeL = await page.evaluate(() => ST.store.slot('L').variants.length);
await page.click('#reviewAccept');
await page.waitForTimeout(150);
const addedL = await page.evaluate(() => ({ n: ST.store.slot('L').variants.length, queue: __st.state().queue }));
check(addedL.n === beforeL + 1 && addedL.queue === 0, 'Add takes the letter picked in the strip');

// a panelled wall shot at an angle: its seams and courses agree on how it
// is foreshortened, and the photo is flattened by them (rectify.js) — the
// letter on it comes out upright
const slantUrl = await page.evaluate(() => {
  const FW = 1000, FH = 760;
  const f = document.createElement('canvas'); f.width = FW; f.height = FH;
  const x = f.getContext('2d');
  x.fillStyle = '#cfc9bd'; x.fillRect(0, 0, FW, FH);
  x.strokeStyle = '#6d675d'; x.lineWidth = 5;
  for (let X = 60; X < FW; X += 220) { x.beginPath(); x.moveTo(X, 0); x.lineTo(X, FH); x.stroke(); }
  for (let Y = 50; Y < FH; Y += 170) { x.beginPath(); x.moveTo(0, Y); x.lineTo(FW, Y); x.stroke(); }
  x.lineCap = 'round'; x.lineJoin = 'round'; x.lineWidth = 46; x.strokeStyle = 'rgb(196,32,40)';
  x.beginPath(); x.moveTo(640, 220); x.lineTo(380, 220); x.lineTo(380, 560); x.lineTo(640, 560); x.moveTo(380, 390); x.lineTo(590, 390); x.stroke();
  // the flat wall seen through a homography: turned 7° about its middle, the top farther away
  const a = (7 * Math.PI) / 180, cx = FW / 2, cy = FH / 2, q = 0.00042;
  const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const Hf = mul([[1, 0, cx], [0, 1, cy], [0, 0, 1]], mul([[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, q, 1]], [[1, 0, -cx], [0, 1, -cy], [0, 0, 1]]));
  const Hi = ST.rectify.inv3(Hf);
  const src = x.getImageData(0, 0, FW, FH).data;
  const c = document.createElement('canvas'); c.width = FW; c.height = FH;
  const cx2 = c.getContext('2d'), img = cx2.createImageData(FW, FH);
  for (let y = 0; y < FH; y++) {
    for (let xx = 0; xx < FW; xx++) {
      const p = ST.rectify.apply(Hi, xx, y), sx = Math.round(p[0]), sy = Math.round(p[1]), o = (y * FW + xx) * 4;
      if (sx < 0 || sy < 0 || sx >= FW || sy >= FH) { img.data[o] = 120; img.data[o + 1] = 130; img.data[o + 2] = 150; } else { const s = (sy * FW + sx) * 4; img.data[o] = src[s]; img.data[o + 1] = src[s + 1]; img.data[o + 2] = src[s + 2]; }
      img.data[o + 3] = 255;
    }
  }
  cx2.putImageData(img, 0, 0);
  globalThis.__slanted = c;
  return c.toDataURL('image/png');
});
await upload('slanted.png', slantUrl);
const flat = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  const c = item.candidates[0];
  // the same photo read as shot, without flattening
  const asShot = ST.auto.processImage(globalThis.__slanted, { deskew: false }).candidates.find((k) => k.read && k.read.ranked[0] && k.read.ranked[0].ch === 'E');
  return {
    name: item.name, rect: item.rect && { tilt: item.rect.tilt, keystone: item.rect.keystone },
    progress: document.getElementById('reviewProgress').textContent,
    read: c && c.read && c.read.ranked[0] ? c.read.ranked[0].ch : '?', lean: c ? c.lean : null, shotLean: asShot ? asShot.lean : null,
  };
});
check(flat.name === 'slanted.png' && flat.rect && Math.abs(Math.abs(flat.rect.tilt) - 7) < 1.5 && flat.rect.keystone > 0.2 && /flattened/.test(flat.progress),
  `a wall shot at an angle is flattened by its own lines (turned ${flat.rect && flat.rect.tilt}°, keystone ${flat.rect && flat.rect.keystone}; “${flat.progress}”)`);
check(flat.read === 'E' && Math.abs(flat.lean) < 2 && Math.abs(flat.shotLean) > Math.abs(flat.lean) + 2,
  `its letter is found first and comes out upright (reads “${flat.read}”, leaning ${flat.lean}° flattened vs ${flat.shotLean}° as shot)`);
await page.evaluate(() => { ST.batch.skip(); delete globalThis.__slanted; });

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
check(/click it in the photo/i.test(revState.hint), `hint says what to do with the shape (“${revState.hint.slice(0, 48)}…”)`);
const beforeT = await page.evaluate(() => (ST.store.slot('T') ? ST.store.slot('T').variants.length : 0));
await page.fill('#reviewChar', 'T');
await page.click('#reviewAccept');
await page.waitForTimeout(250);
const afterT = await page.evaluate(() => (ST.store.slot('T') ? ST.store.slot('T').variants.length : 0));
check(afterT === beforeT + 1, 'Add to typeface stored the letterform');
const emptyAfter = await page.evaluate(() => ({
  queue: __st.state().queue, current: __st.state().current, hint: ST.capture.note,
}));
check(emptyAfter.queue === 0 && emptyAfter.current === null, `accepting the only photo empties the stage (“${emptyAfter.hint}”)`);

// click-to-trace: an uploaded photo is analyzed in the background worker,
// which keeps what it found — a click on the stage is answered from that
console.log('\n— clicks answered from the analysis, crop, Reset, cuts, pieces, undo');
const nWall = await page.evaluate(() => {
  const w = ST.demo.makeWall('N', 999);
  return { url: w.canvas.toDataURL('image/png'), box: w.letterBox, W: w.canvas.width };
});
await upload('click-n.png', nWall.url);
const clickInfo = await page.evaluate((w) => {
  const item = ST.batch.queue[ST.batch.idx];
  // demo walls draw the letter centred in letterBox; the N's diagonal
  // passes through the centre
  const c = __e2e.at(item, w.W, w.box.x + w.box.w / 2, w.box.y + w.box.h / 2);
  return {
    name: item.name, analysis: item.analysis, rect: item.rect, progress: document.getElementById('reviewProgress').textContent,
    c, screen: __e2e.screen(c), before: item.candidates.length,
  };
}, nWall);
check(clickInfo.name === 'click-n.png' && typeof clickInfo.analysis === 'number' && clickInfo.before >= 1,
  `the uploaded photo is on the stage, its analysis kept in the worker (${clickInfo.before} shape(s))`);
check(clickInfo.rect === null && !/flattened/.test(clickInfo.progress), `a wall shot square on is left as it is (“${clickInfo.progress}”)`);
await page.mouse.click(clickInfo.screen.x, clickInfo.screen.y);
await idle();
const fromAnalysis = await page.evaluate((before) => {
  const item = ST.batch.queue[ST.batch.idx];
  const got = item.candidates.slice(0, item.candidates.length - before);
  const auto = item.original.candidates[0];
  const same = (c) => c.crop.x === auto.crop.x && c.crop.y === auto.crop.y && c.w === auto.w && c.h === auto.h && ST.raster.count(c.mask) === ST.raster.count(auto.mask);
  return { n: got.length, kinds: got.map((c) => c.kind).join(' '), fromAnalysis: got.length > 0 && same(got[0]), current: item.ci === 0 && ST.capture.cand === item.candidates[0] };
}, clickInfo.before);
check(fromAnalysis.n >= 1 && fromAnalysis.fromAnalysis,
  `a real click on the stage is answered from the photo's analysis — the letter already found, not grown again (${fromAnalysis.n} shape(s): ${fromAnalysis.kinds})`);
check(fromAnalysis.current, 'the clicked shape becomes the current one');
// on the page, clickTrace grows the letter from the click (extract.seeded,
// what the worker falls back to where the analysis has nothing, or after a cut)
const seededInfo = await page.evaluate((c) => {
  const item = ST.batch.queue[ST.batch.idx];
  const before = item.candidates.length;
  const n = ST.batch.clickTrace(c.x, c.y);
  return { n, grew: item.candidates.length - before, kind: item.candidates[0].kind, paths: item.candidates[0].paths.length };
}, clickInfo.c);
check(seededInfo.n >= 1 && seededInfo.grew === seededInfo.n && seededInfo.paths >= 1,
  `clickTrace grows a traced letterform from one click (extract.seeded: ${seededInfo.n} candidate(s), kind ${seededInfo.kind})`);
// Crop: drag a box with the Crop tool; the photo is cut to it and read
// again, and ⌘Z brings the whole photo back
const cropBox = await page.evaluate(() => {
  const it = ST.batch.queue[ST.batch.idx], c = it.candidates[0];
  return {
    a: __e2e.screen({ x: c.crop.x - 40, y: c.crop.y - 40 }), b: __e2e.screen({ x: c.crop.x + c.crop.w + 40, y: c.crop.y + c.crop.h + 40 }),
    W: it.canvas.width, H: it.canvas.height,
  };
});
await page.click('#toolCrop');
await page.mouse.move(cropBox.a.x, cropBox.a.y); await page.mouse.down();
await page.mouse.move((cropBox.a.x + cropBox.b.x) / 2, (cropBox.a.y + cropBox.b.y) / 2, { steps: 4 });
await page.mouse.move(cropBox.b.x, cropBox.b.y, { steps: 4 }); await page.mouse.up();
await page.waitForFunction((W) => ST.batch.queue[ST.batch.idx].canvas.width !== W, cropBox.W, { timeout: 15000 }).catch(() => {});
await idle();
const cropped = await page.evaluate(() => { const it = ST.batch.queue[ST.batch.idx]; return { W: it.canvas.width, H: it.canvas.height, n: it.candidates.length, tool: ST.capture.tool }; });
check(cropped.W !== cropBox.W && cropped.n >= 1 && cropped.tool === 'trace', `Crop cuts the photo to the box and reads it again (${cropBox.W}×${cropBox.H} → ${cropped.W}×${cropped.H}, ${cropped.n} shape(s))`);
await page.evaluate(() => ST.batch.undo());
const uncropped = await page.evaluate(() => ST.batch.queue[ST.batch.idx].canvas.width);
check(uncropped === cropBox.W, `⌘Z brings the uncropped photo back (${uncropped} px wide)`);
// Reset goes back to the automatic selection: no clicks, cuts or pieces
const reset = await page.evaluate(async () => {
  const it = ST.batch.queue[ST.batch.idx], lc = it.lastClick, k = it.canvas.width / 1200;
  await ST.batch.addCutAsync(lc.x + 45 * k, lc.y - 260 * k, lc.x + 45 * k, lc.y + 260 * k);
  const edited = { hist: (it.history || []).length, cuts: (it.cuts || []).length };
  document.getElementById('reviewReset').click();
  return {
    lc, edited, same: it.candidates === it.original.candidates, ci: it.ci, hist: it.history.length, cuts: it.cuts.length,
    lastClick: it.lastClick, shown: ST.capture.cand === it.original.candidates[0],
  };
});
check(reset.edited.hist === 1 && reset.edited.cuts === 1 && reset.same && reset.ci === 0 && reset.hist === 0 && reset.cuts === 0 && !reset.lastClick && reset.shown,
  'Reset goes back to the automatic selection (the first shapes, no clicks or cuts, nothing to undo)');
await page.evaluate((lc) => ST.batch.clickTraceAsync(lc.x, lc.y), reset.lc); // (the checks below work on the clicked letter)
// a cut Option-dragged through the N's middle: a vertical stroke just right
// of the click severs its right stem — the letter is grown again from the
// click (with cuts the worker regrows it rather than answering from the
// analysis; a plain drag traces a stroke instead)
const cutAt = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx], k = item.canvas.width / 1200;
  const cx = item.lastClick.x, cy = item.lastClick.y;
  return {
    a: __e2e.screen({ x: cx + 45 * k, y: cy - 260 * k }), b: __e2e.screen({ x: cx + 45 * k, y: cy + 260 * k }),
    before: ST.raster.count(item.candidates[item.ci].mask),
  };
});
await page.keyboard.down('Alt');
await page.mouse.move(cutAt.a.x, cutAt.a.y); await page.mouse.down();
await page.mouse.move(cutAt.a.x, (cutAt.a.y + cutAt.b.y) / 2, { steps: 4 });
await page.mouse.move(cutAt.b.x, cutAt.b.y, { steps: 4 }); await page.mouse.up();
await page.keyboard.up('Alt');
await idle();
const cutRes = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  return {
    after: ST.raster.count(item.candidates[item.ci].mask), cuts: (item.cuts || []).length,
    undoable: (item.history || []).length === 1 && item.history[0].type === 'cut',
  };
});
check(cutRes.after < cutAt.before * 0.8 && cutRes.cuts === 1 && cutRes.undoable,
  `a cut dragged across the letter removes the far side (${cutAt.before} → ${cutRes.after} px) and goes on the undo stack`);
await page.evaluate(() => ST.batch.undo());
const uncut = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  return { ink: ST.raster.count(item.candidates[item.ci].mask), history: item.history.length, cuts: item.cuts.length };
});
check(uncut.ink > cutRes.after && uncut.history === 0 && uncut.cuts === 0, `undo regrows the region (${uncut.ink} px)`);

// Shift-click adds a piece: after a cut severs the right stem, a shift-click
// on the severed stem brings just that piece back (grown in the worker); a
// shift-click on ink already in the shape adds nothing
const partRes = await page.evaluate(async () => {
  const item = ST.batch.queue[ST.batch.idx];
  const whole = item.candidates[item.ci];
  const before = ST.raster.count(whole.mask);
  const k = item.canvas.width / 1200, cx = item.lastClick.x, cy = item.lastClick.y;
  // (the cut and the piece are grown from the click with extract.seeded, which
  // reads the strokes a little thinner than the analysis did: the piece is
  // judged against the whole letter as grown from the click)
  const grown = ST.extract.seeded(item.canvas, cx, cy, { smoothing: 4 }).candidates.find((c) => c.kind === 'whole');
  const regrown = grown ? ST.raster.count(grown.mask) : before;
  await ST.batch.addCutAsync(cx + 45 * k, cy - 260 * k, cx + 45 * k, cy + 260 * k);
  const cut = ST.raster.count(item.candidates[item.ci].mask);
  const same = await ST.batch.addPart(cx, cy);
  const afterSame = ST.raster.count(item.candidates[item.ci].mask);
  // the rightmost ink of the whole N level with the click: its right stem
  const row = Math.round(cy - whole.crop.y);
  let tx = -1;
  for (let x = whole.w - 1; x >= 0; x--) if (whole.mask[row * whole.w + x]) { tx = x; break; }
  const target = { x: whole.crop.x + tx - 4, y: cy };
  return { before, regrown, cut, same, afterSame, target, screen: __e2e.screen(target) };
});
check(partRes.same === 0 && partRes.afterSame === partRes.cut, 'shift-click on ink already in the shape adds nothing');
await page.keyboard.down('Shift');
await page.mouse.click(partRes.screen.x, partRes.screen.y);
await page.keyboard.up('Shift');
await idle();
const merged = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  const c = item.candidates[item.ci];
  return { kind: c.kind, ink: ST.raster.count(c.mask), parts: (item.parts || []).length, paths: c.paths.length };
});
check(merged.kind === 'parts' && merged.parts === 1 && merged.ink > partRes.cut * 1.25 && merged.ink >= partRes.regrown * 0.85,
  `shift-click brings the severed stem back into the shape (${partRes.cut} → ${merged.ink} px of ${partRes.regrown} grown from the click; ${partRes.before} as analyzed)`);
// Ctrl/⌘-Z: the added piece goes first, the cut second (rebuilt in the worker)
await page.keyboard.press('Control+z');
await idle();
const afterUndoPart = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  return { parts: (item.parts || []).length, cuts: item.cuts.length, ink: ST.raster.count(item.candidates[item.ci].mask) };
});
check(afterUndoPart.parts === 0 && afterUndoPart.cuts === 1 && afterUndoPart.ink < partRes.cut * 1.1,
  `Ctrl-Z undoes the added piece first (${afterUndoPart.ink} px, cut still in place)`);
await page.keyboard.press('Control+z');
await idle();
const undone = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  return { ink: ST.raster.count(item.candidates[item.ci].mask), cuts: item.cuts.length, parts: item.parts.length, history: item.history.length };
});
check(undone.cuts === 0 && undone.parts === 0 && undone.history === 0 && undone.ink >= partRes.before * 0.95,
  `a second Ctrl-Z undoes the cut and restores the whole letter (${undone.ink} px)`);
// (the template matcher, still a library function)
const located = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx], cand = item.candidates[item.ci];
  const found = ST.classify.locate(cand.mask, cand.w, cand.h, 'N');
  return found ? found.score : 0;
});
check(located > 0.2, `classify.locate scores the N against its templates (${located.toFixed(2)})`);
await page.fill('#reviewChar', 'N');
await page.click('#reviewAccept');
await page.waitForTimeout(250);
check((await page.evaluate(() => ST.store.slot('N').variants.length)) >= 2, 'click-traced N added');

// fused letters on fibrous paper: a red-marker "F2" whose F touches the 2,
// with a pink bleed halo. Auto and a click in the halo must both stay
// stroke-thin (no solid masses), and the click must give the 2 alone.
console.log('\n— fused marker letters: a click in the bleed halo');
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
  const at = __e2e.at(item, W, cx + 18, 700);
  const n = ST.batch.clickTrace(at.x, at.y);
  const got = item.candidates.slice(0, n);
  const lt = got[0], whole = got.find((k) => k.kind === 'whole') || lt;
  const bb = ST.raster.maskBounds(lt.mask, lt.w, lt.h);
  const b = __e2e.bounds(item, W, lt), wb = __e2e.bounds(item, W, whole);
  // (the template-guided trim, still a library function, finds the 2 in the fused shape)
  const lc = { x: item.lastClick.x - whole.crop.x, y: item.lastClick.y - whole.crop.y };
  const located = ST.classify.isolate(whole.mask, whole.w, whole.h, '2', lc.x, lc.y);
  const strokeInfo = located ? ST.extract.isolateStrokes(whole.mask, whole.w, whole.h, located.margin, lc.x, lc.y) : null;
  return {
    autoFill, n, kinds: got.map((k) => k.kind).join(' '), kind: lt.kind, read: lt.read && lt.read.ranked[0] ? lt.read.ranked[0].ch : '?',
    guess: document.getElementById('reviewChar').value, clickFill: ST.raster.count(lt.mask) / (lt.w * lt.h),
    fill: ST.raster.count(lt.mask) / (bb.w * bb.h), left: b.x0, width: b.w, fusedWidth: wb.w,
    score: located ? located.score : 0, strokes: strokeInfo ? { strokes: strokeInfo.strokes, foreign: strokeInfo.foreign } : null,
  };
});
check(f2Res.autoFill < 0.3, `auto keeps marker strokes thin on fibrous paper (fill ${f2Res.autoFill.toFixed(2)} of crop)`);
check(f2Res.n >= 2 && f2Res.kind === 'letter' && f2Res.read === '2' && f2Res.guess === '2' && f2Res.clickFill < 0.3 && f2Res.fusedWidth > 600,
  `a click in the bleed halo snaps to the paint and gives the 2 alone, the fused F2 offered after it (${f2Res.kinds}; fill ${f2Res.clickFill.toFixed(2)}, fused ${f2Res.fusedWidth} px wide)`);
check(f2Res.left > 250 && f2Res.width > 480 && f2Res.width < 530,
  `the F comes off at the join and the whole 2 stays, tail included (starts at x=${f2Res.left}, ${f2Res.width} px wide)`);
check(f2Res.fill < 0.4, `the 2 is a stroke shape, not a filled block (fill ${f2Res.fill.toFixed(2)} of its box)`);
check(f2Res.score > 0.5, `classify.isolate finds the 2 in the fused shape (match ${f2Res.score.toFixed(2)}, strokes ${JSON.stringify(f2Res.strokes)})`);
await page.evaluate(() => ST.batch.skip());

// a chisel-marker "#" (thick verticals, thin horizontals with fading,
// tapering ends), leaning, fused with a neighbor's diagonal at the top
// right. Auto must find it thin-stroked and stand it upright; picked in the
// letter strip, an Option-click must take the diagonal off and keep the
// whole #, and the thin bars must end in round caps rather than needle points.
console.log('\n— chisel marker #: stood upright, a fused neighbor Option-clicked off, round stroke ends');
const hashInfo = await page.evaluate(() => {
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
  // the whole shape (the # with the neighbor's diagonal on it)
  const wi = item.candidates.findIndex((k) => k.kind !== 'letter');
  const whole = item.candidates[wi];
  return {
    n: item.candidates.length, wi, lean: whole ? whole.lean : null,
    fill: whole ? ST.raster.count(whole.mask) / (whole.w * whole.h) : 1,
    strip: document.querySelectorAll('#letterStrip .letter-pick').length,
    diag: __e2e.screen(__e2e.at(item, W, 850, 180)), // the diagonal's far leg
  };
});
check(hashInfo.wi >= 0 && hashInfo.fill < 0.3 && hashInfo.lean != null && Math.abs(hashInfo.lean) > 3 && Math.abs(hashInfo.lean) < 9,
  `the leaning # is found as a thin-stroked shape, leaning ${hashInfo.lean}° (fill ${hashInfo.fill.toFixed(2)}, ${hashInfo.n} shape(s) offered)`);
if (hashInfo.wi >= 0 && hashInfo.strip > hashInfo.wi) await page.click(`#letterStrip .letter-pick:nth-child(${hashInfo.wi + 1})`);
const hashPicked = await page.evaluate((k) => {
  const item = ST.batch.queue[ST.batch.idx], c = item.candidates[item.ci];
  return { ci: item.ci, shown: ST.capture.cand === item.candidates[k], turn: c.turn, lean: c.lean, label: document.getElementById('reviewRotateVal').textContent };
}, hashInfo.wi);
check(hashPicked.ci === hashInfo.wi && hashPicked.shown && hashPicked.turn === -hashPicked.lean && hashPicked.turn !== 0,
  `picked in the letter strip, it is stood upright by its stems (turned ${hashPicked.label})`);
await page.keyboard.down('Alt');
await page.mouse.click(hashInfo.diag.x, hashInfo.diag.y);
await page.keyboard.up('Alt');
await idle();
const hashRes = await page.evaluate(() => {
  const item = ST.batch.queue[ST.batch.idx];
  const iso = item.candidates[item.ci];
  const k = item.canvas.width / 900;
  const out = { kind: iso.kind, bounds: __e2e.bounds(item, 900, iso), removals: (item.removals || []).length };
  // stroke-end bluntness: the leftmost ink of the shape (a thin bar's tip)
  // and how tall the ink is 6 px (photo px) in from it
  let tipX = Infinity;
  for (let y = 0; y < iso.h; y++) for (let xx = 0; xx < iso.w; xx++) if (iso.mask[y * iso.w + xx] && xx < tipX) tipX = xx;
  let tall = 0;
  const d = Math.round(6 * k);
  for (let y = 0; y < iso.h; y++) if (iso.mask[y * iso.w + Math.min(iso.w - 1, tipX + d)]) tall++;
  out.tip = { tall: tall / k };
  return out;
});
check(hashRes.kind === 'trimmed' && hashRes.removals === 1 && hashRes.bounds.w > 400 && hashRes.bounds.w < 560 && hashRes.bounds.x1 < 900 * 0.8,
  `Option-click takes the neighbor's diagonal off and keeps the whole # (${hashRes.bounds.w}×${hashRes.bounds.h}, right edge x=${hashRes.bounds.x1})`);
check(hashRes.tip.tall >= 9, `thin bars end in round caps, not needle points (${hashRes.tip.tall.toFixed(1)} px tall 6 px from the tip)`);
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

// a cut with no click keeps the bigger side
const cutSide = await page.evaluate(async () => {
  const wall = ST.demo.makeWall('S', 321);
  ST.batch.addCanvas(wall.canvas, 'cut-s');
  ST.batch.reopen();
  const item = ST.batch.queue[ST.batch.idx];
  const cand = item.candidates[item.ci];
  const bb = ST.raster.maskBounds(cand.mask, cand.w, cand.h);
  // a level cut through the S a fifth of the way down: the top fifth is the
  // small piece, the rest of the S the letter
  const y = cand.crop.y + bb.y0 + bb.h * 0.2;
  const before = ST.raster.count(cand.mask);
  await ST.batch.addCutAsync(cand.crop.x + bb.x0 - 10, y, cand.crop.x + bb.x1 + 10, y);
  const after = item.candidates[item.ci];
  const abb = ST.raster.maskBounds(after.mask, after.w, after.h);
  ST.batch.skip();
  return { before, after: ST.raster.count(after.mask), keptTop: after.crop.y + abb.y0, cutY: y };
});
check(cutSide.after < cutSide.before && cutSide.after > cutSide.before * 0.5 && cutSide.keptTop > cutSide.cutY - 5,
  `a cut with no click keeps the larger side (${cutSide.before} → ${cutSide.after} px; kept piece starts below the cut)`);

// ---- seeing past what hides the letter ----------------------------------------
console.log('\n— occlusion: pipe, frame edge, outline');
const occl = await page.evaluate(() => {
  const mk = (W, H, bg) => {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    let s = 7;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const img = x.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 16; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
    x.putImageData(img, 0, 0);
    return { c, x };
  };
  const stroke = (x, draw, lw, col) => { x.save(); x.lineCap = 'round'; x.lineJoin = 'round'; x.lineWidth = lw; x.strokeStyle = col; x.beginPath(); draw(x); x.stroke(); x.restore(); };
  const out = {};
  const run = (canvas, name) => { ST.batch.addCanvas(canvas, name); ST.batch.reopen(); return ST.batch.queue[ST.batch.idx]; };
  const holes = (cand) => cand.paths.filter((p) => p.area < 0).length;
  // an H behind a drainpipe
  {
    const { c, x } = mk(900, 1000, '#d4c6ac');
    stroke(x, (k) => { k.moveTo(250, 220); k.lineTo(250, 800); k.moveTo(630, 220); k.lineTo(630, 800); k.moveTo(250, 500); k.lineTo(630, 500); }, 62, 'rgb(38,54,124)');
    const gr = x.createLinearGradient(405, 0, 480, 0);
    gr.addColorStop(0, 'rgb(78,80,84)'); gr.addColorStop(0.45, 'rgb(172,174,176)'); gr.addColorStop(1, 'rgb(96,98,100)');
    x.fillStyle = gr; x.fillRect(405, 0, 75, 1000);
    const item = run(c, 'pipe');
    const cand = item.candidates[0];
    const b = __e2e.bounds(item, 900, cand);
    // the crossbar under the pipe
    const u = __e2e.at(item, 900, 442, 500);
    const under = cand.mask[Math.round(u.y - cand.crop.y) * cand.w + Math.round(u.x - cand.crop.x)];
    out.pipe = { n: item.candidates.length, left: b.x0, right: b.x1, outer: cand.paths.filter((p) => p.area > 0).length, under };
    ST.batch.skip();
  }
  // a U whose bottom is past the frame
  {
    const { c, x } = mk(900, 820, '#c8c4be');
    stroke(x, (k) => { k.moveTo(260, 150); k.lineTo(260, 700); k.arc(450, 700, 190, Math.PI, 0, true); k.lineTo(640, 150); }, 64, 'rgb(20,20,24)');
    const item = run(c, 'frame-u');
    const cand = item.candidates[0];
    out.frame = { n: item.candidates.length, bottom: __e2e.bounds(item, 900, cand).y1, outer: cand.paths.filter((p) => p.area > 0).length, holes: holes(cand) };
    ST.batch.skip();
  }
  // a chrome throw-up B: silver fill, black outline
  {
    const { c, x } = mk(900, 1000, '#5f6978');
    const shape = (k, g) => { k.beginPath(); k.ellipse(430, 355, 175 + g, 155 + g, 0, 0, Math.PI * 2); k.ellipse(455, 650, 195 + g, 175 + g, 0, 0, Math.PI * 2); k.rect(215 - g, 200 - g, 190 + 2 * g, 620 + 2 * g); k.fill('nonzero'); };
    const counters = (k, g) => { k.beginPath(); k.ellipse(420, 355, 55 + g, 42 + g, 0, 0, Math.PI * 2); k.fill(); k.beginPath(); k.ellipse(440, 650, 62 + g, 50 + g, 0, 0, Math.PI * 2); k.fill(); };
    x.fillStyle = 'rgb(18,18,20)'; shape(x, 16);
    x.fillStyle = 'rgb(200,202,208)'; shape(x, 0);
    x.fillStyle = 'rgb(18,18,20)'; counters(x, 14);
    x.fillStyle = '#5f6978'; counters(x, 0);
    const item = run(c, 'throwup');
    const auto = item.candidates[0];
    const p = __e2e.at(item, 900, 300, 560);
    ST.batch.clickTrace(p.x, p.y);
    const cand = item.candidates[0];
    const b = __e2e.bounds(item, 900, cand);
    out.throwup = { left: b.x0, right: b.x1, top: b.y0, holes: holes(cand), autoHoles: auto ? holes(auto) : -1 };
    ST.batch.skip();
  }
  return out;
});
check(occl.pipe.left < 225 && occl.pipe.right > 655 && occl.pipe.outer === 1 && occl.pipe.under === 1,
  `an H behind a drainpipe comes out whole, crossbar carried on under the pipe (${occl.pipe.left}–${occl.pipe.right}, ${occl.pipe.outer} outline)`);
check(occl.frame.bottom > 860 && occl.frame.outer === 1 && occl.frame.holes === 0,
  `a U cut off by the frame is finished past it (ink down to y=${occl.frame.bottom} on an 820 px photo)`);
check(occl.throwup.left < 205 && occl.throwup.top < 190 && occl.throwup.holes === 2,
  `a throw-up's outline is part of the letter, counters kept, when clicked (left ${occl.throwup.left}, top ${occl.throwup.top}, ${occl.throwup.holes} counters)`);
check(occl.throwup.autoHoles === 2,
  `the automatic selection keeps a throw-up's counters too (${occl.throwup.autoHoles} counters)`);

// a T whose bar runs on through an O's side and ends inside its counter
console.log('\n— a fused neighbor: the click takes the letter, the letter strip, Rotate, Option-click');
const toUrl = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1000; c.height = 1000;
  const x = c.getContext('2d');
  x.fillStyle = '#dad6ce'; x.fillRect(0, 0, 1000, 1000);
  x.lineCap = 'round'; x.lineJoin = 'round'; x.lineWidth = 56; x.strokeStyle = 'rgb(22,22,26)';
  x.beginPath(); x.moveTo(130, 220); x.lineTo(560, 220); x.moveTo(325, 220); x.lineTo(325, 820); x.stroke();
  x.beginPath(); x.ellipse(620, 330, 150, 220, 0, 0, Math.PI * 2); x.stroke();
  return c.toDataURL('image/png');
});
await upload('fused-to.png', toUrl);
const tStem = await page.evaluate(() => __e2e.screen(__e2e.at(ST.batch.queue[ST.batch.idx], 1000, 325, 600)));
await page.mouse.click(tStem.x, tStem.y);
await idle();
// the click already hands back the T alone: its strokes grouped the way the
// recognizer reads one letter, the O's taken off
const fusedClick = await page.evaluate(() => {
  const it = ST.batch.queue[ST.batch.idx], c = it.candidates[it.ci], b = __e2e.bounds(it, 1000, c);
  return { name: it.name, kind: c.kind, left: b.x0, right: b.x1, guess: document.getElementById('reviewChar').value };
});
check(fusedClick.name === 'fused-to.png' && fusedClick.kind === 'letter' && fusedClick.right < 615 && fusedClick.left < 110,
  `a click on the fused T gives the T alone (${fusedClick.left}–${fusedClick.right}, “${fusedClick.guess}” filled in)`);
check(fusedClick.guess.toUpperCase() === 'T', `the recognizer fills in what it reads (“${fusedClick.guess}”), with the next best as buttons`);
// every shape found is offered in the letter strip; a click picks one
const strip = await page.evaluate(() => {
  const it = ST.batch.queue[ST.batch.idx];
  const btns = Array.from(document.querySelectorAll('#letterStrip .letter-pick'));
  return {
    hidden: document.getElementById('letterStrip').hidden, n: btns.length, on: btns.map((b) => b.classList.contains('on')),
    kinds: it.candidates.map((c) => c.kind || 'auto'),
  };
});
check(!strip.hidden && strip.n === Math.min(12, strip.kinds.length) && strip.on.indexOf(true) === 0 && strip.on.filter(Boolean).length === 1,
  `the letter strip shows every shape found (${strip.n}: ${strip.kinds.join(' ')}), the current one marked`);
// the Rotate slider turns the glyph (not the photo overlay), and a turn set
// by hand stays with the photo
const rot = await page.evaluate(() => {
  const it = ST.batch.queue[ST.batch.idx];
  const r = document.getElementById('reviewRotate');
  const before = JSON.stringify(ST.capture.uprightPaths(it.candidates[it.ci])[0].cubics[0][0]);
  r.value = '12'; r.dispatchEvent(new Event('input'));
  const c = it.candidates[it.ci];
  return { enabled: !r.disabled, turn: c.turn, manual: it.manualTurn, label: document.getElementById('reviewRotateVal').textContent,
    moved: JSON.stringify(ST.capture.uprightPaths(c)[0].cubics[0][0]) !== before, guesses: document.querySelectorAll('#guessRow button').length };
});
check(rot.enabled && rot.turn === 12 && rot.manual === 12 && rot.moved && /12°/.test(rot.label) && rot.guesses >= 1,
  `Rotate turns the letterform (${rot.label}, ${rot.guesses} guess button(s))`);
const rot170 = await page.evaluate(() => {
  const it = ST.batch.queue[ST.batch.idx];
  const r = document.getElementById('reviewRotate'); r.value = '170'; r.dispatchEvent(new Event('input'));
  return { turned: it.candidates[it.ci].turn, label: document.getElementById('reviewRotateVal').textContent };
});
check(rot170.turned === 170 && /170°/.test(rot170.label), `Rotate goes past ±30° (${rot170.label})`);
await page.evaluate(() => { const it = ST.batch.queue[ST.batch.idx]; const r = document.getElementById('reviewRotate'); r.value = '0'; r.dispatchEvent(new Event('input')); it.manualTurn = null; });
const wholeIdx = strip.kinds.indexOf('whole');
if (wholeIdx >= 0) await page.click(`#letterStrip .letter-pick:nth-child(${wholeIdx + 1})`);
const pickedWhole = await page.evaluate((k) => {
  const it = ST.batch.queue[ST.batch.idx];
  const btns = Array.from(document.querySelectorAll('#letterStrip .letter-pick'));
  const c = it.candidates[it.ci];
  return { ci: it.ci, shown: ST.capture.cand === it.candidates[k], on: btns.findIndex((b) => b.classList.contains('on')), w: ST.raster.maskBounds(c.mask, c.w, c.h).w };
}, wholeIdx);
check(wholeIdx > 0 && pickedWhole.ci === wholeIdx && pickedWhole.shown && pickedWhole.on === wholeIdx,
  `a click in the strip picks that shape (ST.batch.pick(${wholeIdx}): the T with the O, on the stage and marked)`);
// Option-click takes a piece off: click the O's far side
const oSpot = await page.evaluate(() => __e2e.screen(__e2e.at(ST.batch.queue[ST.batch.idx], 1000, 770, 330)));
await page.keyboard.down('Alt');
await page.mouse.click(oSpot.x, oSpot.y);
await page.keyboard.up('Alt');
await idle();
const removed = await page.evaluate(() => {
  const it = ST.batch.queue[ST.batch.idx], c = it.candidates[it.ci], b = __e2e.bounds(it, 1000, c);
  const bar = __e2e.at(it, 1000, 480, 220);
  return { kind: c.kind, left: b.x0, right: b.x1, bar: c.mask[Math.round(bar.y - c.crop.y) * c.w + Math.round(bar.x - c.crop.x)], n: (it.removals || []).length };
});
check(removed.kind === 'trimmed' && removed.n === 1 && removed.right < 610 && removed.left < 110 && removed.bar === 1,
  `Option-click on the fused O takes it off, the T's bar stays whole through the crossing (${removed.left}–${removed.right})`);
await page.focus('#reviewChar');
await page.keyboard.press('Control+z');
await idle();
const unremoved = await page.evaluate(() => { const it = ST.batch.queue[ST.batch.idx]; const c = it.candidates[it.ci]; return { w: ST.raster.maskBounds(c.mask, c.w, c.h).w, n: (it.removals || []).length, kind: c.kind }; });
check(unremoved.n === 0 && unremoved.w === pickedWhole.w, `Ctrl-Z puts the removed piece back (${unremoved.w} px wide, ${unremoved.kind})`);
await page.evaluate(() => ST.batch.skip());

// what the worker answers a click with, called directly: a thin marker tag
// is traced as a line (auto.clickStroke); a click on bare wall finds nothing
// in the analysis (auto.clickLetter → null: the worker then grows the letter
// from the click with extract.seeded)
const thin = await page.evaluate(() => {
  const W = 800, H = 600;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.fillStyle = '#cfcac0'; x.fillRect(0, 0, W, H);
  let s = 13;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const img = x.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 18; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  x.putImageData(img, 0, 0);
  x.lineCap = 'round'; x.lineJoin = 'round'; x.lineWidth = 6; x.strokeStyle = 'rgb(40,40,48)';
  x.beginPath(); x.moveTo(220, 440); x.quadraticCurveTo(180, 250, 260, 150); x.quadraticCurveTo(330, 300, 380, 430); x.quadraticCurveTo(470, 300, 460, 150); x.stroke();
  const d = ST.extract.flatData(c).data;
  const line = ST.auto.clickStroke(d, W, H, 224, 436); // a few px off the stroke's end
  const bb = line && ST.raster.maskBounds(line.mask, line.w, line.h);
  const an = ST.auto.processImage(c, { deskew: false });
  const on = ST.auto.clickLetter(an.shapes, W, H, 222, 440, d);
  return {
    line: line && { kind: line.kind, x0: line.crop.x + bb.x0, y0: line.crop.y + bb.y0, x1: line.crop.x + bb.x1, y1: line.crop.y + bb.y1, fill: ST.raster.count(line.mask) / (bb.w * bb.h) },
    blankStroke: ST.auto.clickStroke(d, W, H, 650, 300),
    on: on && on.candidates.map((k) => k.kind).join(' '),
    blank: ST.auto.clickLetter(an.shapes, W, H, 650, 300, d),
  };
});
check(thin.line && thin.line.kind === 'whole' && thin.line.x0 < 215 && thin.line.x1 > 455 && thin.line.y0 < 160 && thin.line.y1 > 435 && thin.line.fill < 0.2 && thin.blankStroke === null,
  `a click on a thin marker tag traces the whole stroke as a line (auto.clickStroke: ${thin.line && `${thin.line.x0},${thin.line.y0}–${thin.line.x1},${thin.line.y1}, fill ${thin.line.fill.toFixed(2)}`})`);
check(thin.on && /whole/.test(thin.on) && thin.blank === null,
  `auto.clickLetter answers a click from the analysis's shapes (${thin.on}) and finds nothing on bare wall`);


// ---- a letter typed: found in the photo, traced through its neighbors --------
// "HAH" in one red, the H's bars running into the A's legs: type A and the
// photo is searched for an A — its strokes fitted onto the paint's, carried
// through the crossings — and the A comes out alone, apex to feet, no bar.
console.log('\n— a letter typed, found through its neighbors');
const hahUrl = await page.evaluate(() => {
  const W = 900, H = 700, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#dcd8cf'; x.fillRect(0, 0, W, H);
  const img = x.getImageData(0, 0, W, H);
  let s = 7; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 18; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  x.putImageData(img, 0, 0);
  x.strokeStyle = '#b81f2e'; x.lineWidth = 34; x.lineCap = 'round'; x.lineJoin = 'round';
  const line = (pts) => { x.beginPath(); x.moveTo(pts[0], pts[1]); for (let k = 2; k < pts.length; k += 2) x.lineTo(pts[k], pts[k + 1]); x.stroke(); };
  line([110, 150, 110, 560]); line([290, 150, 290, 560]); line([110, 350, 392, 350]);    // H, its bar into the A's left leg
  line([330, 560, 450, 150, 570, 560]); line([383, 420, 517, 420]);                       // A
  line([660, 150, 660, 560]); line([840, 150, 840, 560]); line([508, 350, 840, 350]);    // H, its bar from the A's right leg
  return c.toDataURL('image/png');
});
await upload('hah.png', hahUrl);
await page.evaluate(() => { ST.batch.idx = ST.batch.queue.length - 1; ST.batch.renderCurrent(); });
await page.click('#reviewChar', { clickCount: 3 });
await page.keyboard.type('A');
await page.waitForFunction(() => { const it = ST.batch.queue[ST.batch.idx]; const c = it && it.candidates[it.ci]; return c && c.kind === 'typed'; }, null, { timeout: 30000 }).catch(() => {});
await idle();
const typedRes = await page.evaluate(() => {
  const it = ST.batch.queue[ST.batch.idx], c = it.candidates[it.ci];
  if (!c || c.kind !== 'typed') return { kind: c && c.kind };
  const b = __e2e.bounds(it, 900, c);
  const on = (px, py) => { const p = __e2e.at(it, 900, px, py), X = Math.round(p.x - c.crop.x), Y = Math.round(p.y - c.crop.y); return X >= 0 && Y >= 0 && X < c.w && Y < c.h && !!c.mask[Y * c.w + X]; };
  return { kind: c.kind, typed: c.typed, b, box: document.getElementById('reviewChar').value, btn: document.getElementById('reviewFind').textContent,
    leftBar: on(345, 350), rightBar: on(600, 350), apex: on(450, 175), leftFoot: on(338, 535), rightFoot: on(562, 535), bar: on(450, 420) };
});
check(typedRes.kind === 'typed' && typedRes.typed === 'A' && typedRes.box === 'A', `typing A finds an A in the photo (${typedRes.kind})`);
check(typedRes.b && typedRes.b.x0 > 290 && typedRes.b.x1 < 620 && typedRes.b.y0 < 175 && typedRes.b.y1 > 540,
  `the A alone, apex to feet — not the H's beside it (${typedRes.b && `${typedRes.b.x0},${typedRes.b.y0}–${typedRes.b.x1},${typedRes.b.y1}`})`);
check(typedRes.apex && typedRes.leftFoot && typedRes.rightFoot && typedRes.bar && !typedRes.leftBar && !typedRes.rightBar,
  `its legs, apex and bar traced, the H's bars that run into its legs left out (${JSON.stringify({ apex: typedRes.apex, feet: typedRes.leftFoot && typedRes.rightFoot, bar: typedRes.bar, hBars: typedRes.leftBar || typedRes.rightBar })})`);
check(/Find “A” in the photo/.test(typedRes.btn || ''), `the Tag step offers to find the typed letter again (${typedRes.btn})`);
await page.evaluate(() => ST.batch.undo());
const typedUndo = await page.evaluate(() => { const it = ST.batch.queue[ST.batch.idx]; return { kind: it.candidates[it.ci].kind, any: it.candidates.some((c) => c.kind === 'typed'), box: document.getElementById('reviewChar').value }; });
check(!typedUndo.any && typedUndo.box === 'A', `⌘Z brings back the shapes found before (${typedUndo.kind}), the A still typed`);

// Or trace it: drag along each of the A's strokes on the photo (a hand's
// line — a little off the paint, stopping short of the ends) and the paint
// under them is taken, carried through the H's bars that run into its legs.
console.log('\n— a letter traced by hand');
const dragTrace = async (pts) => {
  const sp = await page.evaluate((pts) => { const it = ST.batch.queue[ST.batch.idx]; return pts.map(([x, y]) => __e2e.screen(__e2e.at(it, 900, x, y))); }, pts);
  await page.mouse.move(sp[0].x, sp[0].y); await page.mouse.down();
  for (let k = 1; k < sp.length; k++) await page.mouse.move(sp[k].x, sp[k].y, { steps: 16 });
  await page.mouse.up();
  await idle();
};
const tracedNow = () => page.evaluate(() => {
  const it = ST.batch.queue[ST.batch.idx], c = it.candidates[it.ci];
  const on = (px, py) => { const p = __e2e.at(it, 900, px, py), X = Math.round(p.x - c.crop.x), Y = Math.round(p.y - c.crop.y); return X >= 0 && Y >= 0 && X < c.w && Y < c.h && !!c.mask[Y * c.w + X]; };
  return { kind: c.kind, traces: (it.traces || []).length, last: (it.history || []).slice(-1).map((h) => h.type)[0], b: __e2e.bounds(it, 900, c),
    box: document.getElementById('reviewChar').value, shown: ST.capture.cand === c,
    leftBar: on(345, 350), rightBar: on(600, 350), apex: on(450, 175), leftFoot: on(338, 535), rightFoot: on(562, 535), bar: on(450, 420), leftLeg: on(392, 350) };
});
await dragTrace([[342, 528], [398, 340], [446, 170]]);                 // the left leg, up
const tr1 = await tracedNow();
check(tr1.kind === 'traced' && tr1.traces === 1 && tr1.last === 'trace' && tr1.shown && tr1.leftLeg && tr1.leftFoot && !tr1.leftBar && !tr1.rightFoot,
  `a drag along the left leg takes that leg alone — not the H's bar that runs into it (${JSON.stringify({ kind: tr1.kind, leg: tr1.leftLeg, hBar: tr1.leftBar })})`);
await dragTrace([[456, 178], [505, 350], [556, 520]]);                 // the right leg, down
await dragTrace([[392, 426], [450, 418], [510, 424]]);                 // the bar
const tr3 = await tracedNow();
check(tr3.kind === 'traced' && tr3.traces === 3 && tr3.box === 'A', `three strokes traced, the letter read as ${tr3.box}`);
check(tr3.b && tr3.b.x0 > 290 && tr3.b.x1 < 620 && tr3.b.y0 < 175 && tr3.b.y1 > 540,
  `the traced A alone, apex to feet — the ends run on to the paint's (${tr3.b && `${tr3.b.x0},${tr3.b.y0}–${tr3.b.x1},${tr3.b.y1}`})`);
check(tr3.apex && tr3.leftFoot && tr3.rightFoot && tr3.bar && !tr3.leftBar && !tr3.rightBar,
  `its legs, apex and bar, the H's bars left out (${JSON.stringify({ apex: tr3.apex, feet: tr3.leftFoot && tr3.rightFoot, bar: tr3.bar, hBars: tr3.leftBar || tr3.rightBar })})`);
await page.evaluate(() => ST.batch.undo());
await idle();
const trUndo = await tracedNow();
check(trUndo.kind === 'traced' && trUndo.traces === 2 && !trUndo.bar && trUndo.apex, `⌘Z takes the last stroke off (the bar gone, ${trUndo.traces} strokes left)`);
await page.click('#reviewReset');
await idle();
const trReset = await tracedNow();
check(trReset.kind !== 'traced' && trReset.traces === 0, `Reset drops the traced strokes (${trReset.kind})`);
// the worker keeps the last few photos' analyses: one dropped (a long queue
// read since) is read again, and the stroke is still found in its paint
await page.evaluate(() => { const it = ST.batch.queue[ST.batch.idx]; it.analysis = 99999; it.original.analysis = 99999; });
await dragTrace([[342, 528], [398, 340], [446, 170]]);
const trAgain = await tracedNow();
const reread = await page.evaluate(() => ST.batch.queue[ST.batch.idx].analysis);
check(trAgain.kind === 'traced' && trAgain.leftLeg && !trAgain.leftBar && reread !== 99999 && reread != null,
  `a photo whose analysis was dropped is read again, and the stroke found in its paint (analysis ${reread})`);
await page.click('#reviewReset');
await idle();
// Rotate turns the photo on the stage — before anything is traced — and a
// stroke traced on the turned photo is the same stroke, the letter turned
// with it; Baseline moves it against the baseline
await page.evaluate(() => { const r = document.getElementById('reviewRotate'); r.value = 90; r.dispatchEvent(new Event('input', { bubbles: true })); });
const turnedView = await page.evaluate(() => ({ rot: ST.capture.view.rot, manual: ST.batch.queue[ST.batch.idx].manualTurn }));
await dragTrace([[342, 528], [398, 340], [446, 170]]);
const trTurned = await tracedNow();
const turnedCand = await page.evaluate(() => { const it = ST.batch.queue[ST.batch.idx]; return { turn: it.candidates[it.ci].turn, dy: !document.getElementById('reviewDy').disabled }; });
check(turnedView.rot === 90 && turnedView.manual === 90 && trTurned.kind === 'traced' && trTurned.leftLeg && !trTurned.leftBar && turnedCand.turn === 90,
  `Rotate turns the photo on the stage (${turnedView.rot}°); a leg traced on it is the same leg, the letter turned ${turnedCand.turn}°`);
await page.click('#toolTurnL');
check(await page.evaluate(() => ST.capture.view.rot === 0 && ST.batch.queue[ST.batch.idx].candidates[0].turn === 0), 'the ↺ button turns it back a quarter turn');
await page.evaluate(() => { const r = document.getElementById('reviewDy'); r.value = 120; r.dispatchEvent(new Event('input', { bubbles: true })); });
const dyRes = await page.evaluate(() => { const it = ST.batch.queue[ST.batch.idx]; return { dy: (it.candidates[it.ci].nudge || {}).dy, label: document.getElementById('reviewDyVal').textContent }; });
check(turnedCand.dy && dyRes.dy === 120 && dyRes.label === '+120', `Baseline moves the letter up or down (${dyRes.label})`);
// Smoothing evens the outline out; back at 0 it is the outline as found
const smoothRes = await page.evaluate(async () => {
  const it = ST.batch.queue[ST.batch.idx], c = it.candidates[it.ci], before = c.paths;
  const r = document.getElementById('reviewSmooth');
  r.value = 6; r.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 250));
  const out = { smooth: c.smooth, item: it.smooth, changed: c.paths !== before, label: document.getElementById('reviewSmoothVal').textContent };
  r.value = 0; r.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 250));
  out.restored = c.paths === before;
  return out;
});
check(smoothRes.smooth === 6 && smoothRes.item === 6 && smoothRes.changed && smoothRes.label === '6' && smoothRes.restored,
  `Smoothing evens the outline out, and 0 gives it back as found (${JSON.stringify(smoothRes)})`);
// a stroke the photo's edge cuts: carried on past the frame, not cut off square
const pastFrame = await page.evaluate(() => {
  const W = 420, H = 420, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#d8d4cc'; x.fillRect(0, 0, W, H);
  x.strokeStyle = '#1b1b1b'; x.lineWidth = 30; x.beginPath(); x.arc(60, 210, 120, 0, Math.PI * 2); x.stroke();
  const line = [];
  for (let a = -2.05; a <= 2.05; a += 0.02) line.push(60 + 120 * Math.cos(a), 210 + 120 * Math.sin(a));
  const f = ST.typed.traceStrokes([line], { W, H, paints: [], shapes: [], data: x.getImageData(0, 0, W, H).data }, { tol: 20 });
  return f && { x0: f.crop.x, y0: f.crop.y, x1: f.crop.x + f.crop.w, y1: f.crop.y + f.crop.h };
});
check(pastFrame && pastFrame.x0 < -10 && pastFrame.y0 < 110 && pastFrame.y1 > 310,
  `a bowl the photo's edge cuts is carried on past the frame (${JSON.stringify(pastFrame)})`);
await page.click('#reviewReset');
await idle();
check(await page.evaluate(() => ST.capture.view.rot === 0), 'Reset turns the photo back');
check(await page.evaluate(() => !document.getElementById('stageHint')), 'nothing is laid over the photo on the stage');

// One design of a character per photo: the A traced and added; the same
// photo again, an A traced from it and added — you are asked which to keep
console.log('\n— the same letter from the same photo');
await dragTrace([[342, 528], [398, 340], [446, 170]]);
await dragTrace([[456, 178], [505, 350], [556, 520]]);
await dragTrace([[392, 426], [450, 418], [510, 424]]);
await page.click('#reviewChar', { clickCount: 3 });
await page.keyboard.type('A');
const aBefore = await page.evaluate(() => (ST.store.slot('A') ? ST.store.slot('A').variants.length : 0));
await page.click('#reviewAccept');
const firstA = await page.evaluate(() => { const s = ST.store.slot('A'); const v = s.variants[s.variants.length - 1]; return { n: s.variants.length, id: v.id, photo: v.photo && v.photo.name, open: document.getElementById('dupModal').classList.contains('open') }; });
check(firstA.n === aBefore + 1 && firstA.photo === 'hah.png' && !firstA.open, `the traced A is added, from hah.png (${firstA.n} A's)`);
await upload('hah.png', hahUrl);
await page.evaluate(() => { ST.batch.idx = ST.batch.queue.length - 1; ST.batch.renderCurrent(); });
await dragTrace([[342, 528], [398, 340], [446, 170]]);
await page.click('#reviewChar', { clickCount: 3 });
await page.keyboard.type('A');
await page.click('#reviewAccept');
const dup = await page.evaluate(() => ({ open: document.getElementById('dupModal').classList.contains('open'), cards: Array.from(document.querySelectorAll('#dupPicks .dup-pick')).map((b) => b.textContent), title: document.getElementById('dupTitle').textContent, n: ST.store.slot('A').variants.length }));
check(dup.open && dup.cards.length === 2 && /Added before/.test(dup.cards[0]) && /New/.test(dup.cards[1]) && dup.n === firstA.n,
  `adding a second A from the same photo asks which to keep (“${dup.title}” — ${dup.cards.join(' / ')}), nothing added yet`);
await page.click('#dupPicks .dup-pick:last-child');
const kept = await page.evaluate((oldId) => { const s = ST.store.slot('A'); return { n: s.variants.length, hasOld: s.variants.some((v) => v.id === oldId), active: s.variants[s.active].photo && s.variants[s.active].photo.name, open: document.getElementById('dupModal').classList.contains('open') }; }, firstA.id);
check(!kept.open && kept.n === firstA.n && !kept.hasOld && kept.active === 'hah.png', `picking the new one replaces the one before (${kept.n} A's, the earlier one gone)`);


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

// pairs kerned by their shapes: the most pulled-in pair of the library set
// in the tester is moved in by its kerning; off, it isn't; the font file
// carries the kerning too
const pair = await page.evaluate(() => {
  const m = ST.fontlive.glyphMaps[0];
  let best = null;
  for (const [ca, a] of m) for (const [cb, b] of m) {
    if (ca === 32 || cb === 32) continue;
    const k = ST.metrics.kernPair(a, b);
    if (!best || k < best.k) best = { k, text: String.fromCodePoint(ca) + String.fromCodePoint(cb) };
  }
  const t = document.getElementById('tester');
  t.textContent = best.text;
  ST.fontlive.rewrap();
  const sp = t.querySelectorAll('span.tl');
  return { k: best.k, text: best.text, margin: sp[1] && sp[1].style.marginLeft, first: sp[0] && sp[0].style.marginLeft };
});
check(pair.k < 0 && pair.margin === `${pair.k / 1000}em` && !pair.first, `the tester kerns “${pair.text}” by its shapes (${pair.k} units → ${pair.margin})`);
await page.click('#autoKern');
await page.waitForTimeout(700);
const unkerned = await page.evaluate(() => { const sp = document.querySelectorAll('#tester span.tl'); return { margin: sp[1] && sp[1].style.marginLeft, on: ST.store.state.tester.autoKern }; });
check(!unkerned.margin && unkerned.on === false, 'with “Kern letter pairs” off it is set by its sidebearings alone');
await page.click('#autoKern');
await page.waitForTimeout(700);
const kernTable = await page.evaluate(() => {
  const b = ST.fontlive.lastBytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength), n = dv.getUint16(4);
  for (let i = 0; i < n; i++) if (String.fromCharCode(...b.slice(12 + i * 16, 16 + i * 16)) === 'kern') return dv.getUint16(dv.getUint32(12 + i * 16 + 8) + 10);
  return 0;
});
check(kernTable > 0, `the font file carries a kerning table (${kernTable} pairs)`);

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
// a letterform's size and baseline are nudged here (not on the capture stage)
const nudgeBtn = (label, k) => page.locator('#drawerBody .nudge-row', { hasText: label }).locator('.nudge-btn').nth(k);
await nudgeBtn('Size %', 1).click();
await nudgeBtn('Baseline', 1).click();
await nudgeBtn('Baseline', 1).click();
const nudged = await page.evaluate(() => ({ n: ST.store.activeVariant('S').nudge, vals: Array.from(document.querySelectorAll('#drawerBody .nudge-val')).map((e) => e.textContent) }));
check(nudged.n && nudged.n.scale === 2 && nudged.n.dy === 20 && nudged.vals[0] === '2' && nudged.vals[1] === '20',
  `the Glyphs drawer's optical nudges set the letterform's size and baseline (${JSON.stringify(nudged.n)})`);
await page.locator('#drawerBody button', { hasText: 'Reset fit' }).click();
const unnudged = await page.evaluate(() => ST.store.activeVariant('S').nudge);
check(unnudged && unnudged.scale === 0 && unnudged.dy === 0, 'Reset fit takes the nudges back off');
await page.waitForTimeout(150);
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
  // photos are analyzed in the background: the next one may still be on its way
  await page2.waitForFunction(() => !!ST.batch.queue[ST.batch.idx], { timeout: 20000 });
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
const nPhoto = cloud.library.glyphs.N.variants[0].photo;
check(nPhoto && nPhoto.id === 'ph_n_00000001' && nPhoto.name === 'wall-n.png' && nPhoto.quad && nPhoto.quad.length === 8,
  `each letterform records its Drive photo and where in it, in library.json (${JSON.stringify(nPhoto)})`);

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
// with photos waiting in the queue, the one clicked comes up first — the
// rest wait behind it — and a photo already waiting is brought forward
await page2.evaluate(() => { ST.capture.loadDemo('K'); __st.switchTab('glyphs'); });
await page2.waitForSelector('.photo-card[data-photo="ph_t_00000002"]');
await page2.click('.photo-card[data-photo="ph_t_00000002"]');
await page2.waitForFunction(() => ST.capture.item && ST.capture.item.sourceId === 'ph_t_00000002', { timeout: 20000 });
const ahead = await page2.evaluate(() => ST.batch.queue.slice(ST.batch.idx).map((q) => q.sourceId || q.name).join(' '));
check(ahead === 'ph_t_00000002 demo-K', `a clicked photo goes ahead of the waiting queue (${ahead})`);
await page2.evaluate(() => { // T waits behind the demo now
  const q = ST.batch.queue, i = ST.batch.idx;
  [q[i], q[i + 1]] = [q[i + 1], q[i]];
  ST.batch.renderCurrent();
  __st.switchTab('glyphs');
});
const tFetches = [];
page2.on('request', (r) => { if (/api\/photo\?id=ph_t_00000002$/.test(r.url())) tFetches.push(r.url()); });
await page2.click('.photo-card[data-photo="ph_t_00000002"]');
await page2.waitForFunction(() => ST.capture.item && ST.capture.item.sourceId === 'ph_t_00000002', { timeout: 5000 });
const forward = await page2.evaluate(() => ST.batch.queue.slice(ST.batch.idx).map((q) => q.sourceId || q.name).join(' '));
check(forward === 'ph_t_00000002 demo-K' && tFetches.length === 0,
  `a photo already in the queue is brought forward, not fetched again (${forward}; ${tFetches.length} fetches)`);
await page2.evaluate(() => { ST.batch.skip(); ST.batch.skip(); __st.switchTab('glyphs'); });
// hover a used photo: the letterforms it gave
await page2.waitForSelector('.photo-card[data-photo="ph_n_00000001"] .photo-forms-count');
await page2.hover('.photo-card[data-photo="ph_n_00000001"]');
const forms = await page2.evaluate(() => {
  const card = document.querySelector('.photo-card[data-photo="ph_n_00000001"]');
  const o = card.querySelector('.photo-forms');
  return {
    count: card.querySelector('.photo-forms-count').textContent,
    shown: !!o && getComputedStyle(o).display !== 'none',
    chars: o ? Array.from(o.querySelectorAll('.photo-form > span')).map((s) => s.textContent).join('') : '',
    inked: o ? Array.from(o.querySelectorAll('canvas')).every((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
      return false;
    }) : false,
  };
});
check(forms.count === '1' && forms.shown && forms.chars === 'N' && forms.inked,
  `hovering a Drive photo shows the letterforms it gave (${JSON.stringify(forms)})`);
await page2.mouse.move(5, 5);
await page2.evaluate(() => __st.switchTab('capture'));
await page2.waitForTimeout(150);
await page2.click('#rescanBtn');
await page2.waitForFunction(() => ST.batch.remaining() >= 4, { timeout: 30000 });
check(true, 'Re-scan Drive photos queues every photo again');
await page2.evaluate(() => { while (ST.batch.remaining()) ST.batch.skip(); });

const pillText = await page2.evaluate(() => document.getElementById('syncPill').textContent);
check(pillText === 'Synced', `sync pill reads “${pillText}”`);
check(jsErrors2.length === 0, `no JS errors in the sync session ${jsErrors2.length ? '→ ' + jsErrors2.slice(0, 3).join(' | ') : ''}`);

console.log('\n— cloud sync: where a letterform came from, on a device that never had its crop');
const keptN = await page2.evaluate(async () => ST.sources.get(ST.store.activeVariant('N').id));
await ctx2.close();
const ctx3 = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 1.5 });
const page3 = await ctx3.newPage();
const jsErrors3 = [];
page3.on('pageerror', (e) => jsErrors3.push(String(e)));
page3.on('console', (m) => { if (m.type() === 'error' && isRealError(m.text())) jsErrors3.push(m.text()); });
await page3.goto(API_BASE);
await page3.waitForSelector('#gateModal.open', { timeout: 10000 });
await page3.fill('#gateInput', '3754');
await page3.click('#gateForm button[type="submit"]');
await page3.waitForFunction(() => globalThis.__st && __st.state().chars.includes('N'), { timeout: 15000 });
await page3.evaluate(async () => {
  document.getElementById('inboxModal').classList.remove('open');
  __st.switchTab('tester');
  await ST.fontlive.rebuild();
  await document.fonts.ready;
  document.getElementById('tester').textContent = 'N';
  ST.fontlive.rewrap();
});
check(await page3.evaluate(async () => !(await ST.sources.get(ST.store.activeVariant('N').id))), 'the new device has no crop of its own');
await page3.locator('#tester span.tl').first().hover();
// (read off the popup the moment it shows: a re-render may close it after)
const popShown = await (await page3.waitForFunction(() => {
  const i = document.querySelector('.src-pop.on img');
  return i && i.complete && i.naturalWidth > 0 && { src: i.src, label: document.querySelector('.src-pop.on .src-pop-label').textContent };
}, null, { timeout: 15000 })).jsonValue();
const recut = await page3.evaluate(async ([kept, shown]) => {
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const gray = (im) => {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0, 32, 32);
    const d = x.getImageData(0, 0, 32, 32).data, o = [];
    for (let i = 0; i < d.length; i += 4) o.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    return o;
  };
  const src = shown.src;
  const [a, b] = await Promise.all([load(src), load(kept)]);
  const A = gray(a), B = gray(b);
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff += Math.abs(A[i] - B[i]);
  return {
    jpeg: src.startsWith('data:image/jpeg;base64,'), label: shown.label,
    diff: diff / A.length, size: [a.naturalWidth, a.naturalHeight], keptSize: [b.naturalWidth, b.naturalHeight],
    keptNow: !!(await ST.sources.get(ST.store.activeVariant('N').id)),
  };
}, [keptN, popShown]);
check(recut.jpeg && recut.label === 'N' && recut.diff < 6,
  `hovering it cuts the bit of photo again from Drive — the same bit the capturing device kept (mean diff ${recut.diff.toFixed(1)}/255, ${recut.size.join('×')} vs ${recut.keptSize.join('×')})`);
check(recut.keptNow, 'and keeps it on this device from then on');
check(jsErrors3.length === 0, `no JS errors on the new device ${jsErrors3.length ? '→ ' + jsErrors3.slice(0, 3).join(' | ') : ''}`);
await ctx3.close();

await browser.close();
server.close();
apiServer.close();

console.log(failures === 0 ? '\nE2E: ALL CHECKS PASSED' : `\nE2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
