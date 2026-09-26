// Synthetic graffiti scenes with ground truth, for the extraction bench.
// Each scene: { name, build() → { canvas, truth: {mask, W, H, ox, oy}, click: {x, y}, notes } }
// truth coords: photo pixel (x, y) is truth pixel (x + ox, y + oy) — the
// truth canvas extends past the frame where a letter is cut off by it.
// Used by tools/bench/run.mjs (node tools/bench/run.mjs <tag>).
(function () {
  const rng = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };

  function wall(ctx, W, H, base, noise, seed, blotches) {
    const rnd = rng(seed);
    ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < (blotches || 0); i++) {
      const k = (rnd() - 0.5) * 30;
      ctx.fillStyle = `rgba(${base[0] + k},${base[1] + k},${base[2] + k * 0.9},0.35)`;
      ctx.beginPath(); ctx.ellipse(rnd() * W, rnd() * H, 20 + rnd() * 90, 15 + rnd() * 60, rnd() * 3, 0, Math.PI * 2); ctx.fill();
    }
    const img = ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * noise;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n * 0.9;
    }
    ctx.putImageData(img, 0, 0);
  }

  // paint grain: noise only where the paint color is (within tol of `col`)
  function grain(ctx, W, H, col, tol, amount, seed) {
    const rnd = rng(seed);
    const img = ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const d = Math.abs(img.data[i] - col[0]) + Math.abs(img.data[i + 1] - col[1]) + Math.abs(img.data[i + 2] - col[2]);
      if (d > tol) continue;
      const n = (rnd() - 0.5) * amount;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }

  function stroke(ctx, draw, lw, style) {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lw; ctx.strokeStyle = style;
    ctx.beginPath(); draw(ctx); ctx.stroke();
    ctx.restore();
  }

  // truth mask from a painter (ctx) → called on a (W+2p)×(H+2p) canvas shifted by p
  function truthOf(W, H, pad, paint) {
    const TW = W + 2 * pad, TH = H + 2 * pad;
    const c = document.createElement('canvas'); c.width = TW; c.height = TH;
    const x = c.getContext('2d');
    x.translate(pad, pad);
    paint(x);
    const d = x.getImageData(0, 0, TW, TH).data;
    const mask = new Uint8Array(TW * TH);
    for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] > 128 ? 1 : 0;
    return { mask, W: TW, H: TH, ox: pad, oy: pad };
  }

  function canvas(W, H) { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }

  const scenes = [];

  // 1. a drainpipe in front of an H: the crossbar runs on behind it
  scenes.push({ name: 'pipe-H', build() {
    const W = 900, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [212, 198, 172], 18, 1, 40);
    const draw = (k) => { k.moveTo(250, 220); k.lineTo(250, 800); k.moveTo(630, 220); k.lineTo(630, 800); k.moveTo(250, 500); k.lineTo(630, 500); };
    stroke(x, draw, 62, 'rgb(38,54,124)');
    grain(x, W, H, [38, 54, 124], 40, 22, 2);
    const gr = x.createLinearGradient(405, 0, 480, 0);
    gr.addColorStop(0, 'rgb(78,80,84)'); gr.addColorStop(0.45, 'rgb(172,174,176)'); gr.addColorStop(1, 'rgb(96,98,100)');
    x.fillStyle = gr; x.fillRect(405, 0, 75, H);
    x.fillStyle = 'rgb(60,60,62)'; x.fillRect(398, 300, 89, 18); x.fillRect(398, 760, 89, 18);
    return { canvas: c, truth: truthOf(W, H, 0, (k) => stroke(k, draw, 62, '#000')), click: { x: 250, y: 380 } };
  } });

  // 2. a crack across an O on concrete
  scenes.push({ name: 'crack-O', build() {
    const W = 900, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [190, 190, 186], 22, 3, 60);
    const draw = (k) => { k.ellipse(450, 500, 230, 300, 0, 0, Math.PI * 2); };
    stroke(x, draw, 56, 'rgb(226,110,30)');
    grain(x, W, H, [226, 110, 30], 50, 24, 4);
    const rnd = rng(5);
    x.strokeStyle = 'rgb(58,56,52)'; x.lineJoin = 'miter';
    for (const [a, b] of [[[60, 140], [840, 900]], [[820, 90], [120, 760]]]) {
      x.beginPath(); x.moveTo(a[0], a[1]);
      for (let t = 0.05; t <= 1.0001; t += 0.05) {
        x.lineWidth = 4 + rnd() * 4;
        x.lineTo(a[0] + (b[0] - a[0]) * t + (rnd() - 0.5) * 30, a[1] + (b[1] - a[1]) * t + (rnd() - 0.5) * 30);
      }
      x.stroke();
    }
    return { canvas: c, truth: truthOf(W, H, 0, (k) => stroke(k, draw, 56, '#000')), click: { x: 222, y: 500 } };
  } });

  // 3. a sticker over a C's edge and a leaf over its upper end
  scenes.push({ name: 'sticker-C', build() {
    const W = 900, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [230, 226, 215], 14, 6, 30);
    const draw = (k) => { k.ellipse(470, 500, 260, 320, 0, (40 * Math.PI) / 180, (320 * Math.PI) / 180, false); };
    stroke(x, draw, 60, 'rgb(25,25,28)');
    grain(x, W, H, [25, 25, 28], 40, 18, 7);
    x.save(); x.translate(250, 700); x.rotate(0.35);
    x.fillStyle = 'rgb(250,236,120)'; x.fillRect(-80, -40, 150, 85);
    x.fillStyle = 'rgb(200,40,40)'; x.fillRect(-60, -20, 100, 12);
    x.restore();
    x.fillStyle = 'rgb(72,96,40)';
    x.beginPath(); x.ellipse(560, 230, 70, 38, -0.6, 0, Math.PI * 2); x.fill();
    return { canvas: c, truth: truthOf(W, H, 0, (k) => stroke(k, draw, 60, '#000')), click: { x: 212, y: 480 } };
  } });

  // 4. a blue O painted over a red N's right stem
  scenes.push({ name: 'overlap-N', build() {
    const W = 1000, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [205, 205, 200], 16, 8, 30);
    const draw = (k) => { k.moveTo(240, 800); k.lineTo(240, 220); k.lineTo(620, 800); k.lineTo(620, 220); };
    stroke(x, draw, 60, 'rgb(200,30,40)');
    grain(x, W, H, [200, 30, 40], 50, 22, 9);
    stroke(x, (k) => k.ellipse(730, 540, 160, 210, 0, 0, Math.PI * 2), 60, 'rgb(30,90,200)');
    grain(x, W, H, [30, 90, 200], 50, 22, 10);
    return { canvas: c, truth: truthOf(W, H, 0, (k) => stroke(k, draw, 60, '#000')), click: { x: 240, y: 500 } };
  } });

  // 5. a U whose bottom is cut off by the frame
  scenes.push({ name: 'frame-U', build() {
    const W = 900, H = 820, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [200, 196, 190], 20, 11, 40);
    const draw = (k) => { k.moveTo(260, 150); k.lineTo(260, 700); k.arc(450, 700, 190, Math.PI, 0, true); k.lineTo(640, 150); };
    stroke(x, draw, 64, 'rgb(20,20,24)');
    grain(x, W, H, [20, 20, 24], 40, 18, 12);
    return { canvas: c, truth: truthOf(W, H, 220, (k) => stroke(k, draw, 64, '#000')), click: { x: 260, y: 400 } };
  } });

  // 6. an O whose right side is past the frame
  scenes.push({ name: 'frame-O', build() {
    const W = 720, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [220, 214, 200], 16, 13, 40);
    const draw = (k) => { k.ellipse(520, 500, 230, 300, 0, 0, Math.PI * 2); };
    stroke(x, draw, 58, 'rgb(40,120,70)');
    grain(x, W, H, [40, 120, 70], 50, 20, 14);
    return { canvas: c, truth: truthOf(W, H, 220, (k) => stroke(k, draw, 58, '#000')), click: { x: 290, y: 500 } };
  } });

  // 7. an L whose stem runs out of the top of the frame
  scenes.push({ name: 'frame-L', build() {
    const W = 900, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [214, 210, 204], 16, 15, 40);
    const draw = (k) => { k.moveTo(300, -110); k.lineTo(300, 800); k.lineTo(660, 800); };
    stroke(x, draw, 60, 'rgb(120,30,140)');
    grain(x, W, H, [120, 30, 140], 50, 20, 16);
    return { canvas: c, truth: truthOf(W, H, 220, (k) => stroke(k, draw, 60, '#000')), click: { x: 300, y: 500 } };
  } });

  // 8. paint drips hanging from an E
  scenes.push({ name: 'drips-E', build() {
    const W = 900, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [226, 222, 214], 14, 17, 30);
    const draw = (k) => { k.moveTo(640, 200); k.lineTo(260, 200); k.lineTo(260, 800); k.lineTo(640, 800); k.moveTo(260, 500); k.lineTo(580, 500); };
    const col = 'rgb(190,25,35)';
    stroke(x, draw, 58, col);
    for (const [dx, y0, len, wd] of [[420, 225, 150, 15], [520, 525, 95, 12], [350, 525, 60, 18], [580, 825, 120, 14], [470, 225, 70, 10], [300, 825, 45, 20]]) {
      x.fillStyle = col;
      x.beginPath(); x.moveTo(dx - wd / 2, y0); x.lineTo(dx + wd / 2, y0); x.lineTo(dx + wd * 0.35, y0 + len); x.lineTo(dx - wd * 0.35, y0 + len); x.fill();
      x.beginPath(); x.arc(dx, y0 + len, wd * 0.85, 0, Math.PI * 2); x.fill();
    }
    grain(x, W, H, [190, 25, 35], 50, 22, 18);
    return { canvas: c, truth: truthOf(W, H, 0, (k) => stroke(k, draw, 58, '#000')), click: { x: 260, y: 450 } };
  } });

  // 9. a chrome throw-up B: silver fill, black outline, on a blue-gray wall
  scenes.push({ name: 'throwup-B', build() {
    const W = 900, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [95, 105, 120], 16, 19, 40);
    const shape = (k, grow) => {
      k.beginPath();
      k.ellipse(430, 355, 175 + grow, 155 + grow, 0, 0, Math.PI * 2);
      k.ellipse(455, 650, 195 + grow, 175 + grow, 0, 0, Math.PI * 2);
      k.rect(215 - grow, 200 - grow, 190 + 2 * grow, 620 + 2 * grow);
      k.fill('nonzero');
    };
    const counters = (k, grow) => {
      k.beginPath(); k.ellipse(420, 355, 55 + grow, 42 + grow, 0, 0, Math.PI * 2); k.fill();
      k.beginPath(); k.ellipse(440, 650, 62 + grow, 50 + grow, 0, 0, Math.PI * 2); k.fill();
    };
    x.fillStyle = 'rgb(18,18,20)'; shape(x, 16);
    x.fillStyle = 'rgb(200,202,208)'; shape(x, 0);
    x.fillStyle = 'rgb(18,18,20)'; counters(x, 14);
    x.fillStyle = 'rgb(95,105,120)'; counters(x, 0);
    // chrome shading bands
    x.fillStyle = 'rgba(120,124,132,0.55)';
    x.fillRect(215, 470, 420, 26);
    x.fillStyle = 'rgba(255,255,255,0.6)';
    x.fillRect(240, 240, 20, 520);
    grain(x, W, H, [200, 202, 208], 60, 16, 20);
    const truth = truthOf(W, H, 0, (k) => {
      k.fillStyle = '#000'; shape(k, 16);
      k.globalCompositeOperation = 'destination-out'; counters(k, 0);
    });
    return { canvas: c, truth, click: { x: 300, y: 560 }, notes: 'truth = fill + outline' };
  } });

  // 10. silver on white (the metallic S)
  scenes.push({ name: 'silver-S', build() {
    const W = 900, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    const grd = x.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, '#f4f2ee'); grd.addColorStop(1, '#e6e3dd');
    x.fillStyle = grd; x.fillRect(0, 0, W, H);
    const rnd = rng(9);
    let img = x.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 16; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
    x.putImageData(img, 0, 0);
    const R = 26;
    const P = [[640, 200], [280, 230], [260, 480], [620, 520], [600, 800], [240, 820]];
    const draw = (k) => { k.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) k.lineTo(P[i][0], P[i][1]); };
    stroke(x, draw, 2 * R, '#a4a7ac');
    x.lineCap = 'butt';
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1];
      const d = [b[0] - a[0], b[1] - a[1]]; const L = Math.hypot(d[0], d[1]); const n = [-d[1] / L, d[0] / L];
      x.lineWidth = 9; x.strokeStyle = 'rgba(96,99,105,0.75)';
      x.beginPath(); x.moveTo(a[0] + n[0] * (R - 7), a[1] + n[1] * (R - 7)); x.lineTo(b[0] + n[0] * (R - 7), b[1] + n[1] * (R - 7)); x.stroke();
      const segs = Math.ceil(L / 12);
      for (let k = 0; k < segs; k++) {
        const t0 = k / segs, t1 = (k + 1) / segs;
        const br = 232 + Math.round(22 * Math.abs(Math.sin(k * 0.9 + i)));
        x.lineWidth = 10 + 4 * Math.abs(Math.sin(k * 0.6));
        x.strokeStyle = `rgba(${br},${br},${br - 4},0.92)`;
        x.beginPath();
        x.moveTo(a[0] + d[0] * t0 - n[0] * (R - 12), a[1] + d[1] * t0 - n[1] * (R - 12));
        x.lineTo(a[0] + d[0] * t1 - n[0] * (R - 12), a[1] + d[1] * t1 - n[1] * (R - 12));
        x.stroke();
      }
      for (let k = 0; k < 3; k++) {
        const t = 0.2 + 0.3 * k; const cx = a[0] + d[0] * t, cy = a[1] + d[1] * t;
        x.fillStyle = 'rgba(245,245,243,0.9)';
        x.beginPath(); x.ellipse(cx, cy, 11, 6, Math.atan2(d[1], d[0]), 0, Math.PI * 2); x.fill();
      }
    }
    const truth = truthOf(W, H, 0, (k) => stroke(k, draw, 2 * R, '#000'));
    img = x.getImageData(0, 0, W, H);
    const rnd2 = rng(10);
    for (let i = 0; i < truth.mask.length; i++) if (truth.mask[i]) { const n = (rnd2() - 0.5) * 30; const p = i * 4; img.data[p] += n; img.data[p + 1] += n; img.data[p + 2] += n; }
    x.putImageData(img, 0, 0);
    return { canvas: c, truth, click: { x: 270, y: 350 } };
  } });

  // 11. speckled red M on stucco (sharp valleys)
  scenes.push({ name: 'corners-M', build() {
    const W = 900, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    x.fillStyle = '#d9d5cc'; x.fillRect(0, 0, W, H);
    const rnd = rng(5);
    const img = x.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 40; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n * 0.9; }
    x.putImageData(img, 0, 0);
    const P = [[200, 900], [230, 150], [450, 700], [670, 150], [700, 900]];
    const draw = (k) => { k.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) k.lineTo(P[i][0], P[i][1]); };
    // separate segments, as painted
    for (let i = 0; i < 4; i++) stroke(x, (k) => { k.moveTo(P[i][0], P[i][1]); k.lineTo(P[i + 1][0], P[i + 1][1]); }, 56, '#b3232d');
    const img2 = x.getImageData(0, 0, W, H);
    for (let i = 0; i < img2.data.length; i += 4) { if (img2.data[i] > 150 && img2.data[i + 1] < 90) { const n = (rnd() - 0.5) * 26; img2.data[i] += n; img2.data[i + 1] += n * 0.5; img2.data[i + 2] += n * 0.5; } }
    x.putImageData(img2, 0, 0);
    const truth = truthOf(W, H, 0, (k) => { for (let i = 0; i < 4; i++) stroke(k, (q) => { q.moveTo(P[i][0], P[i][1]); q.lineTo(P[i + 1][0], P[i + 1][1]); }, 56, '#000'); });
    return { canvas: c, truth, click: { x: 215, y: 500 } };
  } });

  // 12. same color: a T whose bar crosses an O's side and ends in its counter
  scenes.push({ name: 'crossing-TO', char: 'T', build() {
    const W = 1000, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [218, 214, 206], 14, 21, 30);
    const drawT = (k) => { k.moveTo(130, 220); k.lineTo(560, 220); k.moveTo(325, 220); k.lineTo(325, 820); };
    const drawO = (k) => { k.ellipse(620, 330, 150, 220, 0, 0, Math.PI * 2); };
    stroke(x, drawT, 56, 'rgb(22,22,26)');
    stroke(x, drawO, 56, 'rgb(22,22,26)');
    grain(x, W, H, [22, 22, 26], 40, 18, 22);
    return { canvas: c, truth: truthOf(W, H, 0, (k) => stroke(k, drawT, 56, '#000')), click: { x: 325, y: 600 } };
  } });

  // 12b. same color: a T whose bar runs along into an O (tangential merge)
  scenes.push({ name: 'merge-TO', char: 'T', build() {
    const W = 1000, H = 1000, c = canvas(W, H), x = c.getContext('2d');
    wall(x, W, H, [218, 214, 206], 14, 21, 30);
    const drawT = (k) => { k.moveTo(130, 220); k.lineTo(520, 220); k.moveTo(325, 220); k.lineTo(325, 820); };
    const drawO = (k) => { k.ellipse(640, 520, 190, 290, 0, 0, Math.PI * 2); };
    stroke(x, drawT, 56, 'rgb(22,22,26)');
    stroke(x, drawO, 56, 'rgb(22,22,26)');
    grain(x, W, H, [22, 22, 26], 40, 18, 22);
    return { canvas: c, truth: truthOf(W, H, 0, (k) => stroke(k, drawT, 56, '#000')), click: { x: 325, y: 600 } };
  } });

  // 13. marker K with fading ends on a dark wall
  scenes.push({ name: 'caps-K', build() {
    const W = 900, H = 1100, c = canvas(W, H), x = c.getContext('2d');
    x.fillStyle = '#1f3a2c'; x.fillRect(0, 0, W, H);
    const rnd = rng(11);
    const img = x.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 34; img.data[i] += n * 0.7; img.data[i + 1] += n; img.data[i + 2] += n * 0.8; }
    x.putImageData(img, 0, 0);
    for (let i = 0; i < 140; i++) {
      x.fillStyle = `rgba(${150 + rnd() * 60},${150 + rnd() * 60},${140 + rnd() * 50},${0.25 + rnd() * 0.5})`;
      x.beginPath(); x.ellipse(rnd() * W, rnd() * H, 3 + rnd() * 9, 2 + rnd() * 6, rnd() * 3, 0, Math.PI * 2); x.fill();
    }
    const strokes = [[[330, 900], [300, 250], 38, 0, 0.22], [[330, 620], [570, 470], 30, 0, 0.28], [[330, 645], [610, 900], 30, 0, 0.22]];
    x.lineCap = 'round';
    for (const [a, b, w, tA, tB] of strokes) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.ceil(len / 2.5);
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n, tm = (t0 + t1) / 2;
        let k = 1;
        if (tA > 0) k = Math.min(k, tm / tA);
        if (tB > 0) k = Math.min(k, (1 - tm) / tB);
        k = Math.min(1, k);
        x.lineWidth = w * (0.2 + 0.8 * Math.pow(k, 0.7));
        x.strokeStyle = `rgba(232,122,104,${(0.35 + 0.65 * k).toFixed(3)})`;
        x.beginPath();
        x.moveTo(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0);
        x.lineTo(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1);
        x.stroke();
      }
    }
    const truth = truthOf(W, H, 0, (k) => { for (const [a, b, w] of strokes) stroke(k, (q) => { q.moveTo(a[0], a[1]); q.lineTo(b[0], b[1]); }, w, '#000'); });
    return { canvas: c, truth, click: { x: 318, y: 700 } };
  } });

  window.BENCH_SCENES = scenes;
})();
