# which fonts cover which characters; all-caps fonts lose their lowercase
import json, os, numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont
CLASSES = list('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') + list('!?#@&$%*+=/\\<>()[]')
cats = json.load(open('fonts/cats.json'))
def render(font, ch, size=80):
    im = Image.new('L', (size * 2, size * 2), 0)
    d = ImageDraw.Draw(im)
    d.text((size // 2, size // 3), ch, font=font, fill=255)
    a = np.asarray(im) > 127
    ys, xs = np.nonzero(a)
    if len(xs) < 20: return None
    return a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
def norm(a, n=24):
    im = Image.fromarray((a * 255).astype(np.uint8)).resize((n, n), Image.BILINEAR)
    return np.asarray(im) > 100
out = {}
for fn, cat in cats.items():
    try:
        tt = TTFont(fn, lazy=True); cmap = tt.getBestCmap() or {}
        font = ImageFont.truetype(fn, 80)
    except Exception as e:
        continue
    have = [c for c in CLASSES if ord(c) in cmap]
    # all-caps / small-caps: lowercase drawn like the capitals
    same = []
    for c in 'abdeghnqrt':
        if c in have and c.upper() in have:
            a, b = render(font, c), render(font, c.upper())
            if a is None or b is None: continue
            A, B = norm(a), norm(b)
            same.append((A & B).sum() / max(1, (A | B).sum()))
    caps = len(same) >= 5 and np.mean(same) > 0.72
    if caps: have = [c for c in have if not c.islower()]
    # glyphs that render empty
    ok = []
    for c in have:
        r = render(font, c)
        if r is not None and r.shape[0] > 6: ok.append(c)
    out[fn] = {'cat': cat, 'chars': ''.join(ok), 'caps': bool(caps)}
json.dump(out, open('fonts/cover.json', 'w'))
from collections import Counter
cnt = Counter(c for v in out.values() for c in v['chars'])
print(len(out), 'fonts;', sum(v['caps'] for v in out.values()), 'all-caps')
print('min coverage', sorted(cnt.items(), key=lambda kv: kv[1])[:12])
