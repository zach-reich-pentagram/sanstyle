# Training data for the letter recognizer: handwritten EMNIST characters and
# glyphs from ~700 fonts, distorted to look like extracted graffiti masks
# (stroke weight, slant, wobble, drips, ragged edges, specks), plus a "junk"
# class (several letters fused, scribbles, blobs, stickers) so the model can
# say "this is not one letter".
import gzip, json, os, sys, math, random
import numpy as np
from scipy import ndimage as ndi
from PIL import Image, ImageDraw, ImageFont

CLASSES = list('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') + list('!?#@&$%*+=/\\<>()[]') + ['junk']
JUNK = len(CLASSES) - 1
N_IN = 32
BOX = 28.0
JUNK_SHARE = float(os.environ.get('JUNK_SHARE', '0.12'))
HERE = os.path.dirname(os.path.abspath(__file__))


def to_input(m):
    """mask (any size) → 32×32 float in [0,1]: the ink's bounding box fit into
    28 px (aspect kept), centered, each cell the exact share of it covered.
    Mirrored exactly by js/recognize.js."""
    ys, xs = np.nonzero(m)
    if len(xs) == 0:
        return np.zeros((N_IN, N_IN), np.float32)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    sub = m[y0:y1, x0:x1].astype(np.float64)
    bh, bw = sub.shape
    S = np.zeros((bh + 1, bw + 1))
    S[1:, 1:] = sub.cumsum(0).cumsum(1)
    s = BOX / max(bw, bh)
    ox, oy = (N_IN - bw * s) / 2, (N_IN - bh * s) / 2
    j = np.arange(N_IN)
    u0 = np.clip((j - ox) / s, 0, bw); u1 = np.clip((j + 1 - ox) / s, 0, bw)
    v0 = np.clip((j - oy) / s, 0, bh); v1 = np.clip((j + 1 - oy) / s, 0, bh)

    def F(v, u):  # bilinear read of the integral image: exact area for a box
        vi = np.minimum(np.floor(v).astype(int), bh - 1); ui = np.minimum(np.floor(u).astype(int), bw - 1)
        fv = v - vi; fu = u - ui
        vi = vi[:, None]; fv = fv[:, None]; ui = ui[None, :]; fu = fu[None, :]
        a = S[vi, ui]; b = S[vi, ui + 1]; c = S[vi + 1, ui]; d = S[vi + 1, ui + 1]
        return a * (1 - fv) * (1 - fu) + b * (1 - fv) * fu + c * fv * (1 - fu) + d * fv * fu

    area = F(v1, u1) - F(v0, u1) - F(v1, u0) + F(v0, u0)
    return np.clip(area * s * s, 0, 1).astype(np.float32)


# ---------- sources ----------
def load_emnist():
    d = os.path.join(HERE, 'emnist')
    with gzip.open(os.path.join(d, 'emnist-byclass-train-images-idx3-ubyte.gz')) as f:
        f.read(16); X = np.frombuffer(f.read(), np.uint8).reshape(-1, 28, 28)
    with gzip.open(os.path.join(d, 'emnist-byclass-train-labels-idx1-ubyte.gz')) as f:
        f.read(8); y = np.frombuffer(f.read(), np.uint8)
    return X, y


EM = None
EM_BY = None
FONTS = None
FONT_CACHE = {}


def init_worker(seed):
    global EM, EM_BY, FONTS
    random.seed(seed); np.random.seed(seed % (2 ** 32))
    EM = load_emnist()
    EM_BY = [np.nonzero(EM[1] == k)[0] for k in range(62)]
    cover = json.load(open(os.path.join(HERE, 'fonts', 'cover.json')))
    FONTS = [(os.path.join(HERE, fn), v['chars'], v['cat']) for fn, v in cover.items()]


def crop(m):
    ys, xs = np.nonzero(m)
    if len(xs) == 0: return None
    return m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def fit(m, side):
    """binary mask scaled so its longer side is `side` px"""
    h, w = m.shape
    s = side / max(h, w)
    nh, nw = max(1, round(h * s)), max(1, round(w * s))
    im = Image.fromarray((m * 255).astype(np.uint8)).resize((nw, nh), Image.BILINEAR)
    return np.asarray(im) > 127


