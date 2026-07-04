# Reading a .pptx

Three questions people ask about a deck:

1. **What does it say?** → text extraction.
2. **How is it built?** → structural walk (layouts, placeholders, shapes).
3. **What does it look like?** → thumbnails or PNG render.

Use the smallest tool that answers the question — reading a whole slide
tree is slower than grepping a text export.

---

## Plain-text extraction

```bash
python scripts/dump_text.py input.pptx                     # slides only, one paragraph per line
python scripts/dump_text.py input.pptx --notes             # include speaker notes
python scripts/dump_text.py input.pptx --numbered  # "1: " prefix per slide
python scripts/dump_text.py input.pptx --format md          # H1 per slide, bullets preserved
python scripts/dump_text.py input.pptx --tables            # include table cells (tab-sep)
```

The script has no hard dependency on `python-pptx` — with only the
standard library it walks the ZIP and each slide's `<a:t>` runs directly.
`lxml` is used automatically for faster XPath queries when installed.

For "what does it say?" questions, prefer `--format md --notes`; the
output reads top-to-bottom in a human order (title → body → notes) and
survives `grep`.

## Structural walk (python-pptx)

To answer "how is it built?" — layouts, placeholders, shapes, charts,
tables — use python-pptx directly:

```python
from pptx import Presentation

prs = Presentation("input.pptx")

print(f"slide size: {prs.slide_width}, {prs.slide_height} EMU")
print(f"masters: {len(prs.slide_masters)}, layouts: {sum(len(m.slide_layouts) for m in prs.slide_masters)}")
print(f"slides: {len(prs.slides)}")

for i, slide in enumerate(prs.slides, 1):
    layout = slide.slide_layout.name
    print(f"\n--- slide {i}  (layout: {layout}) ---")
    for shape in slide.shapes:
        kind = shape.shape_type
        text = shape.text_frame.text[:60] if shape.has_text_frame else ""
        print(f"  [{shape.shape_id}] {shape.name:30s} kind={kind}  {text!r}")
```

Shape kinds you'll see most often (from `MSO_SHAPE_TYPE`):

| Value | Meaning                                   |
|-------|-------------------------------------------|
| 1     | Auto shape (rectangle, oval, etc.)        |
| 3     | Chart                                     |
| 6     | Group                                     |
| 13    | Picture                                   |
| 14    | Placeholder (title, body, content, image) |
| 17    | Text box                                  |
| 19    | Table                                     |
| 21    | Diagram / SmartArt                        |

Placeholder details:

```python
for slide in prs.slides:
    for ph in slide.placeholders:
        pf = ph.placeholder_format
        print(f"idx={pf.idx}  type={pf.type}  name={ph.name!r}  has_text={ph.has_text_frame}")
```

`placeholder_format.type` values include `TITLE` (13), `BODY` (2),
`CENTER_TITLE` (15), `SUBTITLE` (4), `PICTURE` (18), `TABLE` (12),
`CHART` (8), `OBJECT` (7), `MEDIA` (16). See `pptx.enum.text.PP_PLACEHOLDER`.

## Metadata

```python
from pptx import Presentation
prs = Presentation("input.pptx")
p = prs.core_properties
print("title:",    p.title)
print("author:",   p.author)
print("subject:",  p.subject)
print("keywords:", p.keywords)
print("created:",  p.created)
print("modified:", p.modified)
print("category:", p.category)
```

For custom / extended properties (rarely present in .pptx but sometimes
set by an internal template), you have to read `docProps/custom.xml`
directly:

```python
import zipfile
from xml.etree import ElementTree as ET

with zipfile.ZipFile("input.pptx") as zf:
    if "docProps/custom.xml" in zf.namelist():
        root = ET.fromstring(zf.read("docProps/custom.xml"))
        for prop in root.iter():
            if prop.tag.endswith("}property"):
                name = prop.get("name")
                value_elem = list(prop)[0] if len(prop) else None
                print(name, "=", value_elem.text if value_elem is not None else None)
```

## Speaker notes

```python
from pptx import Presentation
prs = Presentation("input.pptx")
for i, slide in enumerate(prs.slides, 1):
    if slide.has_notes_slide:
        text = slide.notes_slide.notes_text_frame.text
        if text.strip():
            print(f"\n=== slide {i} notes ===\n{text}")
```

Or use `scripts/dump_text.py --notes` which does the same walk.

## Tables

```python
from pptx import Presentation

prs = Presentation("input.pptx")
for i, slide in enumerate(prs.slides, 1):
    for shape in slide.shapes:
        if not shape.has_table:
            continue
        print(f"\n--- table on slide {i} ({shape.table.rows.__len__()}x{shape.table.columns.__len__()}) ---")
        for row in shape.table.rows:
            print("\t".join(cell.text_frame.text for cell in row.cells))
```

