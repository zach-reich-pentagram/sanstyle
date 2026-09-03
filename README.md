# Sanstyle

**Street-sourced typeface engine.** Photograph graffiti around town, drop
the photos in, confirm each letterform the machine finds, and it becomes a
glyph in a living, typeable, downloadable font — straightened, vectorized,
optically fitted, and auto-spaced, entirely in the browser.

Photo of a wall → usable `.ttf`.

![Capture studio](docs/shots/capture.png)

## Run it

Fully client-side static app — no build step, no server, nothing leaves your
machine.

```bash
python3 -m http.server 8000     # or: npx serve .
# open http://localhost:8000
```

Opening `index.html` from disk works too. **Demo wall** generates a sprayed
letter so the whole flow can be tried without a photo. iPhone **HEIC/HEIF**
photos upload directly (Safari decodes natively; elsewhere a vendored libheif
decodes locally).

## How a letter gets in

Drop photos on the Capture tab (one or a hundred; iPhone HEIC works), share
them into the Drive inbox from your phone, or pick any photo from the Drive
gallery in the Glyphs tab. Each photo is analyzed and lands on the stage in
turn: the paint is separated from the wall or paper by color contrast
against the background — the wall is the frame's dominant color, paint is
whatever contrasts most with it, and the threshold sits where the boundary
is sharpest, never past the midpoint between the two. That keeps marker
strokes stroke-thin on fibrous paper instead of swallowing the pink bleed
halo around them. The classifier works along the wall→paint color axis, so
metallic and glossy paint whose highlights and shading run *past* the paint
color (silver on dark red, chrome on brick) still reads as one shape, and
compact patches inside the paint that are neither paint nor wall — pocks,
cracks, dirt in a porous wall — are read as paint under it, not as holes.
Streaky strokes are jumped across at up to half a stroke width. The photo is
then straightened by the paint's own edges (its stems set upright, not the
wall's bricks or the paper's edge), and its resolution is normalized: a
letter shot from across the street is brought up to the same pixel height as
one shot up close before smoothing, so both get the same treatment.

On the stage the detected shape is boxed and its trace drawn over the paint;
the clean silhouette and the letterform fitted into the em sit beside it. A
**Detail** knob re-reads the photo (low heals gaps and smooths hard, high
keeps every nuance). Type the character, **Add** — the next photo comes up.
A photo leaves the queue only when its letterform was added or skipped, and
the queue waits across tabs and reloads of Drive photos.

**Click the letter you see.** If the detected shape isn't the one you want,
click the letter in the photo: the click snaps to the densest paint nearby
(a click in the halo or just off a thin stroke still seeds from the stroke),
the paint color is sampled and refined, and the connected stroke region is
grown at the tolerance whose edge is sharpest. Fused with a neighbor? Drag a
short cut across the join and the region regrows without it — or type the
character and **Isolate**: a stroke-weight-agnostic template search (two-way
chamfer match against system-font renders, scored on the ink connected to
your click) finds where that character sits inside the fused shape. The
shape is then read as strokes — skeletonized, cut into pieces at junctions
and at sharp corners — and every stroke that leaves that box by more than a
couple of stroke widths is a neighbor's: it is dropped at its join, whether
it meets the letter side-on or continues one of its strokes around a
corner, and the cut face is healed and capped. The letter's own overhang
past an imperfect box stays.

Stroke ends get a marker's round cap: nothing a pen draws is sharper than
its tip, so needle points thinner than the thin side of the tip (measured
from the distance transform of the shape) are pruned back to a cap. Where a
stroke fades out — spray thinning, a marker lifting — the shape tapers to a
point the pen never made: the skeleton is walked in from each free end to
where the stroke has most of its width back, the taper beyond is dropped,
and the stroke ends there with a disc of that width. Anything *wider* than
the stroke near its end (an arrowhead) is drawn that way and kept. Where a
cut sliced a stroke flat, the sliced face is capped the same way. The
tracer then measures its corners and smoothing against the stroke width,
so a round cap only half a stroke across is fitted as a curve, never
sharpened into a corner.

![Isolate a fused 2](docs/shots/isolate-2.png)

**Ligatures and two-part characters.** Type two to four letters ("ar",
"bl", "gr") for a connected pair and it is captured as a ligature: the font
swaps it in whenever that sequence is typed (a GSUB `liga`/`rlig` lookup,
so it also fires in Illustrator, Figma, and browsers with tracking applied).
A character in pieces — the stem and point of a "!", an "i" and its dot —
is assembled by **shift-clicking** the other piece: only the new ink under
that click joins the shape, so a neighbor it touches stays out. The same
shift-click puts back a bit that the extraction, a cut or Isolate left out,
and the pieces are remembered when the shape is rebuilt by the Detail knob,
a cut, an undo or an Isolate. In the studio, shift-click with the Click tool
scans another piece into the same loop.

## The optical fitting

Every glyph is fitted into a 1000-UPM em by its character class (caps and
figures to the 700-unit cap height; x-height, ascender and descender classes
for lowercase; a tuned table for marks), then corrected:

- **Overshoot compensation** — flat extremes (E, H, T) align exactly; round
  ones (O, S) overshoot ~11 units; pointed apexes (A, V) ~15, so everything
  *looks* the same height.
- **Auto sidebearings** — the whitespace depth of each side's margin profile
  sets the bearing (a simplified HT-Letterspacer): open shapes tuck in,
  solid stems get full clearance. Proportional spacing with zero manual
  metrics.

