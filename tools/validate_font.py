#!/usr/bin/env python3
"""Validate a SANSTYLE-generated TTF with fontTools: parse every table,
round-trip through TTX XML, and print key metrics. Exits non-zero on failure."""
import sys
import io

from fontTools.ttLib import TTFont


def main(path):
    font = TTFont(path)  # lazy=False parse
    tables = sorted(font.keys())
    print("tables:", " ".join(tables))

    # Force-decompile everything (catches malformed table data).
    for tag in tables:
        _ = font[tag]

    # TTX round-trip of the whole font.
    buf = io.StringIO()
    font.saveXML(buf)
    xml_len = len(buf.getvalue())

    head = font["head"]
    hmtx = font["hmtx"]
    cmap = font.getBestCmap()
    glyf = font["glyf"]
    n_outlined = sum(
        1 for g in font.getGlyphOrder() if glyf[g].numberOfContours > 0
    )
    print(f"unitsPerEm={head.unitsPerEm} glyphs={len(font.getGlyphOrder())} "
          f"outlined={n_outlined} mapped_chars={len(cmap)} ttx_bytes={xml_len}")

    for cp in sorted(cmap)[:12]:
        name = cmap[cp]
        adv, lsb = hmtx[name]
        g = glyf[name]
        bbox = (g.xMin, g.yMin, g.xMax, g.yMax) if g.numberOfContours else None
        print(f"  U+{cp:04X} {chr(cp)!r} -> {name}: advance={adv} lsb={lsb} bbox={bbox}")

    # Re-save binary (validates compile path in fontTools too).
    out = io.BytesIO()
    font.save(out)
    print(f"resave_ok bytes={len(out.getvalue())}")
    print("VALID")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as e:  # noqa: BLE001
        print(f"INVALID: {type(e).__name__}: {e}")
        sys.exit(1)