## Charts

python-pptx exposes chart data:

```python
for slide in prs.slides:
    for shape in slide.shapes:
        if not shape.has_chart:
            continue
        chart = shape.chart
        print("chart type:", chart.chart_type)
        for plot in chart.plots:
            for series in plot.series:
                print(f"  series: {series.name!r}  values: {list(series.values)}")
        # category labels
        for plot in chart.plots:
            print("  categories:", list(plot.categories))
```

To dump chart data as CSV:

```python
import csv
from pptx import Presentation

prs = Presentation("input.pptx")
for i, slide in enumerate(prs.slides, 1):
    for j, shape in enumerate(s for s in slide.shapes if s.has_chart):
        chart = shape.chart
        with open(f"chart-{i}-{j}.csv", "w", newline="") as fh:
            w = csv.writer(fh)
            plots = list(chart.plots)
            categories = list(plots[0].categories) if plots else []
            header = ["category"] + [series.name for plot in plots for series in plot.series]
            w.writerow(header)
            for row_i, cat in enumerate(categories):
                row = [cat] + [list(series.values)[row_i] for plot in plots for series in plot.series]
                w.writerow(row)
```

## Images

Two ways to get images out:

1. **All images in the deck** — they live at `ppt/media/*` inside the ZIP:

   ```bash
   python -c "
   import zipfile, os
   with zipfile.ZipFile('input.pptx') as zf:
       os.makedirs('media_out', exist_ok=True)
       for name in zf.namelist():
           if name.startswith('ppt/media/'):
               out = os.path.join('media_out', os.path.basename(name))
               with open(out, 'wb') as fh:
                   fh.write(zf.read(name))
               print(out)
   "
   ```

2. **Images tied to a specific slide** — python-pptx exposes each picture
   shape's raw bytes:

   ```python
   from pptx import Presentation
   prs = Presentation("input.pptx")
   for i, slide in enumerate(prs.slides, 1):
       for j, shape in enumerate(s for s in slide.shapes if s.shape_type == 13):
           img = shape.image
           with open(f"slide-{i}-img-{j}.{img.ext}", "wb") as fh:
               fh.write(img.blob)
   ```

## Thumbnails (visual preview grid)

```bash
python scripts/contact_sheet.py input.pptx                    # writes input.contact-sheet.jpg
python scripts/contact_sheet.py input.pptx --cols 4           # 4 slides per row
python scripts/contact_sheet.py input.pptx --limit 24           # cap to first 24 slides
python scripts/contact_sheet.py input.pptx --out preview.jpg  # explicit output path
```

Under the hood: `soffice --convert-to pdf` → `pdftoppm` → Pillow tiles
the PNGs into a single JPEG with slide-number labels.

Use thumbnails to **pick a template slide layout** ("which of these
looks like a section divider?"). For serious visual QA of a generated
deck, render at full resolution:

```bash
python scripts/render_slides.py output.pptx --out qa/ --dpi 150
open qa/slide-*.png   # macOS; pdftoppm zero-pads numbers on decks ≥10 slides
```

## Rendering to PDF / PNG

```bash
# whole deck to a single PDF
python scripts/render_pdf.py input.pptx                    # writes input.pdf

# every slide to its own PNG
python scripts/render_slides.py input.pptx --out slides/       # slides/slide-1.png, ... (zero-padded on decks ≥10 slides)
python scripts/render_slides.py input.pptx --out slides/ --dpi 200
python scripts/render_slides.py input.pptx --out slides/ --first 3 --last 3
```

`render_slides.py` renders via LibreOffice → PDF, then Poppler's `pdftoppm`
to raster each page. That's why LibreOffice + Poppler are both listed
as optional dependencies in `SKILL.md`.

## Detecting broken files

```bash
python scripts/diagnose.py input.pptx
```

Failure modes:

- `not a valid ZIP file` — the file is corrupt or truncated.
- `missing required part` — an `[Content_Types].xml` or
  `ppt/presentation.xml` was deleted.
- `parse error` in an XML part — hand-edited XML with a syntax error.
- `python-pptx could not open the file` — an internal reference is
  broken (e.g. a `<p:sldId>` points at a rels ID that doesn't resolve to
  a slide).

Fix the specific issue reported. `diagnose.py` runs
python-pptx and lxml checks if those libraries are installed; both are
optional, both help.

## Round-tripping for structural inspection

If you want to see the raw XML of every slide:

```bash
python scripts/explode.py input.pptx unpacked/
ls unpacked/ppt/slides/          # slide1.xml, slide2.xml, ...
```

`explode.py` pretty-prints XML with a stable two-space indent, so `diff`
output between two decks is small and readable.
