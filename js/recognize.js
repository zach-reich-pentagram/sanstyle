/* SANSTYLE — recognize.js
 * Which character is this, and is it one character at all? A small
 * convolutional network (weights in letters-model.js) reads a letter's mask
 * the way it was trained: the ink's bounding box fit into 28 px of a 32×32
 * grid, aspect kept, each cell the share of it the ink covers. It was
 * trained on handwritten characters and ~700 fonts distorted to look like
 * extracted graffiti (weight, slant, wobble, drips, ragged edges, specks),
 * and on "junk" — several letters fused, scribbles, blobs, stickers — so it
 * can also say "this is not one letter". Runs anywhere (page, worker, Node).
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const rec = (ST.recognize = {});
  const N = 32, BOX = 28;

  // base64 → ArrayBuffer, without atob/Buffer (not every realm has them)
  const B64 = new Int16Array(128).fill(-1);
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { B64[c.charCodeAt(0)] = i; });
  function bytes(b64) {
    let n = b64.length;
    while (n && b64[n - 1] === '=') n--;
    const out = new Uint8Array(Math.floor((n * 3) / 4));
    let acc = 0, bits = 0, o = 0;
    for (let i = 0; i < n; i++) {
      acc = (acc << 6) | B64[b64.charCodeAt(i)];
      bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
    }
    return out.buffer;
  }

  let net = null;
  function load() {
    if (net) return net;
    const m = ST.lettersModel;
    if (!m) return null;
    net = {
      classes: m.classes,
      junk: m.classes.indexOf('junk'),
      layers: m.layers.map((L) => {
        const q = new Int8Array(bytes(L.w));
        const scale = new Float32Array(bytes(L.scale));
        const bias = new Float32Array(bytes(L.bias));
        const oc = L.shape[0], per = q.length / oc;
        const W = new Float32Array(q.length);
        for (let o = 0; o < oc; o++) for (let i = 0; i < per; i++) W[o * per + i] = q[o * per + i] * scale[o];
        return { kind: L.kind, shape: L.shape, W, bias };
      }),
    };
    return net;
  }
  rec.ready = () => !!load();
  rec.classes = () => (load() ? net.classes.filter((c) => c !== 'junk') : []);

  /**
   * The network's input for a mask: 32×32 Float32Array, the ink's bounding
   * box fit into 28 px (aspect kept), centered, each cell holding exactly
   * how much of it the ink covers (area-weighted, via the integral image).
   */
  rec.input = function (mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!mask[row + x]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    const out = new Float32Array(N * N);
    if (x1 < 0) return out;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, sw = bw + 1;
    const S = new Float64Array((bh + 1) * sw);
    for (let y = 0; y < bh; y++) {
      let run = 0;
      const src = (y + y0) * w + x0, dst = (y + 1) * sw;
      for (let x = 0; x < bw; x++) {
        run += mask[src + x] ? 1 : 0;
        S[dst + x + 1] = S[dst - sw + x + 1] + run;
      }
    }
    const s = BOX / Math.max(bw, bh);
    const ox = (N - bw * s) / 2, oy = (N - bh * s) / 2;
    const clampTo = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
    const u0 = new Float64Array(N), u1 = new Float64Array(N), v0 = new Float64Array(N), v1 = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      u0[j] = clampTo((j - ox) / s, bw); u1[j] = clampTo((j + 1 - ox) / s, bw);
      v0[j] = clampTo((j - oy) / s, bh); v1[j] = clampTo((j + 1 - oy) / s, bh);
    }
    // the integral image read bilinearly: the exact ink area of a box
    const F = (v, u) => {
      const vi = Math.min(Math.floor(v), bh - 1), ui = Math.min(Math.floor(u), bw - 1);
      const fv = v - vi, fu = u - ui, r0 = vi * sw + ui, r1 = r0 + sw;
      return S[r0] * (1 - fv) * (1 - fu) + S[r0 + 1] * (1 - fv) * fu + S[r1] * fv * (1 - fu) + S[r1 + 1] * fv * fu;
    };
    const k = s * s;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const a = F(v1[r], u1[c]) - F(v0[r], u1[c]) - F(v1[r], u0[c]) + F(v0[r], u0[c]);
        const v = a * k;
        out[r * N + c] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
    return out;
  };

  // 3×3 convolution, padding 1, + bias, ReLU. The input is padded by a
  // pixel all round once, so the inner loop reads nine neighbors with no
  // edge checks and writes each output once per input channel.
  function conv(inp, C, H, W, L) {
    const OC = L.shape[0], HW = H * W, Wt = L.W;
    const PW = W + 2, PHW = (H + 2) * PW;
    const pad = new Float32Array(C * PHW);
    for (let c = 0; c < C; c++) {
      for (let y = 0; y < H; y++) pad.set(inp.subarray(c * HW + y * W, c * HW + (y + 1) * W), c * PHW + (y + 1) * PW + 1);
    }
    const out = new Float32Array(OC * HW);
    for (let oc = 0; oc < OC; oc++) {
      const ob = oc * HW;
      out.fill(L.bias[oc], ob, ob + HW);
      for (let ic = 0; ic < C; ic++) {
        const kb = (oc * C + ic) * 9;
        const w0 = Wt[kb], w1 = Wt[kb + 1], w2 = Wt[kb + 2], w3 = Wt[kb + 3], w4 = Wt[kb + 4];
        const w5 = Wt[kb + 5], w6 = Wt[kb + 6], w7 = Wt[kb + 7], w8 = Wt[kb + 8];
        const pb = ic * PHW;
        for (let y = 0; y < H; y++) {
          const r0 = pb + y * PW, r1 = r0 + PW, r2 = r1 + PW, o = ob + y * W;
          for (let x = 0; x < W; x++) {
            out[o + x] +=
              w0 * pad[r0 + x] + w1 * pad[r0 + x + 1] + w2 * pad[r0 + x + 2] +
              w3 * pad[r1 + x] + w4 * pad[r1 + x + 1] + w5 * pad[r1 + x + 2] +
              w6 * pad[r2 + x] + w7 * pad[r2 + x + 1] + w8 * pad[r2 + x + 2];
          }
        }
      }
      for (let i = ob; i < ob + HW; i++) if (out[i] < 0) out[i] = 0;
    }
    return out;
  }

  function pool(inp, C, H, W) {
    const h = H >> 1, w = W >> 1, out = new Float32Array(C * h * w);
    for (let c = 0; c < C; c++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = c * H * W + 2 * y * W + 2 * x;
          out[c * h * w + y * w + x] = Math.max(inp[i], inp[i + 1], inp[i + W], inp[i + W + 1]);
        }
      }
    }
    return out;
  }

  function dense(inp, L, relu) {
    const O = L.shape[0], I = L.shape[1], out = new Float32Array(O);
    for (let o = 0; o < O; o++) {
      let acc = L.bias[o];
      const b = o * I;
      for (let i = 0; i < I; i++) acc += L.W[b + i] * inp[i];
      out[o] = relu && acc < 0 ? 0 : acc;
    }
    return out;
  }

  /** Class probabilities (softmax) for a 32×32 input, or null without a model. */
  rec.probs = function (input) {
    if (!load()) return null;
    const L = net.layers;
    let x = input, C = 1, S = N;
    for (let k = 0; k < 4; k++) {
      x = conv(x, C, S, S, L[k]);
      C = L[k].shape[0];
      if (k < 3) { x = pool(x, C, S, S); S >>= 1; }
    }
    x = dense(x, L[4], true);
    x = dense(x, L[5], false);
    let m = -Infinity;
    for (let i = 0; i < x.length; i++) if (x[i] > m) m = x[i];
    let sum = 0;
    for (let i = 0; i < x.length; i++) { x[i] = Math.exp(x[i] - m); sum += x[i]; }
    for (let i = 0; i < x.length; i++) x[i] /= sum;
    return x;
  };

  // How often each kind of character turns up on a wall: letters and digits
  // all the time, and ! ? # * about as often; % & @ $, brackets, slashes and the
  // math signs hardly ever. Readings are weighed by it, so a messy shape is
  // not read as a "%" just because it is messy — a rare symbol has to look
  // like one very clearly.
  const PRIOR = { common: 1, some: 1, rare: 0.15 };
  let weights = null;
  function prior() {
    if (!weights) {
      weights = Float32Array.from(net.classes, (ch) =>
        ch === 'junk' || /^[0-9A-Za-z]$/.test(ch) ? PRIOR.common : '!?#*'.includes(ch) ? PRIOR.some : PRIOR.rare);
    }
    return weights;
  }

  /**
   * Read a letter mask. → { ranked: [{ch, p}] best first (characters only),
   *   junk: probability it is not one character, letterness: 1 − junk } or
   *   null without a model or ink.
   */
  rec.classify = function (mask, w, h) {
    if (!load()) return null;
    const p = rec.probs(rec.input(mask, w, h));
    const wt = prior();
    let sum = 0;
    for (let i = 0; i < p.length; i++) { p[i] *= wt[i]; sum += p[i]; }
    if (sum > 0) for (let i = 0; i < p.length; i++) p[i] /= sum;
    const ranked = [];
    for (let i = 0; i < p.length; i++) if (i !== net.junk) ranked.push({ ch: net.classes[i], p: p[i] });
    ranked.sort((a, b) => b.p - a.p);
    const junk = p[net.junk];
    return { ranked, junk, letterness: 1 - junk };
  };
})(typeof window !== 'undefined' ? window : globalThis);