def emnist_glyph(k):
    idx = EM_BY[k][random.randrange(len(EM_BY[k]))]
    img = EM[0][idx].T.astype(np.float32) / 255.0
    up = ndi.zoom(img, 3, order=1)
    m = up > random.uniform(0.3, 0.55)
    return crop(m)


def font_glyph(ch):
    for _ in range(20):
        fn, chars, cat = FONTS[random.randrange(len(FONTS))]
        if ch in chars: break
    else:
        return None
    f = FONT_CACHE.get(fn)
    if f is None:
        try: f = ImageFont.truetype(fn, 80)
        except Exception: return None
        FONT_CACHE[fn] = f
    im = Image.new('L', (200, 200), 0)
    ImageDraw.Draw(im).text((50, 40), ch, font=f, fill=255)
    return crop(np.asarray(im) > 127)


def glyph(k):
    ch = CLASSES[k]
    g = None
    if k < 62 and random.random() < 0.5:
        g = emnist_glyph(k)
    if g is None:
        g = font_glyph(ch)
    if g is None and k < 62:
        g = emnist_glyph(k)
    return g


# ---------- distortions ----------
def place(m, side=72, pad=44):
    g = fit(m, side)
    h, w = g.shape
    out = np.zeros((h + 2 * pad, w + 2 * pad), bool)
    out[pad:pad + h, pad:pad + w] = g
    return out


def affine(m, rot, shear, aspect):
    h, w = m.shape
    c = np.array([h / 2, w / 2])
    th = math.radians(rot)
    R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    Sh = np.array([[1, 0], [shear, 1]])      # x += shear * y  (row, col order)
    A = np.array([[1, 0], [0, aspect]])
    M = R @ Sh @ A
    Minv = np.linalg.inv(M)
    off = c - Minv @ c
    out = ndi.affine_transform(m.astype(np.float32), Minv, offset=off, order=1)
    return out > 0.5


def elastic(m, alpha, sigma):
    h, w = m.shape
    dx = ndi.gaussian_filter(np.random.uniform(-1, 1, (h, w)), sigma) * alpha
    dy = ndi.gaussian_filter(np.random.uniform(-1, 1, (h, w)), sigma) * alpha
    yy, xx = np.meshgrid(np.arange(h), np.arange(w), indexing='ij')
    out = ndi.map_coordinates(m.astype(np.float32), [yy + dy, xx + dx], order=1)
    return out > 0.5


def stroke_width(m):
    a = m.sum()
    if a == 0: return 0
    er = ndi.binary_erosion(m)
    p = (m & ~er).sum()
    return 2.0 * a / max(1, p)


def holes(m):
    lab, n = ndi.label(~m)
    if n == 0: return 0
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    sizes = np.bincount(lab.ravel())
    return sum(1 for k in range(1, n + 1) if k not in border and sizes[k] > 12)


def reweight(m, r):
    """set the stroke width to r × the letter's height (never closing a counter)"""
    ys, xs = np.nonzero(m)
    if len(xs) == 0: return m
    H = max(ys.max() - ys.min(), xs.max() - xs.min()) + 1
    t0 = stroke_width(m)
    t = r * H
    d = (t - t0) / 2
    if d > 0.5:
        out = ~m
        dt = ndi.distance_transform_edt(out)
        h0 = holes(m)
        while d > 0.5:
            grown = dt <= d
            if holes(grown) >= h0: return grown
            d *= 0.7
        return m
    if d < -0.5:
        er = ndi.distance_transform_edt(m) > -d
        if er.sum() > 0.35 * m.sum():
            n0 = ndi.label(m)[1]; n1 = ndi.label(er)[1]
            if n1 <= n0: return er
    return m


def rough(m, amt):
    noise = ndi.gaussian_filter(np.random.uniform(-1, 1, m.shape), 1.2) * amt
    return ndi.gaussian_filter(m.astype(np.float32), 1.0) + noise > 0.5


