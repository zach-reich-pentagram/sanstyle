/* SANSTYLE — demo.js
 * Procedural demo walls: a seeded spray-painted letter on a brick wall so the
 * whole capture flow can be tried (and e2e-tested) without a photo.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const demo = (ST.demo = {});

  // Hand-style stroke skeletons in a unit box (y down).
  const STROKES = {
    A: [[[0.06, 1], [0.5, 0], [0.94, 1]], [[0.24, 0.64], [0.78, 0.6]]],
    E: [[[0.86, 0.04], [0.16, 0.02], [0.14, 0.98], [0.88, 0.96]], [[0.16, 0.5], [0.66, 0.5]]],
    N: [[[0.1, 1], [0.08, 0.02]], [[0.08, 0.02], [0.9, 0.98]], [[0.9, 0.98], [0.92, 0]]],
    O: [(() => {
      const pts = [];
      for (let i = 0; i <= 26; i++) {
        const t = (i / 26) * Math.PI * 2;
        pts.push([0.5 + 0.4 * Math.cos(t), 0.5 + 0.47 * Math.sin(t)]);
      }
      return pts;
    })()],
    S: [[[0.84, 0.16], [0.62, 0.03], [0.3, 0.05], [0.15, 0.22], [0.2, 0.4], [0.48, 0.5],
        [0.74, 0.58], [0.86, 0.72], [0.76, 0.9], [0.46, 0.98], [0.14, 0.88]]],
    T: [[[0.05, 0.05], [0.95, 0.03]], [[0.5, 0.04], [0.48, 1]]],
    '5': [[[0.84, 0.03], [0.2, 0.02], [0.16, 0.44]],
          [[0.16, 0.44], [0.52, 0.36], [0.82, 0.5], [0.84, 0.72], [0.6, 0.94], [0.18, 0.9]]],
    '#': [[[0.36, 0.06], [0.28, 0.96]], [[0.72, 0.04], [0.64, 0.94]],
          [[0.12, 0.36], [0.9, 0.34]], [[0.1, 0.68], [0.88, 0.66]]],
  };
  demo.letters = Object.keys(STROKES);

  const PAINTS = ['#20242e', '#8e1f24', '#1d3a7c', '#0e0f10'];

  function drawWall(ctx, w, h, rnd) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#b9b2a4');
    grad.addColorStop(1, '#a49d90');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    // bricks
    const bh = 74, bw = 190;
    for (let row = 0; row * bh < h + bh; row++) {
      const y = row * bh;
      ctx.fillStyle = 'rgba(90,80,70,0.28)';
      ctx.fillRect(0, y, w, 5);
      const off = row % 2 ? bw / 2 : 0;
      for (let x = -bw; x < w + bw; x += bw) {
        ctx.fillRect(x + off, y, 5, bh);
      }
      // per-brick tint
      for (let x = -bw; x < w + bw; x += bw) {
        ctx.fillStyle = `rgba(${140 + rnd() * 40}, ${120 + rnd() * 30}, ${100 + rnd() * 25}, 0.12)`;
        ctx.fillRect(x + off + 5, y + 5, bw - 5, bh - 5);
      }
    }
    // speckle + stains
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * w, y = rnd() * h;
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(60,52,44,0.10)' : 'rgba(240,236,226,0.10)';
      ctx.fillRect(x, y, 1.6, 1.6);
    }
    for (let i = 0; i < 5; i++) {
      const x = rnd() * w, y = rnd() * h, r = 60 + rnd() * 160;
      const stain = ctx.createRadialGradient(x, y, 0, x, y, r);
      stain.addColorStop(0, 'rgba(70,64,52,0.14)');
      stain.addColorStop(1, 'rgba(70,64,52,0)');
      ctx.fillStyle = stain;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  function sprayStroke(ctx, pts, rnd, color, coreR) {
    // resample the polyline and stamp soft dots along it
    for (let pass = 0; pass < 2; pass++) {
      const r = pass === 0 ? coreR * 1.9 : coreR;
      const alpha = pass === 0 ? 0.10 : 0.34;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        const dist = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(2, Math.ceil(dist / 3));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = x0 + (x1 - x0) * t + (rnd() - 0.5) * 2.4;
          const y = y0 + (y1 - y0) * t + (rnd() - 0.5) * 2.4;
          const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
          gradient.addColorStop(0, color + Math.round(alpha * 255).toString(16).padStart(2, '0'));
          gradient.addColorStop(1, color + '00');
          ctx.fillStyle = gradient;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  /**
   * Build a demo wall. Returns {canvas, letterBox, letter} where letterBox is
   * the padded region (in image px) containing the sprayed letter.
   */
  demo.makeWall = function (letter, seed) {
    const w = 1200, h = 860;
    const rnd = ST.rng(seed || 20260804);
    const cnv = (typeof OffscreenCanvas !== 'undefined' && !g.document)
      ? new OffscreenCanvas(w, h)
      : (() => { const c = g.document.createElement('canvas'); c.width = w; c.height = h; return c; })();
    const ctx = cnv.getContext('2d');
    drawWall(ctx, w, h, rnd);

    const strokes = STROKES[letter] || STROKES.S;
    const color = PAINTS[Math.floor(rnd() * PAINTS.length)];
    const LH = 470 + rnd() * 60;                 // letter height on the wall
    const LW = LH * (letter === '#' ? 0.95 : 0.78);
    const ox = w / 2 - LW / 2 + (rnd() - 0.5) * 120;
    const oy = h / 2 - LH / 2 + (rnd() - 0.5) * 60;
    const rot = (rnd() - 0.5) * 0.09;            // slight hand tilt

    ctx.save();
    ctx.translate(ox + LW / 2, oy + LH / 2);
    ctx.rotate(rot);
    ctx.transform(1, 0, -0.06, 1, 0, 0);         // slight italic shear
    ctx.translate(-LW / 2, -LH / 2);
    const mapped = strokes.map((s) => s.map(([ux, uy]) => [ux * LW, uy * LH]));
    for (const s of mapped) sprayStroke(ctx, s, rnd, color, 15);
    // drips
    for (const s of mapped) {
      for (const [x, y] of s) {
        if (rnd() < 0.16) {
          const len = 30 + rnd() * 90;
          const grd = ctx.createLinearGradient(x, y, x, y + len);
          grd.addColorStop(0, color + '66');
          grd.addColorStop(1, color + '00');
          ctx.fillStyle = grd;
          ctx.fillRect(x - 2.2, y, 4.4, len);
        }
      }
    }
    ctx.restore();

    const pad = 90;
    return {
      canvas: cnv,
      letter,
      color,
      letterBox: {
        x: Math.max(0, ox - pad),
        y: Math.max(0, oy - pad),
        w: Math.min(w, LW + pad * 2),
        h: Math.min(h, LH + pad * 2),
      },
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
