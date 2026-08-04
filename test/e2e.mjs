/* Sanstyle end-to-end: drives the real app in headless Chromium.
 * Covers the manual flow (mouse lasso, polygon lasso, flatten, pick-paint),
 * the automated flow (detect → guess → review → accept), HEIC intake,
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
  guess: ST.capture.guess && ST.capture.guess.length ? ST.capture.guess[0].ch : null,
}));
check(st.step === 'ink' && st.paths >= 1, `freehand lasso traced (${st.paths} contours)`);
check(typeof st.guess === 'string' && st.guess.length === 1, `classifier produced a guess (“${st.guess}”)`);
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
  check(r.ok && r.paths >= 1, `“${ch}”: ${r.paths} contours → submitted (guess was “${r.guess}”)`);
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

// ---- auto flow: detect → guess → review → accept ---------------------------------
console.log('\n— auto capture + review queue');
const autoRes = await page.evaluate(() => __st.autoFromDemo('T'));
check(autoRes.candidates >= 1, `auto pipeline found ${autoRes.candidates} candidate(s) on a demo wall`);
await page.evaluate(() => ST.batch.reopen());
await page.waitForTimeout(200);
const modalOpen = await page.evaluate(() => document.getElementById('reviewModal').classList.contains('open'));
check(modalOpen, 'review modal opened');
const guessInfo = await page.evaluate(() => ({
  guess: document.getElementById('reviewChar').value,
  conf: document.getElementById('reviewConf').textContent,
}));
check(guessInfo.conf.length > 0, `review shows prediction (${JSON.stringify(guessInfo.guess)} — ${guessInfo.conf.slice(0, 48)}…)`);
await page.screenshot({ path: path.join(SHOTS, 'review.png') });
const beforeT = await page.evaluate(() => (ST.store.slot('T') ? ST.store.slot('T').variants.length : 0));
await page.fill('#reviewChar', 'T');
await page.click('#reviewAccept');
await page.waitForTimeout(150);
const afterT = await page.evaluate(() => (ST.store.slot('T') ? ST.store.slot('T').variants.length : 0));
check(afterT === beforeT + 1, 'review Accept added the letterform to the library');
await page.evaluate(() => ST.batch.close());

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

await browser.close();
server.close();

console.log(failures === 0 ? '\nE2E: ALL CHECKS PASSED' : `\nE2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
