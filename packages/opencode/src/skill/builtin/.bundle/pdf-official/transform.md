# Transforming an existing PDF

Goal: rearrange, protect, or shrink a PDF that already exists. This chapter
covers everything that mutates page order, orientation, or file-level
properties. For adding new *content* to a page, see `compose.md` (§8 for the
overlay technique).

Each recipe has a **pypdf** version (permissive Python) and a **qpdf**
version (Apache-2.0 CLI, faster on huge inputs). Default to pypdf.

## 1. Combine

pypdf:

```python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
for path in ["intro.pdf", "chapter1.pdf", "chapter2.pdf", "appendix.pdf"]:
    for page in PdfReader(path).pages:
        writer.add_page(page)

with open("book.pdf", "wb") as fh:
    writer.write(fh)
```

qpdf:

```bash
qpdf --empty --pages intro.pdf chapter1.pdf chapter2.pdf appendix.pdf -- book.pdf

# cherry-picking pages in one command
qpdf --empty --pages intro.pdf 1-3 chapter1.pdf 1-z \
                    chapter2.pdf 2,4 appendix.pdf r5-z -- book.pdf
```

`z` means "last page"; `r5` means "5 from the end".

Wrapper:

```bash
scripts/combine.py intro.pdf chapter1.pdf chapter2.pdf --out book.pdf
scripts/combine.py a.pdf b.pdf --out out.pdf --preserve-metadata FIRST
```

## 2. Carve (split)

By fixed size — qpdf's built-in split:

```bash
qpdf --split-pages=10 handbook.pdf handbook_%02d.pdf
```

Per page — one output file per page:

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("handbook.pdf")
for i, page in enumerate(reader.pages, start=1):
    w = PdfWriter()
    w.add_page(page)
    with open(f"handbook_p{i:03d}.pdf", "wb") as fh:
        w.write(fh)
```

By range:

```bash
qpdf handbook.pdf --pages . 1-25 -- part1.pdf
qpdf handbook.pdf --pages . 26-z -- part2.pdf
```

Wrapper (all three modes, one binary):

```bash
scripts/carve.py handbook.pdf --by-range 1-25 26-50 51-z --dest parts/
scripts/carve.py handbook.pdf --every-page --dest pages/
scripts/carve.py handbook.pdf --chunk-size 10 --dest chunks/
```

## 3. Reorient (rotate)

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("scan.pdf")
writer = PdfWriter()
for i, page in enumerate(reader.pages, start=1):
    if i in {2, 5, 6}:
        page.rotate(90)          # 90 / 180 / 270 clockwise
    writer.add_page(page)

with open("scan_rotated.pdf", "wb") as fh:
    writer.write(fh)
```

qpdf, one shot:

```bash
qpdf scan.pdf scan_rotated.pdf --rotate=+90:2,5,6 --rotate=180:9
```

Wrapper:

```bash
scripts/reorient.py scan.pdf --angle 90 --targets 2,5,6 --out out.pdf
scripts/reorient.py scan.pdf --angle 180 --targets all --out flipped.pdf
```

## 4. Crop

`mediabox` is the physical page; `cropbox` is the visible one. Set both to
change what viewers show:

```python
from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject

reader = PdfReader("wide.pdf")
writer = PdfWriter()

for page in reader.pages:
    # PDF points: (left, bottom, right, top). Origin bottom-left.
    page.cropbox = RectangleObject((36, 36, 576, 756))
    page.mediabox = page.cropbox
    writer.add_page(page)

with open("cropped.pdf", "wb") as fh:
    writer.write(fh)
```

Tip: `pdfinfo scan.pdf` prints the current `MediaBox` — use it to sanity-check
your target box.

## 5. Watermark / stamp

Overlay a source PDF (the "stamp") onto every page of a target:

```python
from pypdf import PdfReader, PdfWriter

target = PdfReader("contract.pdf")
stamp  = PdfReader("draft_watermark.pdf").pages[0]

writer = PdfWriter()
for page in target.pages:
    page.merge_page(stamp)
    writer.add_page(page)

with open("contract_draft.pdf", "wb") as fh:
    writer.write(fh)
```

Generate the stamp on the fly (semi-transparent, diagonal):

```python
import io
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

def build_stamp(text="DRAFT"):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.saveState()
    c.translate(letter[0] / 2, letter[1] / 2)
    c.rotate(30)
    c.setFillColorRGB(0.85, 0.1, 0.1, alpha=0.15)
    c.setFont("Helvetica-Bold", 100)
    c.drawCentredString(0, 0, text)
    c.restoreState()
    c.save()
    buf.seek(0)
    return buf

stamp_page = PdfReader(build_stamp("DRAFT")).pages[0]
```

## 6. Encrypt / decrypt

qpdf (AES-256, recommended):

```bash
qpdf --encrypt reader_pw owner_pw 256 \
     --print=full --modify=none --extract=none \
     -- input.pdf secured.pdf
```

Permissions vocabulary:

- `--print=none|low|full`
- `--modify=none|assembly|form|annotate|all`
- `--extract=y|n`

Unlock:

```bash
qpdf --password=reader_pw --decrypt secured.pdf unlocked.pdf
```

pypdf (works, older RC4 by default — pass `algorithm="AES-256"` for modern):

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter(clone_from=reader)
writer.encrypt(user_password="reader_pw", owner_password="owner_pw",
               algorithm="AES-256")
with open("secured.pdf", "wb") as fh:
    writer.write(fh)
```

## 7. Linearize + shrink

```bash
qpdf --linearize input.pdf webready.pdf
qpdf --object-streams=generate --compress-streams=y input.pdf smaller.pdf
```

For image-heavy files, real size wins come from re-encoding images at lower
DPI before merging back — `pdfimages -all` → Pillow → reportlab.

## 8. Repair

Symptom: pypdf raises `PdfReadError`; viewers show "damaged" toast.

```bash
qpdf --check broken.pdf                  # what's wrong?
qpdf --replace-input broken.pdf          # rewrite in place, best-effort
qpdf broken.pdf repaired.pdf             # or write to a new file
```

If qpdf can't fix it, open in Chrome and print-to-PDF — that survives most
malformed xref tables.

## 9. Extract or delete individual pages

Extract:

```bash
qpdf book.pdf --pages . 40-52 -- chapter3.pdf
```

Delete pages 5, 7–9:

```bash
qpdf book.pdf --pages . 1-4,6,10-z -- book_trimmed.pdf
```

Pure Python:

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("book.pdf")
total = len(reader.pages)
keep = set(range(1, total + 1)) - {5, 7, 8, 9}

writer = PdfWriter()
for i, page in enumerate(reader.pages, start=1):
    if i in keep:
        writer.add_page(page)
with open("book_trimmed.pdf", "wb") as fh:
    writer.write(fh)
```

## 10. Replace a page in place

```python
from pypdf import PdfReader, PdfWriter

original    = PdfReader("book.pdf")
replacement = PdfReader("new_page_42.pdf").pages[0]

writer = PdfWriter()
for i, page in enumerate(original.pages, start=1):
    writer.add_page(replacement if i == 42 else page)

with open("book_v2.pdf", "wb") as fh:
    writer.write(fh)
```

## Validation

After any structural mutation:

```bash
scripts/survey.py out.pdf --pretty    # page count still right?
scripts/sanity_check.py out.pdf        # round-trip clean?
qpdf --check out.pdf                   # any structural warnings?
```

Missing-page-after-split is almost always an off-by-one. qpdf ranges are
1-based, **inclusive**; pypdf's `reader.pages` is 0-based. Wrapper scripts
here use 1-based indices throughout.
