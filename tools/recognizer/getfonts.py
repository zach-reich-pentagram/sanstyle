import json, random, re, os, sys, urllib.request, concurrent.futures as cf
t = open('gf-meta.json').read(); d = json.loads(t[t.index('{'):])
fams = d['familyMetadataList']
BLOCK = re.compile(r'(Barcode|Flow |Redacted|Blokk|Linefont|Wavefont|Noto|Material|Icons|Symbols|Emoji|Kumar One|Bungee Shade|Bungee Outline|Bungee Hairline|Monofett|Libre Barcode|Rubik (Glitch|Microbe|Puddles|Maze|Moonrocks|Wet Paint|Bubbles|Beastly|Burned|Dirt|Distressed|Iso|Marker Hatch|Scribble|Spray Paint|Storm|Vinyl|Doodle|80s|Lines|Pixels|Broken)|Sixtyfour|Workbench|Jersey|Tilt Prism|Tilt Neon|Nabla|Honk|Bitmap|Pixel|Dot|Kalnia Glaze|Moirai|Foldit|Bahianita|Codystar|Ewert|Fascinate|Frijole|Fruktur|Geostar|Plaster|Vast Shadow|Zen Tokyo|Train One|Rampart|Reggae|Rock 3D|Stick|Yuji|Zen Loop|Handjet|Danfo|Bungee Spice|Bungee Tint|Linefont|Bodoni Moda SC|Syne Tactile|Butcherman|Creepster|Eater|Nosifer|Rubik Glitch|Sedgwick|Monoton|Londrina Outline|Londrina Shadow|Londrina Sketch|Akronim|Cabin Sketch|Fredericka|Freckle|Kranky|Ruge|Faster One|Hanalei|Jolly Lodger|Macondo|Miltonian|Mrs Sheppards|Ribeye|Snowburst|Special Elite|Stalinist|Tourney|UnifrakturCook|UnifrakturMaguntia|New Rocker|Pirata|Grenze Gotisch|Jacquard|Jacquarda|Texturina)')
pick = []
for f in fams:
    if 'latin' not in f['subsets'] or f.get('primaryScript') not in ('', None, 'Latn'): continue
    if BLOCK.search(f['family']): continue
    pick.append(f)
random.seed(7)
by = {}
for f in pick: by.setdefault(f['category'], []).append(f)
sel = by.get('Handwriting', []) + by.get('Display', [])
sel += random.sample(by['Sans Serif'], 160) + random.sample(by['Serif'], 70) + random.sample(by['Monospace'], 15)
print('selected', len(sel), {k: len(v) for k, v in by.items()})
UA = 'Mozilla/4.0'
def fetch(f):
    fam = f['family']
    fn = 'fonts/' + re.sub(r'[^A-Za-z0-9]', '', fam) + '.ttf'
    if os.path.exists(fn): return fn
    wt = '400' if '400' in f['fonts'] else sorted(f['fonts'].keys(), key=lambda k: abs(int(re.sub(r'\D', '', k) or 400) - 400))[0]
    wt = re.sub(r'\D', '', wt) or '400'
    url = 'https://fonts.googleapis.com/css?family=' + fam.replace(' ', '+') + ':' + wt
    try:
        css = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30).read().decode()
        m = re.search(r'url\((https://[^)]+\.ttf)\)', css)
        if not m: return None
        data = urllib.request.urlopen(m.group(1), timeout=60).read()
        open(fn, 'wb').write(data)
        return fn
    except Exception as e:
        return None
cats = {}
with cf.ThreadPoolExecutor(8) as ex:
    for f, fn in zip(sel, ex.map(fetch, sel)):
        if fn: cats[fn] = f['category']
json.dump(cats, open('fonts/cats.json', 'w'), indent=0)
print('downloaded', len(cats))
