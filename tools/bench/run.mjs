// Extraction bench: node tools/bench/run.mjs <tag> [sceneFilter|all] [smoothing]
// For every synthetic scene: the automatic pipeline and a click, scored
// against the full-letter ground truth (mask IoU, traced-outline IoU, IoU
// inside the frame, contour counts), with overlays written as PNGs.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright-core'));
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname === '/') p = path.join(ROOT, 'index.html');
  try { const body = readFileSync(p); res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => { const t = m.text(); if (!/Failed to load|Canvas2D|willReadFrequently/.test(t)) console.log('LOG', t); });
await page.goto(BASE);
await page.waitForFunction(() => globalThis.__st && globalThis.ST);
await page.addScriptTag({ path: path.join(HERE, 'scenes.js') });

const tag = process.argv[2] || 'base';
const filter = process.argv[3] && process.argv[3] !== 'all' ? process.argv[3] : null;
const smoothing = process.argv[4] != null ? +process.argv[4] : 4;
const OUT = path.join(HERE, 'out', tag);
mkdirSync(OUT, { recursive: true });

const names = await page.evaluate(() => window.BENCH_SCENES.map((s) => s.name));
const rows = [];
for (const name of names) {
  if (filter && !name.includes(filter)) continue;
  const r = await page.evaluate(([name, smoothing]) => {
    const scene = window.BENCH_SCENES.find((s) => s.name === name);
    const { canvas, truth, click } = scene.build();
    const W = canvas.width, H = canvas.height;
    const R = ST.raster;
    const t0 = performance.now();
    const auto = ST.auto.processImage(canvas, { deskew: false, smoothing });
    const tAuto = performance.now() - t0;
    const k = auto.canvas.width / W;
    const t1 = performance.now();
    const seeded = ST.extract.seeded(canvas, click.x, click.y, { smoothing });
    const tClick = performance.now() - t1;

    const score = (cand, kk) => {
      if (!cand) return null;
      const TW = truth.W, TH = truth.H;
      let inter = 0, uni = 0, interIn = 0, uniIn = 0;
      const seen = new Uint8Array(cand.w * cand.h);
      for (let ty = 0; ty < TH; ty++) {
        for (let tx = 0; tx < TW; tx++) {
          const t = truth.mask[ty * TW + tx];
          const px = tx - truth.ox, py = ty - truth.oy;
          const cx = Math.round((px + 0.5) * kk - 0.5) - cand.crop.x, cy = Math.round((py + 0.5) * kk - 0.5) - cand.crop.y;
          let m = 0;
          if (cx >= 0 && cy >= 0 && cx < cand.w && cy < cand.h) { m = cand.mask[cy * cand.w + cx]; seen[cy * cand.w + cx] = 1; }
          if (t && m) inter++;
          if (t || m) uni++;
          if (px >= 0 && py >= 0 && px < W && py < H) { if (t && m) interIn++; if (t || m) uniIn++; }
        }
      }
      // candidate ink mapped outside the truth canvas (scaled: approx)
      let outside = 0;
      if (kk === 1) for (let i = 0; i < seen.length; i++) if (cand.mask[i] && !seen[i]) outside++;
      uni += outside;
      // traced outline, rasterized in truth coords
      const tc = document.createElement('canvas'); tc.width = TW; tc.height = TH;
      const tx = tc.getContext('2d');
      tx.translate(truth.ox, truth.oy); tx.scale(1 / kk, 1 / kk); tx.translate(cand.crop.x, cand.crop.y);
      tx.beginPath();
      for (const p of cand.paths) {
        const cs = p.cubics; tx.moveTo(cs[0][0].x, cs[0][0].y);
        for (const cu of cs) tx.bezierCurveTo(cu[1].x, cu[1].y, cu[2].x, cu[2].y, cu[3].x, cu[3].y);
        tx.closePath();
      }
      tx.fillStyle = '#000'; tx.fill('evenodd');
      const td = tx.getImageData(0, 0, TW, TH).data;
      let ti = 0, tu = 0;
      for (let i = 0; i < truth.mask.length; i++) { const a = truth.mask[i], b = td[i * 4 + 3] > 128; if (a && b) ti++; if (a || b) tu++; }
      return {
        iou: +(inter / uni).toFixed(3), iouIn: +(interIn / Math.max(1, uniIn)).toFixed(3), traceIoU: +(ti / tu).toFixed(3),
        outer: cand.paths.filter((p) => p.area > 0).length, holes: cand.paths.filter((p) => p.area < 0).length, kind: cand.kind || 'auto',
      };
    };
    // expected contours from the truth
    const tl = R.components(truth.mask, truth.W, truth.H);
    const inv = new Uint8Array(truth.mask.length); for (let i = 0; i < inv.length; i++) inv[i] = truth.mask[i] ? 0 : 1;
    const il = R.components(inv, truth.W, truth.H);
    const expect = { outer: tl.sizes.filter((s, i) => i > 0 && s > 30).length, holes: il.sizes.filter((s, i) => i > 0 && s > 30).length - 1 };

    const autoScores = auto.candidates.map((c) => score(c, k));
    let bestA = -1;
    autoScores.forEach((s, i) => { if (s && (bestA < 0 || s.iou > autoScores[bestA].iou)) bestA = i; });
    const clickFirst = seeded ? seeded.candidates[0] : null;
    // a click answered from the automatic pass's shapes (the review queue's
    // click in the worker: which shape, which stroke — nothing regrown)
    const fastRes = ST.auto.clickLetter(auto.shapes, auto.canvas.width, auto.canvas.height, click.x * k, click.y * k);
    const fast = fastRes ? fastRes.candidates[0] : null;
    const clickWhole = seeded ? seeded.candidates[seeded.candidates.length - 1] : null;

    // overlay
    const render = (cand, kk) => {
      const oc = document.createElement('canvas'); oc.width = truth.W; oc.height = truth.H;
      const ox = oc.getContext('2d');
      ox.fillStyle = '#555'; ox.fillRect(0, 0, oc.width, oc.height);
      ox.drawImage(canvas, truth.ox, truth.oy);
      // truth outline
      const tcan = document.createElement('canvas'); tcan.width = truth.W; tcan.height = truth.H;
      const tctx = tcan.getContext('2d'); const tid = tctx.createImageData(truth.W, truth.H);
      for (let y = 1; y < truth.H - 1; y++) for (let x = 1; x < truth.W - 1; x++) {
        const i = y * truth.W + x;
        if (truth.mask[i] && (!truth.mask[i - 1] || !truth.mask[i + 1] || !truth.mask[i - truth.W] || !truth.mask[i + truth.W])) { tid.data[i * 4 + 1] = 230; tid.data[i * 4 + 2] = 255; tid.data[i * 4 + 3] = 255; }
      }
      tctx.putImageData(tid, 0, 0);
      if (cand) {
        const mc = document.createElement('canvas'); mc.width = cand.w; mc.height = cand.h;
        const mctx = mc.getContext('2d'); const md = mctx.createImageData(cand.w, cand.h);
        for (let i = 0; i < cand.mask.length; i++) if (cand.mask[i]) { md.data[i * 4] = 255; md.data[i * 4 + 1] = 60; md.data[i * 4 + 2] = 40; md.data[i * 4 + 3] = 100; }
        mctx.putImageData(md, 0, 0);
        ox.save(); ox.translate(truth.ox, truth.oy); ox.scale(1 / kk, 1 / kk);
        ox.drawImage(mc, cand.crop.x, cand.crop.y);
        ox.translate(cand.crop.x, cand.crop.y);
        ox.lineWidth = 2.5 * kk; ox.strokeStyle = '#e8ff2a';
        for (const p of cand.paths) { const cs = p.cubics; ox.beginPath(); ox.moveTo(cs[0][0].x, cs[0][0].y); for (const cu of cs) ox.bezierCurveTo(cu[1].x, cu[1].y, cu[2].x, cu[2].y, cu[3].x, cu[3].y); ox.closePath(); ox.stroke(); }
        ox.restore();
      }
      ox.drawImage(tcan, 0, 0);
      ox.strokeStyle = '#ff00ff'; ox.lineWidth = 1; ox.strokeRect(truth.ox - 0.5, truth.oy - 0.5, W + 1, H + 1);
      ox.fillStyle = '#ff00ff'; ox.beginPath(); ox.arc(click.x + truth.ox, click.y + truth.oy, 7, 0, Math.PI * 2); ox.fill();
      return oc.toDataURL('image/png');
    };
    return {
      name, expect, tAuto: Math.round(tAuto), tClick: Math.round(tClick),
      autoN: auto.candidates.length, autoBest: bestA, auto: bestA >= 0 ? autoScores[bestA] : null,
      auto0: autoScores[0] || null,
      click: score(clickFirst, 1), clickWhole: clickWhole !== clickFirst ? score(clickWhole, 1) : null,
      fast: fast ? score(fast, k) : null,
      imgAuto: render(bestA >= 0 ? auto.candidates[bestA] : null, k), imgClick: render(clickFirst, 1),
    };
  }, [name, smoothing]);
  writeFileSync(path.join(OUT, `${name}-auto.png`), Buffer.from(r.imgAuto.split(',')[1], 'base64'));
  writeFileSync(path.join(OUT, `${name}-click.png`), Buffer.from(r.imgClick.split(',')[1], 'base64'));
  delete r.imgAuto; delete r.imgClick;
  rows.push(r);
  const f = (s) => (s ? `iou ${s.iou.toFixed(3)} in ${s.iouIn.toFixed(3)} trace ${s.traceIoU.toFixed(3)} ${s.outer}o/${s.holes}h` : '—');
  console.log(`${name.padEnd(12)} exp ${r.expect.outer}o/${r.expect.holes}h | auto[${r.autoBest}/${r.autoN}] ${f(r.auto)} | click ${r.click ? r.click.kind : ''} ${f(r.click)}${r.clickWhole ? ` | whole ${f(r.clickWhole)}` : ''}${r.fast ? ` | fast ${r.fast.kind} ${f(r.fast)}` : ''} | ${r.tAuto}+${r.tClick}ms`);
}
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 1));
const mean = (key, sub) => { const v = rows.map((r) => r[sub] && r[sub][key]).filter((x) => x != null); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : '—'; };
console.log(`MEAN auto iou ${mean('iou', 'auto')} trace ${mean('traceIoU', 'auto')} | click iou ${mean('iou', 'click')} trace ${mean('traceIoU', 'click')}`);
await browser.close();
server.close();
