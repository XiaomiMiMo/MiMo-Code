# Extracting content

Goal: turn a PDF into a usable text file, table, image, or metadata dump.

Before any extraction, run `scripts/survey.py` to route yourself. The
`looks_scanned` flag saves you from wasting time trying to pull text out of a
raster:

```
survey.py in.pdf
    │
    ├── is_locked: true   ──►  §6  (unlock first)
    ├── looks_scanned: true ──►  §5 (OCR)
    └── otherwise          ──►  §1 → §4 as needed
```

## 1. Plain-text dump

`scripts/text_dump.py` picks between two engines automatically. Pure-python
first (no GPL); poppler when it's installed and you didn't ask otherwise.

```bash
scripts/text_dump.py handbook.pdf --out handbook.txt
scripts/text_dump.py handbook.pdf --engine python           # skip poppler
scripts/text_dump.py handbook.pdf --engine poppler --layout # preserve columns
scripts/text_dump.py handbook.pdf --select 4-9              # pages 4..9 only
```

Directly with pypdf:

```python
from pypdf import PdfReader

pages_out = []
for i, page in enumerate(PdfReader("handbook.pdf").pages, start=1):
    pages_out.append(f"\f--- page {i} ---\n")
    pages_out.append(page.extract_text() or "")
print("".join(pages_out))
```

`extract_text()` returns an empty string on pages with no text stream — that's
your scan-detection signal.

Directly with poppler:

```bash
pdftotext -layout handbook.pdf handbook.txt      # columns preserved
pdftotext -f 4 -l 9 handbook.pdf slice.txt       # 1-based page range
pdftotext -bbox-layout handbook.pdf out.xml      # per-word bounding boxes
```

## 2. Positioned text (columns, forms, key/value pairs)

`pdfplumber` exposes the raw draw primitives — each `char` has an `x0`, `top`,
`x1`, `bottom`. Use it whenever layout matters.

```python
import pdfplumber

with pdfplumber.open("statement.pdf") as pdf:
    page = pdf.pages[0]

    # per-character positions
    for ch in page.chars[:20]:
        print(f"{ch['text']!r} @ ({ch['x0']:.1f}, {ch['top']:.1f})")

    # bounded read (pdfplumber convention: top=0 at TOP of page)
    header = page.crop((0, 0, page.width, 80)).extract_text()

    # words with their bounding boxes
    for w in page.extract_words():
        print(w['x0'], w['top'], w['text'])
```

Layout kwargs matter on tight columns:

```python
text = page.extract_text(x_tolerance=1.5, y_tolerance=2)
```

## 3. Tables

Two strategies. `"lines"` when the table has visible ruling; `"text"` when the
columns are aligned by whitespace only.

```python
import pdfplumber
import csv

with pdfplumber.open("earnings.pdf") as pdf:
    for pi, page in enumerate(pdf.pages, start=1):
        tables = page.extract_tables({
            "vertical_strategy":   "lines",
            "horizontal_strategy": "lines",
            "snap_tolerance":      4,
        })
        for tj, rows in enumerate(tables, start=1):
            with open(f"page{pi}_table{tj}.csv", "w", newline="") as fh:
                csv.writer(fh).writerows(rows)
```

Text-only alignment (invoice-style tables):

```python
tables = page.extract_tables({
    "vertical_strategy":   "text",
    "horizontal_strategy": "text",
    "min_words_vertical":  2,
})
```

Debug misdetection visually:

```python
page.to_image(resolution=150).debug_tablefinder(table_settings={}).save("debug.png")
```

## 4. Rendering pages to images

Use pypdfium2 (Apache/BSD PDFium binding). No GPL dependency.

```bash
scripts/render_pages.py brochure.pdf out/ --dpi 200 --format png
scripts/render_pages.py brochure.pdf out/ --select 1-3 --format jpg --quality 82
```

Straight library call:

```python
import pypdfium2 as pdfium

doc = pdfium.PdfDocument("brochure.pdf")
for i, page in enumerate(doc, start=1):
    page.render(scale=2.0).to_pil().save(f"page_{i:02d}.png")
```

### Embedded images (not rendered pages)

Poppler:

```bash
pdfimages -all catalog.pdf out/img          # writes out/img-000.jpg …
pdfimages -list catalog.pdf                 # inventory without extraction
```

pypdf (pure Python — decoders limited to common filters):

```python
from pathlib import Path
from pypdf import PdfReader

out = Path("images"); out.mkdir(exist_ok=True)
for pi, page in enumerate(PdfReader("catalog.pdf").pages, start=1):
    for ii, img in enumerate(page.images, start=1):
        (out / f"p{pi}_i{ii}_{img.name}").write_bytes(img.data)
```

## 5. OCR fallback for scans

`survey.py` marks scans with `looks_scanned: true`. Route to `recognize.py`:

```bash
scripts/recognize.py scan.pdf --out scan.txt --language eng --dpi 300
scripts/recognize.py scan.pdf --out scan.txt --language eng+deu
scripts/recognize.py scan.pdf --out scan.txt --parallel 4   # 4 workers
```

Underlying library calls (pypdfium2 to rasterise, pytesseract to OCR):

```python
import pypdfium2 as pdfium
import pytesseract

for i, page in enumerate(pdfium.PdfDocument("scan.pdf"), start=1):
    img = page.render(scale=4.0).to_pil()           # ~288 DPI
    print(pytesseract.image_to_string(img, lang="eng"))
```

Accuracy tips:

- 300 DPI is the elbow of the accuracy/latency curve.
- Deskew and binarise heavy noise: `ImageOps.grayscale`, `autocontrast`,
  `MedianFilter(3)`.
- The parallel path uses `ProcessPoolExecutor` — Tesseract is CPU-bound and
  scales roughly linearly with cores.

## 6. Encrypted PDFs

```python
from pypdf import PdfReader
reader = PdfReader("locked.pdf")
if reader.is_encrypted:
    if reader.decrypt("password") == 0:
        raise SystemExit("wrong password")
```

If pypdf refuses (AES-256, unusual owner-only permissions), decrypt with qpdf:

```bash
qpdf --password=secret --decrypt locked.pdf unlocked.pdf
qpdf --show-encryption locked.pdf              # what's set on the file?
```

## 7. Metadata

Standard metadata:

```python
md = PdfReader("thesis.pdf").metadata
print(md.title, md.author, md.creator, md.producer, md.creation_date)
```

Full trailer / XMP:

```bash
qpdf --show-object=trailer thesis.pdf
```

## Post-extraction sanity check

```bash
scripts/survey.py thesis.pdf --pretty                  # counts match?
scripts/text_dump.py thesis.pdf | wc -w                 # non-zero for text PDFs
scripts/render_pages.py thesis.pdf preview/ --select 1  # opens cleanly?
```

If word counts are near zero on a "text-looking" PDF, re-run `survey.py` —
`looks_scanned` was almost certainly the right route.
