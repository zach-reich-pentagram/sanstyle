/* SANSTYLE — letters.js
 * Which strokes make one letter? A shape pulled from a photo is often a
 * word, or a letter fused with a neighbor, a sticker or a drip. Its strokes
 * (extract.strokeChains) are grouped into letters by reading candidate
 * groupings with the recognizer (recognize.js): a group that reads clearly
 * as one character is a letter; one that reads as several letters, or as
 * no letter at all, is not. The letter the photo is about — a big, clear
 * letter near the middle, not one cut off by the frame — comes first.
 */
(function (g) {
  'use strict';
  const ST = g.ST || (g.ST = {});
  const L = (ST.letters = {});

  const WORK = 112; // px: candidate groupings are drawn and read at this size

  // Each stroke as discs along its skeleton at the working size: any
  // combination of strokes redraws in a blink.
  function strokeModel(sc, w, h) {
    const f = Math.max(1, Math.max(w, h) / WORK);
    const lw = Math.ceil(w / f) + 2, lh = Math.ceil(h / f) + 2;
    const step = Math.max(1, Math.floor(f / 2));
    const discs = [null];
    const len = [0];
    for (let c = 1; c <= sc.n; c++) {
      const px = sc.skel[c], arr = [];
      for (let k = 0; k < px.length; k += step) {
        const p = px[k];
        arr.push((p % w) / f + 1, ((p / w) | 0) / f + 1, Math.max(0.5, sc.dt[p] / f));
      }
      discs.push(Float32Array.from(arr));
      len.push(px.length);
    }
    return { f, lw, lh, discs, len };
  }

  function draw(m, set) {
    const out = new Uint8Array(m.lw * m.lh);
    for (const c of set) {
      const d = m.discs[c];
      for (let k = 0; k < d.length; k += 3) {
        const cx = d[k], cy = d[k + 1], r = d[k + 2], rr = r * r + 0.25;
        const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(m.lw - 1, Math.ceil(cx + r));
        const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(m.lh - 1, Math.ceil(cy + r));
        for (let y = y0; y <= y1; y++) {
          const dy = y - cy;
          for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            if (dx * dx + dy * dy <= rr) out[y * m.lw + x] = 1;
          }
        }
      }
    }
    return out;
  }

  function nearestInk(mask, w, h, px, py, radius) {
    const x = Math.round(px), y = Math.round(py);
    let best = -1, bd = Infinity;
    for (let yy = Math.max(0, y - radius); yy <= Math.min(h - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(w - 1, x + radius); xx++) {
        if (!mask[yy * w + xx]) continue;
        const d = (xx - x) * (xx - x) + (yy - y) * (yy - y);
        if (d < bd) { bd = d; best = yy * w + xx; }
      }
    }
    return best;
  }

  function boundsOf(mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1, n };
  }

  // Characters that are one shape on a wall: a letter's two cases where
  // they look alike, O and 0, l and I and 1. How sure the recognizer is
  // that a shape is ONE character is the sum over the look-alikes (an O
  // read as 45% "0", 29% "O", 24% "o" is a sure thing).
  const SAME = { 0: 'O', 1: 'I', l: 'I', '|': 'I' };
  const shapeOf = (ch) => SAME[ch] || ch.toUpperCase();

  // How clearly a reading ({letterness, ranked|top}) is one character.
  L.clarity = function (r) {
    const top = r && (r.ranked || r.top);
    if (!top || !top.length) return 0;
    const sum = new Map();
    let best = 0;
    for (const x of top) {
      const k = shapeOf(x.ch), v = (sum.get(k) || 0) + x.p;
      sum.set(k, v);
      if (v > best) best = v;
    }
    return r.letterness * Math.sqrt(Math.min(1, best));
  };

  // Is a letter found inside a shape worth more than the shape itself? When
  // the whole reads as several letters (or none), or the letter reads
  // clearly better — not when the whole is a fine letter that happens to
  // have a thin spot.
  L.better = function (letterRead, wholeRead) {
    if (!letterRead) return false;
    if (!wholeRead || wholeRead.letterness < 0.6) return letterRead.letterness >= 0.5;
    return L.clarity(letterRead) > L.clarity(wholeRead) + 0.1;
  };

  /**
   * The letters in a shape. `opts.center` ({x, y}, mask px): where the
   * photo's subject is (the frame's middle, or a click); `opts.frame`
   * ({x0, y0, x1, y1}): the photo's extent in mask px, to tell a letter the
   * frame cut off; `opts.must` ({x, y}): a point the letter is known to
   * cover (a click) — only groupings holding the stroke there count, and
   * just the best is returned; `opts.target`: a character the letter is
   * known to be (typed) — groupings are judged by how much they read as it. → { sc (the stroke pieces), letters:
   * [{ set (piece ids), read, score, box }] best first, whole: the whole
   * shape's reading } or null (no recognizer, or a single stroke). The
   * full-size mask of a letter: L.render(found, mask, w, h, letter).
   */
  L.find = function (mask, w, h, opts) {
    const o = opts || {};
    if (!ST.recognize || !ST.recognize.ready()) return null;
    // strokes that stop wherever they meet another: a letter's bar that
    // runs on into its neighbor must be able to come apart there
    const sc = ST.extract.strokeChains(mask, w, h, { continuation: false });
    // a shape in dozens of pieces is a blob, a mess or a whole wall of
    // writing, not a letter or two to tell apart
    if (!sc || sc.n < 2 || sc.n > (o.maxPieces || 36)) return null;
    const m = strokeModel(sc, w, h);
    const center = o.center || { x: w / 2, y: h / 2 };
    const cx = center.x / m.f + 1, cy = center.y / m.f + 1;
    const fr = o.frame ? { x0: o.frame.x0 / m.f + 1, y0: o.frame.y0 / m.f + 1, x1: o.frame.x1 / m.f + 1, y1: o.frame.y1 / m.f + 1 } : null;

    // neighbors: strokes meeting at a junction, and strokes of separate
    // pieces that come within a stroke or so of each other (a gap a glint
    // or a crack left)
    const adj = sc.adj.map((s) => new Set(s));
    const all = draw(m, Array.from({ length: sc.n }, (_, i) => i + 1));
    const whole = boundsOf(all, m.lw, m.lh);
    if (!whole) return null;
    // a fat letter (a throw-up, a bubble letter) is no bundle of strokes:
    // its skeleton is no guide to where one letter ends
    if (sc.sw / m.f > 0.15 * (Math.max(whole.x1 - whole.x0, whole.y1 - whole.y0) + 1)) return null;
    const gap = Math.max(2, (1.5 * sc.sw) / m.f);
    for (let a = 1; a <= sc.n; a++) {
      const da = m.discs[a];
      for (let b = a + 1; b <= sc.n; b++) {
        if (adj[a].has(b)) continue;
        const db = m.discs[b];
        let near = false;
        for (let i = 0; i < da.length && !near; i += 3) {
          for (let j = 0; j < db.length; j += 3) {
            const d = Math.hypot(da[i] - db[j], da[i + 1] - db[j + 1]) - da[i + 2] - db[j + 2];
            if (d <= gap) { near = true; break; }
          }
        }
        if (near) { adj[a].add(b); adj[b].add(a); }
      }
    }

    const cache = new Map();
    const gapClose = Math.round((0.6 * sc.sw) / m.f);
    const target = o.target ? new Set([o.target, o.target.toUpperCase(), o.target.toLowerCase()]) : null;
    // how good a grouping is: how clearly it is one character — or, with a
    // character asked for, how clearly it is that one
    const quality = (r) => (target ? r.letterness * Math.sqrt(r.want || 0) : L.clarity(r));
    const read = (set) => {
      const ids = Array.from(set).sort((a, b) => a - b);
      const key = ids.join(',');
      let r = cache.get(key);
      if (r) return r;
      let img = draw(m, ids);
      const bb = boundsOf(img, m.lw, m.lh);
      r = { key, ids, bb };
      if (bb) {
        // strokes put forward as one letter are read with the small gaps
        // between them closed, as the eye closes them (an N drawn in three
        // strokes that don't quite touch is an N)
        if (ids.length > 1 && gapClose >= 1) img = ST.raster.close(img, m.lw, m.lh, gapClose);
        const cl = ST.recognize.classify(img, m.lw, m.lh);
        r.junk = cl.junk; r.letterness = cl.letterness;
        // the rare symbols (% & @ $ …) never decide how a shape splits into
        // letters: a messy group of strokes reads as one of them too easily
        r.top = cl.ranked.filter((x) => /^[0-9A-Za-z!?#*]$/.test(x.ch)).slice(0, 5);
        // a character asked for: how much this grouping reads as it (either
        // case — a k and a K are the same shape often enough)
        if (target) { r.want = 0; for (const x of cl.ranked) if (target.has(x.ch)) r.want += x.p; }
      } else { r.junk = 1; r.letterness = 0; r.top = []; r.want = 0; }
      cache.set(key, r);
      return r;
    };

    // seeds: the strokes nearest the middle, and the longest
    const dist = [];
    for (let c = 1; c <= sc.n; c++) {
      const d = m.discs[c];
      let best = Infinity;
      for (let k = 0; k < d.length; k += 3) best = Math.min(best, Math.hypot(d[k] - cx, d[k + 1] - cy));
      dist.push({ c, d: best, len: m.len[c] });
    }
    const seeds = new Set();
    // a click names the stroke the letter holds
    let must = 0;
    if (o.must) {
      const at = nearestInk(mask, w, h, o.must.x, o.must.y, Math.round(2 * sc.sw) + 4);
      if (at >= 0) {
        must = sc.owner[at];
        if (must < 0) {
          // on a junction: the stroke through it whose tube holds the point
          const arms = Array.from(sc.armsOf[-must - 1]);
          must = arms.find((c) => sc.tubes[c].indexOf(at) >= 0) || arms[0] || 0;
        }
      }
      if (!(must > 0)) return null;
      seeds.add(must);
    } else {
      dist.slice().sort((a, b) => a.d - b.d).slice(0, o.seeds || 4).forEach((s) => seeds.add(s.c));
      dist.slice().sort((a, b) => b.len - a.len).slice(0, 2).forEach((s) => seeds.add(s.c));
    }

    // beam search: grow each seed stroke by stroke, keeping the groupings
    // that read most like one letter
    const B = o.beam || (must ? 3 : 2), depth = Math.min(sc.n, o.depth || 14);
    read(new Set(Array.from({ length: sc.n }, (_, i) => i + 1)));
    // (a budget of readings keeps a busy shape from taking forever)
    const budget = o.budget || 200;
    for (const s of seeds) {
      if (cache.size >= budget) break;
      let beam = [read(new Set([s]))];
      for (let d = 1; d < depth; d++) {
        const next = new Map();
        for (const r of beam) {
          const have = new Set(r.ids);
          for (const c of r.ids) {
            for (const nb of adj[c]) {
              if (have.has(nb) || cache.size >= budget) continue;
              const t = new Set(have); t.add(nb);
              const rr = read(t);
              next.set(rr.key, rr);
            }
          }
        }
        if (!next.size) break;
        beam = Array.from(next.values()).sort((a, b) => quality(b) - quality(a)).slice(0, B);
      }
    }

    // score every clear reading: clear, big, central, whole
    const totalN = whole.n;
    const diag = Math.hypot(m.lw, m.lh);
    const scored = [];
    const tallest = Math.max(whole.y1 - whole.y0, whole.x1 - whole.x0) + 1;
    const scoreOf = (r) => {
      const clear = quality(r);
      // big: its ink, and its height beside the tallest thing here (a dot
      // or a flake can read clearly too)
      const size = Math.pow(r.bb.n / totalN, 0.3) * Math.pow(Math.min(1, (Math.max(r.bb.y1 - r.bb.y0, r.bb.x1 - r.bb.x0) + 1) / tallest), 0.5);
      const bx = (r.bb.x0 + r.bb.x1) / 2, by = (r.bb.y0 + r.bb.y1) / 2;
      const dc = Math.hypot(bx - cx, by - cy) / diag;
      const central = Math.exp(-(dc * dc) / (2 * 0.22 * 0.22));
      let cutOff = 1;
      if (fr) {
        const touch = (r.bb.x0 <= fr.x0 + 1) + (r.bb.x1 >= fr.x1 - 1) + (r.bb.y0 <= fr.y0 + 1) + (r.bb.y1 >= fr.y1 - 1);
        cutOff = touch ? 0.75 : 1;
      }
      r.score = clear * size * central * cutOff;
      r.clear = clear;
      r.place = size * central * cutOff;
      scored.push(r);
    };
    for (const r of cache.values()) if (r.bb && r.top.length) scoreOf(r);
    // A letter taken out of a shape has to leave the rest explained: each
    // piece of what is left reads as a letter of its own, is a crumb (a
    // flake, a drip), or was cut off by the frame. Taking a stem out of an
    // M leaves an M's worth of strokes that read as nothing much — the M is
    // the letter; taking the k out of "ck" leaves a c. The evidence for the
    // split is how clearly each letter of it reads, all together, against
    // how clearly the shape reads whole.
    const wholeRead = read(new Set(Array.from({ length: sc.n }, (_, i) => i + 1)));
    const wholeClear = quality(wholeRead);
    const touchesFrame = (bb) => fr && ((bb.x0 <= fr.x0 + 1) + (bb.x1 >= fr.x1 - 1) + (bb.y0 <= fr.y0 + 1) + (bb.y1 >= fr.y1 - 1)) > 0;
    const explain = (r) => {
      if (r.ids.length === sc.n) return true;
      const inSet = new Set(r.ids);
      const seen = new Set();
      let ev = r.clear;
      for (let c = 1; c <= sc.n; c++) {
        if (inSet.has(c) || seen.has(c)) continue;
        const grp = [c], stack = [c];
        seen.add(c);
        while (stack.length) {
          const u = stack.pop();
          for (const v of adj[u]) if (!inSet.has(v) && !seen.has(v)) { seen.add(v); grp.push(v); stack.push(v); }
        }
        const gr = read(new Set(grp));
        if (!gr.bb || gr.bb.n < 0.12 * totalN) continue; // a crumb
        const gc = L.clarity(gr);
        ev *= touchesFrame(gr.bb) ? Math.max(0.6, gc) : gc; // a neighbor the frame cut off need not read well
      }
      r.evidence = ev;
      return ev > 1.1 * wholeClear;
    };
    // The front runners must leave the rest explained; one that doesn't
    // drops back.
    const front = scored.slice().sort((a, b) => b.score - a.score).slice(0, 20);
    for (const r of front) {
      r.explained = explain(r);
      if (!r.explained) r.score *= 0.3;
    }
    // the whole shape read as one character loses to a split into letters
    // that each read far more clearly (a T through an O can pass for a P;
    // a T and an O are what it is)
    for (const r of front) {
      if (r.ids.length !== sc.n) continue;
      const better = front.some((q) => q !== r && q.explained && q.evidence >= 1.4 * r.clear && q.clear >= 0.8);
      if (better) r.score *= 0.5;
    }
    // the rest keep their own score, below the front runners — and the
    // readings the explaining brought in (the letters around a click) join
    const floor = front.length ? Math.min(...front.map((r) => r.score)) : 0;
    for (const r of cache.values()) if (r.bb && r.top.length && r.score === undefined) scoreOf(r);
    for (const r of scored) {
      if (r.explained === undefined) { r.explained = r.ids.length === sc.n; r.score = Math.min(r.score * 0.3, floor * 0.999); }
    }
    scored.sort((a, b) => b.score - a.score);
    // the letters: best first, each made of strokes no better letter took
    const taken = new Map(); // chain → index of the letter that took it
    const picked = [];
    // with a click, the letter holding the clicked stroke comes first; the
    // letters around it are still worked out, so their strokes count as
    // taken (and none of them is handed to the clicked letter as a leftover)
    if (must) scored.sort((a, b) => (b.ids.indexOf(must) >= 0) - (a.ids.indexOf(must) >= 0) || b.score - a.score);
    for (const r of scored) {
      if (picked.length >= (o.max || 4)) break;
      if (must && !picked.length && r.ids.indexOf(must) < 0) break; // no letter holds the click
      if (r.letterness < 0.5 || (target && !picked.length && !(r.want >= 0.05))) continue;
      if (r.ids.some((c) => taken.has(c))) continue;
      for (const c of r.ids) taken.set(c, picked.length);
      picked.push(r);
    }
    // a piece left over that continues one of a letter's strokes straight
    // through a crossing (a bar running on into its neighbor's counter) is
    // that stroke's — and so that letter's, if it still reads as one
    // character with it
    const strokes = ST.extract.strokeChains(mask, w, h);
    if (strokes) {
      const strokeOf = new Int32Array(sc.n + 1);
      for (let c = 1; c <= sc.n; c++) { const p = sc.skel[c][0]; strokeOf[c] = p != null ? strokes.owner[p] : 0; }
      for (let c = 1; c <= sc.n; c++) {
        if (taken.has(c) || !(strokeOf[c] > 0)) continue;
        const owners = new Set();
        for (let d = 1; d <= sc.n; d++) if (d !== c && strokeOf[d] === strokeOf[c] && taken.has(d)) owners.add(taken.get(d));
        if (owners.size !== 1) continue;
        const k = owners.values().next().value;
        const cur = picked[k];
        const t = read(new Set(cur.ids.concat([c])));
        if (t.letterness >= 0.5 && t.letterness >= 0.8 * cur.letterness && t.top.length && (!target || t.want >= 0.8 * cur.want)) {
          t.score = cur.score;
          picked[k] = t;
          taken.set(c, k);
        }
      }
    }
    // strokes left over that hang on one letter only — an arm, a serif, a
    // flourish the reading could do without — are that letter's, as long as
    // it still reads as one character with them (a neighbor's stroke fused
    // on makes it read as two)
    for (let k = 0; k < picked.length; k++) {
      let grew = true;
      while (grew) {
        grew = false;
        const cur = picked[k];
        for (const c of cur.ids) {
          for (const nb of adj[c]) {
            if (taken.has(nb)) continue;
            let other = false;
            for (const x of adj[nb]) if (taken.has(x) && taken.get(x) !== k) { other = true; break; }
            if (other) continue;
            const t = read(new Set(cur.ids.concat([nb])));
            if (t.letterness >= 0.5 && t.letterness >= 0.8 * cur.letterness && t.top.length && (!target || t.want >= 0.8 * cur.want)) {
              t.score = cur.score;
              picked[k] = t;
              taken.set(nb, k);
              grew = true;
              break;
            }
          }
          if (grew) break;
        }
      }
    }
    if (o.debug) o.debug.sets = Array.from(cache.values()).map((r) => ({ ids: r.ids.join(','), L: +(r.letterness || 0).toFixed(2), top: (r.top || []).slice(0, 3).map((x) => x.ch + ':' + x.p.toFixed(2)).join(' '), score: r.score != null ? +r.score.toFixed(3) : null, explained: r.explained }));
    // How much of the rest of the shape lies within a letter's own bounds.
    // A neighbor sits beside a letter; strokes inside its box are its own —
    // a stylized A's crossbar is not a neighbor fused onto a "7".
    const pad = sc.sw / m.f / 2;
    const insideOf = (r) => {
      const rest = new Set();
      for (let c = 1; c <= sc.n; c++) if (r.ids.indexOf(c) < 0) rest.add(c);
      if (!rest.size) return 0;
      const img = draw(m, rest);
      let n = 0, inn = 0;
      for (let y = 0; y < m.lh; y++) {
        for (let x = 0; x < m.lw; x++) {
          if (!img[y * m.lw + x]) continue;
          n++;
          if (x >= r.bb.x0 - pad && x <= r.bb.x1 + pad && y >= r.bb.y0 - pad && y <= r.bb.y1 + pad) inn++;
        }
      }
      return n ? inn / n : 0;
    };
    return {
      sc, model: m, evaluated: cache.size,
      whole: read(new Set(Array.from({ length: sc.n }, (_, i) => i + 1))),
      letters: (must ? picked.slice(0, 1) : picked).map((r) => ({
        set: new Set(r.ids), read: { ranked: r.top, junk: r.junk, letterness: r.letterness }, score: r.score,
        explained: r.explained !== false,
        inside: insideOf(r),
        box: { x0: (r.bb.x0 - 1) * m.f, y0: (r.bb.y0 - 1) * m.f, x1: (r.bb.x1 - 1) * m.f, y1: (r.bb.y1 - 1) * m.f },
      })),
    };
  };

  // The full-size mask of one found letter: its strokes, with the joins
  // where its neighbors came off healed and capped.
  L.render = function (found, mask, w, h, letter) {
    const out = ST.extract.renderStrokes(found.sc, mask, w, h, letter.set);
    return out;
  };

  /**
   * How far a letter leans: the tilt of its stems, in degrees — positive
   * when the tops lean right (clockwise). A stem is a stroke followed
   * through its crossings from end to end (a k's stem runs on through the
   * joint of its arm and leg, even where it bends there), tall and near
   * upright; its lean is its chord's. Stems that disagree (an A's two legs)
   * or none at all (an O, an S) say nothing, and the answer is 0. Rotating
   * the letter by −lean stands it up.
   */
  L.lean = function (mask, w, h) {
    const R = ST.raster;
    const bb = R.maskBounds(mask, w, h);
    if (!bb) return 0;
    const tall = bb.h;
    const stems = [];
    // a tall, straight-ish run of skeleton: its chord's tilt, or null
    const stemOf = (px) => {
      if (px.length < 0.4 * tall) return null;
      let top = -1, bot = -1;
      for (const p of px) {
        if (top < 0 || p < top) top = p;
        if (bot < 0 || p > bot) bot = p;
      }
      const tx = top % w, ty = (top / w) | 0, bx = bot % w, by = (bot / w) | 0;
      const chord = Math.hypot(bx - tx, by - ty);
      if (by - ty < 0.45 * tall || px.length > 1.12 * chord) return null; // short, or not straight-ish
      const ang = (Math.atan2(tx - bx, by - ty) * 180) / Math.PI; // + when the top is right of the foot
      return Math.abs(ang) <= 30 ? { ang, len: chord } : null;
    };
    const sc = ST.extract.strokeChains(mask, w, h);
    if (sc) {
      for (let c = 1; c <= sc.n; c++) {
        const st = stemOf(sc.skel[c]);
        if (st) stems.push(st);
      }
      // no stroke is a stem as a whole — a stem merged with a bar round a
      // corner (an E's spine with its foot) isn't straight: its piece
      // between the corners is
      if (!stems.length) {
        const sw = R.strokeWidth(mask, w, h);
        const graph = sw > 1.5 ? ST.extract.strokeGraph(mask, w, h, sw) : null;
        for (const s of graph ? graph.segments : []) {
          const st = stemOf(s.pixels);
          if (st) stems.push(st);
        }
      }
    }
    // an L's stem, a T's: straight runs of skeleton pieces a few strokes long
    if (!stems.length) {
      const sw = R.strokeWidth(mask, w, h);
      const graph = sw > 1.5 ? ST.extract.strokeGraph(mask, w, h, sw) : null;
      const piece = Math.max(Math.round(2.5 * sw), Math.round(0.12 * tall), 8);
      for (const s of graph ? graph.segments : []) {
        const px = s.pixels, n = px.length;
        if (n < piece) continue;
        const count = Math.floor(n / piece);
        const off = Math.floor((n - count * piece) / 2);
        for (let k = 0; k < count; k++) {
          const a = px[off + k * piece], b = px[off + (k + 1) * piece - 1];
          const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 0.8 * piece) continue;
          let dev = 0;
          for (let q = off + k * piece; q < off + (k + 1) * piece; q++) {
            const p = px[q], x = p % w, y = (p / w) | 0;
            dev = Math.max(dev, Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / len);
          }
          if (dev > Math.max(1.5, 0.06 * len)) continue;
          let ang = (Math.atan2(bx - ax, -(by - ay)) * 180) / Math.PI;
          if (ang > 90) ang -= 180;
          if (ang < -90) ang += 180;
          if (Math.abs(ang) <= 28) stems.push({ ang, len });
        }
      }
      let total = 0;
      for (const r of stems) total += r.len;
      if (total < 0.45 * tall) return 0; // no stem-length of straight upright stroke
    }
    if (!stems.length) return 0;
    let total = 0;
    for (const r of stems) total += r.len;
    // the dominant tilt: the densest ±5° cluster, trusted when it holds
    // most of the upright stroke
    let best = null;
    for (const r of stems) {
      let wsum = 0, asum = 0;
      for (const q of stems) if (Math.abs(q.ang - r.ang) <= 5) { wsum += q.len; asum += q.ang * q.len; }
      if (!best || wsum > best.w) best = { w: wsum, ang: asum / wsum };
    }
    if (best.w < 0.6 * total || best.w < 0.4 * tall) return 0;
    const lean = Math.round(best.ang * 10) / 10;
    return Math.abs(lean) < 2 ? 0 : lean;
  };
})(typeof window !== 'undefined' ? window : globalThis);
