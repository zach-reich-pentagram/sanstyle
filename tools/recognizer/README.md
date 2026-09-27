# The letter recognizer

`js/letters-model.js` holds the weights of the small convolutional network
`js/recognize.js` runs in the browser. These scripts rebuild it.

```bash
cd tools/recognizer
python3 -m venv venv
./venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
./venv/bin/pip install numpy pillow scipy fonttools

# handwritten characters: EMNIST by-class (Hugging Face mirror)
mkdir -p emnist && for f in emnist-byclass-train-images-idx3-ubyte.gz emnist-byclass-train-labels-idx1-ubyte.gz; do
  curl -L -o emnist/$f https://huggingface.co/datasets/Royc30ne/emnist-byclass/resolve/main/$f; done

# fonts: hand-lettering, display and a sample of text faces from Google Fonts
curl -o gf-meta.json https://fonts.google.com/metadata/fonts
./venv/bin/python getfonts.py     # → fonts/*.ttf
./venv/bin/python fontcheck.py    # → fonts/cover.json (which characters each font has)

# training data: 480k letters + 160k junk-heavy, then a validation set of each kind
./venv/bin/python gen.py 480000 train.npz 1
JUNK_SHARE=0.45 ./venv/bin/python gen.py 160000 train2.npz 3
./venv/bin/python gen.py 24000 val.npz 77
JUNK_SHARE=0.2 ./venv/bin/python gen.py 16000 val2.npz 88

./venv/bin/python train.py 12     # → letters-model.js (copy it to js/)
```

About 40 minutes on four CPU cores. `gen.py` is the part worth reading: each
sample is a clean glyph (EMNIST or a font) made to look like a letter pulled
off a wall — slant, rotation, wobble, stroke weight from hairline to
throw-up (counters kept open), ragged edges, drips, specks, pocks — or
"junk": two or three letters fused, a letter with a cut-off neighbor, a
neighbor's fragment or paint debris on it, scribbles, blobs, stickers,
strips. `to_input()` is mirrored exactly by `recognize.input()`.