def drips(m, n, t):
    h, w = m.shape
    ys, xs = np.nonzero(m & ~np.roll(m, -1, 0))  # bottom edges
    if len(xs) == 0: return m
    img = Image.fromarray((m * 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    H = ys.max() - np.nonzero(m)[0].min() + 1
    for _ in range(n):
        i = random.randrange(len(xs))
        x, y = xs[i], ys[i]
        L = random.uniform(0.08, 0.45) * H
        wd = max(1, t * random.uniform(0.25, 0.6))
        d.line([(x, y), (x + random.uniform(-2, 2), y + L)], fill=255, width=int(round(wd)))
        r = wd * random.uniform(0.6, 1.1)
        d.ellipse([x - r, y + L - r, x + r, y + L + r], fill=255)
    return np.asarray(img) > 127


def specks(m, n, t):
    ys, xs = np.nonzero(m)
    if len(xs) == 0: return m
    img = Image.fromarray((m * 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    W, H = x1 - x0, y1 - y0
    for _ in range(n):
        cx = random.uniform(x0 - 0.2 * W, x1 + 0.2 * W); cy = random.uniform(y0 - 0.2 * H, y1 + 0.2 * H)
        r = max(1.0, t * random.uniform(0.3, 1.2))
        d.ellipse([cx - r, cy - r * random.uniform(0.5, 1.5), cx + r, cy + r], fill=255)
    return np.asarray(img) > 127


def pocks(m, t):
    dt = ndi.distance_transform_edt(m)
    ys, xs = np.nonzero(dt > t * 0.3)
    if len(xs) == 0: return m
    out = m.copy()
    for _ in range(random.randint(1, 4)):
        i = random.randrange(len(xs))
        r = max(1, int(t * random.uniform(0.1, 0.25)))
        out[max(0, ys[i] - r):ys[i] + r + 1, max(0, xs[i] - r):xs[i] + r + 1] = False
    return out


def graffiti(m, weight=None):
    """a clean glyph → something like an extracted graffiti letter"""
    m = place(m)
    m = affine(m, np.clip(np.random.normal(0, 6), -15, 15), random.uniform(-0.35, 0.35), math.exp(random.uniform(-0.3, 0.3)))
    if random.random() < 0.55:
        m = elastic(m, random.uniform(40, 130), random.uniform(7, 11))
    r = weight if weight is not None else math.exp(random.uniform(math.log(0.035), math.log(0.22)))
    m = reweight(m, r)
    ys, xs = np.nonzero(m)
    if len(xs) == 0: return m
    H = max(ys.max() - ys.min(), xs.max() - xs.min()) + 1
    t = r * H
    if random.random() < 0.45: m = rough(m, random.uniform(0.15, 0.5))
    if random.random() < 0.2: m = drips(m, random.randint(1, 3), t)
    if random.random() < 0.12: m = specks(m, random.randint(1, 3), t)
    if random.random() < 0.1 and t > 6: m = pocks(m, t)
    return m


# ---------- junk ----------
def rand_class(letters_only=False):
    return random.randrange(62) if letters_only or random.random() < 0.9 else random.randrange(62, JUNK)


def junk_pair(n=2):
    gs = []
    for _ in range(n):
        g = glyph(rand_class())
        if g is None: return None
        gs.append(fit(g, 72 * random.uniform(0.8, 1.15)))
    H = max(g.shape[0] for g in gs) + 60
    W = sum(g.shape[1] for g in gs) + 120
    out = np.zeros((H, W), bool)
    x = 30
    for g in gs:
        y = 30 + random.randint(-8, 8) + (H - 60 - g.shape[0]) // 2
        y = max(0, min(H - g.shape[0], y))
        x = max(0, min(W - g.shape[1], x))
        out[y:y + g.shape[0], x:x + g.shape[1]] |= g
        x += int(g.shape[1] * (1 - random.uniform(-0.1, 0.35)))
    return crop(out)


def junk_scribble():
    img = Image.new('L', (160, 160), 0)
    d = ImageDraw.Draw(img)
    for _ in range(random.randint(2, 5)):
        pts = [(random.uniform(20, 140), random.uniform(20, 140)) for _ in range(4)]
        curve = []
        for i in range(25):
            u = i / 24
            x = (1 - u) ** 3 * pts[0][0] + 3 * (1 - u) ** 2 * u * pts[1][0] + 3 * (1 - u) * u * u * pts[2][0] + u ** 3 * pts[3][0]
            y = (1 - u) ** 3 * pts[0][1] + 3 * (1 - u) ** 2 * u * pts[1][1] + 3 * (1 - u) * u * u * pts[2][1] + u ** 3 * pts[3][1]
            curve.append((x, y))
        d.line(curve, fill=255, width=random.randint(3, 16), joint='curve')
    return crop(np.asarray(img) > 127)


def junk_blob():
    img = Image.new('L', (160, 160), 0)
    d = ImageDraw.Draw(img)
    kind = random.random()
    if kind < 0.3:
        d.ellipse([random.uniform(10, 50), random.uniform(10, 50), random.uniform(90, 150), random.uniform(90, 150)], fill=255)
    elif kind < 0.6:
        x0, y0 = random.uniform(5, 40), random.uniform(5, 40)
        d.rounded_rectangle([x0, y0, x0 + random.uniform(40, 115), y0 + random.uniform(15, 115)], radius=random.uniform(0, 12), fill=255)
    elif kind < 0.8:
        n = random.randint(5, 9)
        cx, cy = 80, 80
        pts = [(cx + math.cos(2 * math.pi * i / n) * random.uniform(20, 70), cy + math.sin(2 * math.pi * i / n) * random.uniform(20, 70)) for i in range(n)]
        d.polygon(pts, fill=255)
    else:
        # a long strip or a frame piece
        if random.random() < 0.5:
            d.rectangle([5, 70, 155, 70 + random.uniform(8, 30)], fill=255)
        else:
            t = random.uniform(4, 12)
            d.rectangle([20, 20, 140, 140], outline=255, width=int(t))
    m = np.asarray(img) > 127
    m = rough(m, random.uniform(0.2, 0.7))
    return crop(m)


def junk_letter_plus_blob():
    g = glyph(rand_class(True))
    if g is None: return None
    g = fit(g, 72)
    H, W = g.shape
    out = np.zeros((H + 80, W + 80), bool)
    out[40:40 + H, 40:40 + W] = g
    img = Image.fromarray((out * 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    side = random.choice(['l', 'r', 't', 'b'])
    s = random.uniform(0.4, 0.8)
    if side in 'lr':
        x = 40 - s * 40 if side == 'l' else 40 + W - 10
        d.rounded_rectangle([x, 40 + random.uniform(0, H * 0.5), x + s * 50, 40 + H * random.uniform(0.6, 1.0)], radius=6, fill=255)
    else:
        y = 40 - s * 40 if side == 't' else 40 + H - 10
        d.rounded_rectangle([40 + random.uniform(0, W * 0.4), y, 40 + W * random.uniform(0.6, 1.0), y + s * 50], radius=6, fill=255)
    return crop(np.asarray(img) > 127)


def blob_img(d, cx, cy, r):
    n = random.randint(5, 9)
    pts = [(cx + math.cos(2 * math.pi * i / n + random.uniform(-0.3, 0.3)) * r * random.uniform(0.5, 1.2),
            cy + math.sin(2 * math.pi * i / n + random.uniform(-0.3, 0.3)) * r * random.uniform(0.5, 1.2)) for i in range(n)]
    d.polygon(pts, fill=255)


def junk_letter_debris():
    # a letter with paint debris, flakes or stickers scattered round it
    g = glyph(rand_class())
    if g is None: return None
    g = fit(g, 72)
    H, W = g.shape
    P = 50
    img = Image.new('L', (W + 2 * P, H + 2 * P), 0)
    img.paste(Image.fromarray((g * 255).astype(np.uint8)), (P, P))
    d = ImageDraw.Draw(img)
    for _ in range(random.randint(1, 4)):
        r = max(H, W) * random.uniform(0.07, 0.2)
        side = random.random()
        if side < 0.5:   # below or above
            cx = P + random.uniform(-0.2, 1.2) * W; cy = P + (H + r * random.uniform(0.2, 1.4) if random.random() < 0.7 else -r * random.uniform(0.2, 1.4))
        else:            # left or right
            cy = P + random.uniform(-0.1, 1.1) * H; cx = P + (W + r * random.uniform(0.2, 1.4) if random.random() < 0.5 else -r * random.uniform(0.2, 1.4))
        blob_img(d, cx, cy, r)
    return crop(np.asarray(img) > 127)


def junk_cut_pair():
    # two letters fused, one of them cut off by the frame
    g = junk_pair(2)
    if g is None: return None
    H, W = g.shape
    cut = int(W * random.uniform(0.15, 0.4))
    g = g[:, cut:] if random.random() < 0.5 else g[:, :W - cut]
    return crop(g)


def junk_letter_fragment():
    # a letter with a piece of a neighbor fused on
    a = glyph(rand_class()); b = glyph(rand_class())
    if a is None or b is None: return None
    a = fit(a, 72); b = fit(b, 72 * random.uniform(0.8, 1.1))
    bh, bw = b.shape
    frac = random.uniform(0.3, 0.6)
    if random.random() < 0.5:
        frag = b[:, :max(2, int(bw * frac))]; right = True
    else:
        frag = b[:, bw - max(2, int(bw * frac)):]; right = False
    H = max(a.shape[0], frag.shape[0]) + 20
    W = a.shape[1] + frag.shape[1] + 20
    out = np.zeros((H, W), bool)
    ov = int(frag.shape[1] * random.uniform(-0.05, 0.3))
    y0 = random.randint(0, H - a.shape[0]); y1 = random.randint(0, H - frag.shape[0])
    if right:
        out[y0:y0 + a.shape[0], 0:a.shape[1]] |= a
        x = max(0, a.shape[1] - ov)
        out[y1:y1 + frag.shape[0], x:x + frag.shape[1]] |= frag[:, :W - x]
    else:
        out[y1:y1 + frag.shape[0], 0:frag.shape[1]] |= frag
        x = max(0, frag.shape[1] - ov)
        out[y0:y0 + a.shape[0], x:x + a.shape[1]] |= a[:, :W - x]
    return crop(out)


def junk():
    r = random.random()
    if r < 0.28: g = junk_pair(2)
    elif r < 0.36: g = junk_pair(3)
    elif r < 0.48: g = junk_cut_pair()
    elif r < 0.61: g = junk_letter_debris()
    elif r < 0.74: g = junk_letter_fragment()
    elif r < 0.84: g = junk_scribble()
    elif r < 0.94: g = junk_blob()
    else: g = junk_letter_plus_blob()
    return g


def sample():
    for _ in range(10):
        if random.random() < JUNK_SHARE:
            k = JUNK
            g = junk()
            if g is None: continue
            if random.random() < 0.8:
                m = graffiti(g)
            else:
                m = place(g)
        else:
            k = random.randrange(JUNK)
            g = glyph(k)
            if g is None or g.sum() < 15: continue
            m = graffiti(g)
        if m.sum() < 15: continue
        return to_input(m), k
    return None


def make(args):
    seed, n = args
    random.seed(seed); np.random.seed(seed % (2 ** 32))
    X = np.zeros((n, N_IN, N_IN), np.uint8)
    y = np.zeros(n, np.int16)
    i = 0
    while i < n:
        s = sample()
        if s is None: continue
        X[i] = np.round(s[0] * 255).astype(np.uint8); y[i] = s[1]; i += 1
    return X, y


if __name__ == '__main__':
    import multiprocessing as mp
    total = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    out = sys.argv[2] if len(sys.argv) > 2 else 'data.npz'
    base = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    chunks = 32 if total >= 32000 else 4
    per = total // chunks
    with mp.Pool(4, initializer=init_worker, initargs=(base,)) as pool:
        parts = pool.map(make, [(base * 1000 + c, per) for c in range(chunks)])
    X = np.concatenate([p[0] for p in parts]); y = np.concatenate([p[1] for p in parts])
    np.savez_compressed(out, X=X, y=y)
    print(out, X.shape, np.bincount(y, minlength=len(CLASSES)).min(), np.bincount(y)[JUNK])
