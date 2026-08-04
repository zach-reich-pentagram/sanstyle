/* SANSTYLE end-to-end: drives the real app in headless Chromium.
 * Photo (demo wall) → lasso (real mouse) → extract → tag → submit → font
 * compiled → downloaded → validated with the independent parser + fontTools.
 * Also captures the screenshots used in the README.
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
};

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ FAIL: ${msg}`); }
};

// ---- static server ----------------------------------------------------------
const server = createServer((req, res) => {
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
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
console.log('serving', BASE);

// ---- browser ----------------------------------------------------------------
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1560, height: 940 },
  deviceScaleFactor: 1.5,
});

const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

await page.goto(BASE);
await page.waitForFunction(() => globalThis.__st && globalThis.ST);
console.log('\n— app booted');

// ---- Flow A: real-mouse lasso on a demo wall ---------------------------------
console.log('\n— flow A: demo wall “S”, real pointer lasso');
await page.evaluate(() => {
  __st.loadDemo('S');
  ST.capture.skipFlatten();
});
const corners = await page.evaluate(() => {
  const b = ST.capture.lastDemo.letterBox;
  const r = document.getElementById('stage').getBoundingClientRect();
  const pts = [
    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
  ].map((p) => ST.capture.toScreen(p));
  return pts.map((p) => ({ x: p.x + r.left, y: p.y + r.top }));
});
await page.mouse.move(corners[0].x, corners[0].y);
await page.mouse.down();
for (const c of [...corners.slice(1), corners[0]]) {
  await page.mouse.move(c.x, c.y, { steps: 14 });
}
await page.mouse.up();
await page.waitForTimeout(250);

let st = await page.evaluate(() => ({
  step: __st.state().step,
  paths: ST.capture.extract ? ST.capture.extract.paths.length : 0,
  ink: ST.capture.extract ? ST.capture.extract.inkCount : 0,
}));
check(st.step === 'ink', `lasso closed → ink step (got ${st.step})`);
check(st.paths >= 1, `traced ${st.paths} contour(s) from the sprayed S`);
check(st.ink > 2000, `${st.ink}px of paint found`);

await page.fill('#charInput', 'S');
await page.waitForTimeout(120);
await page.screenshot({ path: path.join(SHOTS, 'capture.png') });

await page.click('#submitBtn');
await page.waitForTimeout(120);
st = await page.evaluate(() => __st.state());
check(st.chars.includes('S'), 'S submitted to the library');

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
  check(r.ok && r.paths >= 1, `“${ch}”: ${r.paths} contours, ${r.ink}px ink → submitted`);
}

// ---- Flow C: perspective flatten + color-pick extraction ----------------------
console.log('\n— flow C: flatten (homography) + pick-paint mode');
const flat = await page.evaluate(() => {
  __st.loadDemo('E');
  const before = { w: ST.capture.img.width, h: ST.capture.img.height };
  // skew the quad a little so the warp actually does work
  const q = ST.capture.quad;
  q[0].x += 40; q[0].y += 22; q[1].x -= 25; q[3].y -= 18;
  ST.capture.applyFlatten();
  return { before, after: { w: ST.capture.img.width, h: ST.capture.img.height }, step: ST.capture.step };
});
check(flat.step === 'lasso', 'flatten applied → back to lasso step');
check(flat.after.w !== flat.before.w || flat.after.h !== flat.before.h,
  `warped image resampled (${flat.before.w}×${flat.before.h} → ${flat.after.w}×${flat.after.h})`);

const colorPick = await page.evaluate(() => {
  // color-mode extraction seeded with the demo wall's actual paint color
  const hex = ST.capture.lastDemo.color;
  const seed = {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
  ST.capture.ink.mode = 'color';
  ST.capture.ink.seeds = [seed];
  ST.capture.ink.tol = 38;
  const b = ST.capture.lastDemo.letterBox;
  // the flatten warp shifted geometry; stay inside the image
  const W = ST.capture.img.width, H = ST.capture.img.height;
  const x0 = Math.max(4, b.x - 30), y0 = Math.max(4, b.y - 30);
  const x1 = Math.min(W - 4, b.x + b.w + 30), y1 = Math.min(H - 4, b.y + b.h + 30);
  ST.capture.lasso = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  ST.capture.runExtraction(false);
  const ex = ST.capture.extract;
  // restore luma mode for anything later
  ST.capture.ink.mode = 'luma';
  ST.capture.ink.seeds = [];
  ST.capture.clearLasso();
  return { paths: ex ? ex.paths.length : 0, ink: ex ? ex.inkCount : 0 };
});
check(colorPick.paths >= 1 && colorPick.ink > 2000,
  `pick-paint mode traced the warped E (${colorPick.paths} contours, ${colorPick.ink}px)`);

// ---- font compiled + live ----------------------------------------------------
console.log('\n— live font');
await page.waitForFunction(
  () => __st.state().glyphsMapped >= 14 && __st.fontB64(),
  { timeout: 15000 }
);
const mapped = await page.evaluate(() => __st.state().glyphsMapped);
check(mapped >= 14, `${mapped} codepoints mapped (incl. mirrored case + space)`);
const fontLive = await page.evaluate(async () => {
  await document.fonts.ready;
  return document.fonts.check('20px SanstyleLive', 'S');
});
check(fontLive, 'FontFace "SanstyleLive" is live in the page');

// ---- screenshots: glyphs + drawer + tester ------------------------------------
await page.evaluate(() => __st.switchTab('glyphs'));
await page.waitForTimeout(250);
await page.click('[data-char="S"]');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(SHOTS, 'glyphs.png') });
await page.click('#drawerClose');

await page.evaluate(() => {
  __st.switchTab('tester');
  const t = document.getElementById('tester');
  t.textContent = 'TASTE NOTES #5\nSANSTYLE';
  t.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(SHOTS, 'tester.png') });

// ---- download + validate -------------------------------------------------------
console.log('\n— download & validate TTF');
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#downloadBtn'),
]);
const dlPath = path.join(TMP, 'e2e-download.ttf');
await download.saveAs(dlPath);
check(existsSync(dlPath), `downloaded ${download.suggestedFilename()}`);

const b64 = await page.evaluate(() => __st.fontB64());
const bytes = Buffer.from(b64, 'base64');
writeFileSync(path.join(TMP, 'e2e-font.ttf'), bytes);
check(Buffer.compare(bytes, readFileSync(dlPath)) === 0, 'download matches compiled bytes');

const font = parse(bytes);
check(font.errors.length === 0, `independent parser: 0 errors ${font.errors.length ? JSON.stringify(font.errors) : ''}`);
check(font.unitsPerEm === 1000, 'unitsPerEm 1000');
for (const ch of ['S', 'A', 'E', 'N', 'O', 'T', '5', '#', ' ', 's', 'a']) {
  const gid = font.cmap.get(ch.codePointAt(0));
  check(gid !== undefined, `cmap maps ${JSON.stringify(ch)} → gid ${gid}`);
}
const gidS = font.cmap.get(83);
check(font.hmtx[gidS].advance > 100, `S advance = ${font.hmtx[gidS].advance}`);
const gS = font.glyphs[gidS];
check(gS.yMax > 660 && gS.yMax <= 730, `S cap-height fit (yMax ${gS.yMax})`);

try {
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'validate_font.py'), path.join(TMP, 'e2e-font.ttf')], { encoding: 'utf8' });
  check(out.includes('VALID'), 'fontTools round-trip: VALID');
  console.log(out.split('\n').filter((l) => l.trim()).map((l) => '    ' + l).join('\n'));
} catch (e) {
  failures++;
  console.error('  ✗ fontTools validation failed:\n', e.stdout || e.message);
}

// ---- persistence across reload -------------------------------------------------
console.log('\n— persistence');
await page.reload();
await page.waitForFunction(() => globalThis.__st);
await page.waitForTimeout(400);
const after = await page.evaluate(() => __st.state().chars);
check(after.length >= 8, `library survived reload (${after.length} chars: ${after.join(' ')})`);

// ---- js errors ------------------------------------------------------------------
check(jsErrors.length === 0, `no JS errors on the page ${jsErrors.length ? '→ ' + jsErrors.join(' | ') : ''}`);

await browser.close();
server.close();

console.log(failures === 0 ? '\nE2E: ALL CHECKS PASSED' : `\nE2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