The compiler emits a complete TrueType font (cubic→quadratic, winding
normalization, all ten required tables, a GSUB ligature lookup when the
library has ligatures, correct checksums) and hot-swaps it into the page via
the FontFace API in a few milliseconds.

## The tester

![Type tester](docs/shots/tester.png)

- Types with the real compiled font. Newlines, paste, the lot.
- **Variant cycling** — when a character has several captured letterforms,
  repeated letters rotate through them (alternate fonts are compiled per
  variant slot), so doubles never twin. Toggleable.
- **Weight slider** — runs from the library's lightest captured letterform
  to its heaviest; every letter shows the variant nearest that weight, so
  the whole line thickens as you slide (letters with one variant keep it).
- **Where did that come from?** Hover any letterform and the bit of photo it
  was cut from pops up (stored on this device, beside the library).
- **Manual kerning** — hit **Kern**, click a letterform, and arrow-key it
  (shift for coarse). Esc returns to typing; kern tweaks carry into exports.
- Captured ligatures shape as one glyph while you type, in the tester and in
  every export.
- Background color, text color, and alignment controls; tracking down to
  −0.25 em; canvas aspect presets (Free / iPhone / Square / 16:9 / Poster)
  for mockups.
- **Exports**: the specimen as **SVG** (true vector paths), **PNG**, or
  **JPG** — plus the installable **TTF** itself.

## Cloud sync (Google Drive + Vercel)

With the one-time setup in [SETUP-SYNC.md](SETUP-SYNC.md), the deployed site
becomes a passcode-gated, cross-device studio backed by two Drive folders:

- an **inbox folder** — share photos into it from your phone's Drive app (or
  upload through the site) and the site offers to extract letterforms from
  whatever is new since your last visit. The Glyphs tab shows every photo in
  the folder, used ones grayed; click any to extract from it again, or
  **Re-scan Drive photos** to queue them all;
- a **letterforms folder** — `library.json` (the full library: variants,
  fits, nudges, settings) plus an auto-maintained **SVG mirror** of every
  letterform, ready to open in Illustrator.

The browser only ever talks to the site's own `/api` routes (Vercel
serverless, in `api/`), which hold the Google credentials server-side and
check the passcode on every request. The site can act as your own Google
account (an OAuth refresh token, works with a personal Gmail) or as a
service account on a Shared Drive — Google no longer lets a service account
own files in a personal My Drive, and the red sync pill says so, with the
fix, when that is what's wrong. Without the env vars, the site runs
local-only exactly as before.

## Glyphs, sharing, design

The **Glyphs** tab holds the full character grid (plus a Ligatures row once
you have captured any): per-slot variants, activation, optical nudges (size,
baseline, sidebearings), delete. The
library persists locally and round-trips through **Export / Import JSON** so
sets can be shared and merged. The **Design** tab live-adjusts the interface
itself — text size, padding, gaps, control height, corner radius, line
weight, canvas padding — persisted per browser.

## Under the hood

```
api/
  _lib.js        Google auth (your account via OAuth, or a service-account
                 JWT) + Drive REST helpers (no SDK)
  health/library/inbox/photo/upload/diag — the sync endpoints
tools/
  get_refresh_token.mjs   one-time Google sign-in for the site
  validate_font.py        fontTools round-trip used by the tests
js/
  geometry.js    vectors, RDP, point-in-poly, homography, Bézier math
  fitcurves.js   Schneider least-squares cubic fitting
  raster.js      Otsu, color match, morphology, components, fill-holes,
                 occlusion bridge
  trace.js       mask → boundary loops → corner-aware Bézier contours
  fitting.js     char classes, overshoot, auto-spacing, variant sets,
                 ligature keys, weight targeting
  ttf.js         dependency-free TrueType compiler (+ GSUB ligatures)
  classify.js    template character classifier (local, human-confirmed)
  auto.js        deskew + letter detection for the automated lane
  heic.js        HEIC/HEIF intake (vendored libheif, lazy-loaded)
  export.js      specimen layout → SVG / PNG / JPG, per-letterform SVGs
  store.js       library model, persistence, import/export
  sync.js        passcode gate, Drive pull/merge/push, inbox prompts
  demo.js        procedural demo walls (seeded)
  ui/            capture stage (the review surface), review queue, glyph
                 grid + Drive gallery, tester
```

Zero runtime dependencies (the HEIC decoder is vendored and loads only when
a HEIC arrives). The same files run headless in Node for tests.

## Tests

```bash
npm test        # 49 unit tests: geometry, tracing, fitting, morphology,
                # deskew, seeded extraction, stroke-graph isolation,
                # classifier scoring, ligature keys + GSUB, weight targeting,
                # TTF byte format, and the api routes (JWT signing verified
                # against a real keypair, Drive calls stubbed)
npm run e2e     # headless Chromium: demo walls + HEIC intake on the stage,
                # the review queue, click-to-trace, cuts, shift-click pieces,
                # Isolate, Detail, variant cycling, ligature shaping, weight
                # slider, source popup, kerning, exports, TTF download
                # (fontTools-validated) — plus the full sync flow (gate,
                # inbox extraction, SVG mirroring, wiped-device restore,
                # site→Drive upload, the Drive gallery + re-scan) against an
                # in-memory mock of the api contract
```

## Roadmap

- Live community wall (shared backend + moderation; the JSON export is
  already the wire format).
- OpenType `calt`/`rand` so variant cycling ships inside the font file, not
  just the tester.
- Stroke-weight normalization across captures.
