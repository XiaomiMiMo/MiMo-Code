# Filling an interactive form

Two very different situations hide behind the words "PDF form":

- **AcroForm** — real interactive widgets baked into the PDF. Any viewer can
  fill them, and so can pypdf.
- **Non-fillable form** — a page that *looks* like a form (labels, boxes,
  rules) but has no widgets. Common for scanned forms and designer-exported
  layouts. We handle these by drawing text and checks at hand-picked
  coordinates onto a transparent overlay, then merging.

Third case: **XFA** (Adobe LiveCycle). AcroForm libraries can't fill these.
Open in Adobe Reader — if the form pops in a moment after loading, it's XFA.
Flatten with Adobe Acrobat first, then treat as AcroForm.

## Step 0 — probe first, always

```bash
scripts/survey.py form.pdf --pretty
```

- `form_field_count > 0` → §1 (widgets path)
- `form_field_count == 0` → §2 (overlay path)
- Widgets *visible* in Adobe Reader but `form_field_count == 0` → likely XFA
  → flatten before doing anything.

## 1. Widgets path (AcroForm)

### 1.1 List what's there

```bash
scripts/probe_fields.py form.pdf --output fields.json
```

Output (JSON array):

```json
[
  {
    "name": "applicant.last_name",
    "kind": "text",
    "page": 1,
    "rect": [102.0, 640.5, 320.0, 660.5],
    "multiline": false,
    "password": false
  },
  {
    "name": "citizen_flag",
    "kind": "checkbox",
    "page": 1,
    "rect": [280.0, 590.0, 292.0, 602.0],
    "checked_value": "/Yes",
    "unchecked_value": "/Off"
  },
  {
    "name": "marital",
    "kind": "radio_group",
    "page": 1,
    "options": [
      {"value": "/S", "rect": [110, 555, 122, 567], "page": 1},
      {"value": "/M", "rect": [180, 555, 192, 567], "page": 1},
      {"value": "/D", "rect": [250, 555, 262, 567], "page": 1}
    ]
  },
  {
    "name": "employment",
    "kind": "choice",
    "page": 2,
    "options": [
      {"value": "FT", "text": "Full-time"},
      {"value": "PT", "text": "Part-time"},
      {"value": "CT", "text": "Contractor"}
    ]
  }
]
```

Field kinds and how to set their `value`:

| kind          | value                                                       |
|---------------|-------------------------------------------------------------|
| `text`        | any string                                                  |
| `checkbox`    | `checked_value` (usually `/Yes`) or `unchecked_value` (`/Off`) |
| `radio_group` | one of `options[].value` (or `"/Off"` to clear all)         |
| `choice`      | one of `options[].value`                                    |
| `signature`   | not supported here — needs a real cert                      |

`rect` is `[x0, y0, x1, y1]` in PDF points, y=0 at the BOTTOM of the page.

### 1.2 Preview so you can eyeball each field

```bash
scripts/probe_fields.py form.pdf --render-marked preview/ --output fields.json
```

Writes `preview/page_01_marked.png` etc. with each field's rectangle in red
and its name labelled just above.

### 1.3 Author a values file

Copy the interesting fields into `values.json`:

```json
[
  {"name": "applicant.last_name",  "value": "Ramirez"},
  {"name": "applicant.first_name", "value": "Priya"},
  {"name": "applicant.dob",        "value": "1993-08-14"},
  {"name": "citizen_flag",         "value": "/Yes"},
  {"name": "marital",              "value": "/M"},
  {"name": "employment",           "value": "FT"}
]
```

The value **must match exactly** (case-sensitive for `/Yes`, `/Off`).

### 1.4 Apply

```bash
scripts/apply_values.py form.pdf values.json --out filled.pdf
```

`apply_values.py` validates every entry against the probed field types
*before* writing:

- unknown field name → error
- checkbox / radio / choice value not in the legal set → error
- signature field targeted → error (unsupported)

Exit code `3` means a validation problem. The output file is not touched in
that case.

Under the hood it calls `writer.update_page_form_field_values(page, {...})`
and sets `/NeedAppearances = True` on `AcroForm` — some viewers (older
Preview.app, in-browser PDF viewers) render blank text fields without that
flag.

Optional flattening (values become permanent, widgets removed):

```bash
scripts/apply_values.py form.pdf values.json --out filled.pdf --flatten
```

Flatten before sending to counterparties who might resave and wipe your
values.

### 1.5 Verify

```bash
scripts/render_pages.py filled.pdf verify/ --dpi 200
```

Adobe, Chrome, and Preview all render fields slightly differently — check in
whichever your recipient will use.

## 2. Overlay path (non-fillable)

No widgets exist. Plan: pick a rectangle for every thing we want to write,
generate a transparent PDF overlay, merge onto the source.

Two ways to pick coordinates. Prefer §2.a; fall back to §2.b for scans.

### 2.a Coordinates from structure (preferred)

Works whenever the PDF has real text labels and vector rules — most gov /
HR forms exported from Word or InDesign.

```bash
scripts/probe_fields.py form.pdf --mode skeleton --output skeleton.json
```

Output:

```json
{
  "pages": [
    {
      "page": 1, "width": 612, "height": 792,
      "labels":   [{"text": "Last name", "x0": 43, "top": 63, "x1": 87, "bottom": 73}, …],
      "rules":    [{"x0": 92, "x1": 340, "y": 79}, …],
      "squares":  [{"x0": 285, "top": 197, "x1": 297, "bottom": 209, "cx": 291, "cy": 203}, …]
    }
  ]
}
```

- `labels[]` — every text token with its bbox (pdfplumber convention: `top`=0
  at TOP of page).
- `rules[]` — horizontal lines (typically the bottom of the fill line).
- `squares[]` — small square rectangles; probably checkboxes.

Turn labels into entry rectangles by convention:

- `entry.x0 = label.x1 + 5`
- `entry.x1 = next_label.x0 - 5` (or the next vertical rule)
- `entry.top = label.top`
- `entry.bottom = row's bottom rule` (or `label.top + row_height`)

**Convert before writing the plan**: skeleton coordinates are pdfplumber
convention (`top`=0 at the TOP, y grows down), but the plan below declares
`geometry: "pdf_points"` (origin at the BOTTOM, y grows up). Flip each y:

```
y_pdf = page_height − y_top          # 792 − 79 = 713, 792 − 63 = 729
box   = [x0, page_height − bottom, x1, page_height − top]
```

Now write a plan file in **PDF points**:

```json
{
  "geometry": "pdf_points",
  "page_size": {"width": 612, "height": 792},
  "marks": [
    {"page": 1, "kind": "text",  "box": [92, 713, 260, 729],
     "text": "Ramirez", "font_size": 10},
    {"page": 1, "kind": "check", "box": [285, 587, 292, 595]}
  ]
}
```

Then:

```bash
scripts/overlay_text.py form.pdf plan.json --out filled.pdf
```

### 2.b Visual estimation (fallback for scans)

When the PDF is image-only (labels are `(cid:12)` gibberish), pick pixels
from a rendered page and let the tool convert.

```bash
scripts/render_pages.py form.pdf pages/ --dpi 200      # e.g. 1700×2200 px
```

Zoom-refine each field with ImageMagick to nail the exact pixels:

```bash
magick pages/page_001.png -crop 300x80+50+120 +repage crops/name.png
```

Coordinate math: if the crop started at `(cx, cy) = (50, 120)` and inside
the crop the entry line runs from `(2, 18)` to `(295, 45)`, the entry
rectangle in the full image is `(52, 138, 345, 165)`.

Keep the coordinates in image pixels — `overlay_text.py` converts:

```json
{
  "geometry": "image_pixels",
  "image_size": {"width": 1700, "height": 2200},
  "page_size":  {"width": 612,  "height": 792},
  "marks": [
    {"page": 1, "kind": "text", "box": [255, 175, 720, 218],
     "text": "Ramirez", "font_size": 10}
  ]
}
```

### 2.c Coordinate systems, all together

Every "coordinates are off by a few points" bug is one of these three
systems misapplied.

| System         | Origin       | y grows | Used by                       |
|----------------|--------------|---------|-------------------------------|
| PDF points     | bottom-left  | upward  | pypdf, reportlab, qpdf, ISO 32000 |
| pdfplumber     | top-left     | downward| `page.chars`, `page.lines`    |
| Image pixels   | top-left     | downward| every image viewer            |

`overlay_text.py` takes either PDF-points or image-pixels input (declared
via `geometry`) and always writes reportlab (PDF points) internally. It
refuses to run without a valid `geometry` declaration.

### 2.d Sanity check the plan before merging

```bash
scripts/overlay_text.py form.pdf plan.json --dry-run --preview qa/
```

Writes `qa/page_XX_preview.png` with red rectangles where the text will land
and the intended text next to each one. Fails if:

- any rectangle is degenerate (x0 ≥ x1 or y0 ≥ y1)
- any text rectangle is too short vertically for its `font_size`
- two marks on the same page overlap
- a mark references a page that doesn't exist

## 3. Special cases

### 3.1 Checkboxes with unusual on-values

Some forms use `/1` / `/Off`, or `/On` / `/Off`, or a custom name like
`/CB1`. Always use `checked_value` from `fields.json`; never assume.

### 3.2 Radio groups

The `radio_group` value is the whole group's, not per-button:

```json
{"name": "marital", "value": "/M"}
```

### 3.3 Multi-line text fields

If `multiline: true`, put literal `\n` in the value:

```json
{"name": "address", "value": "1 Market St.\nApt 4B\nSan Francisco, CA"}
```

### 3.4 Hybrid (fill AcroForm then stamp missing bits)

If most of the form is AcroForm but a few labels have no widgets:

1. `apply_values.py form.pdf values.json --out step1.pdf`
2. `overlay_text.py step1.pdf plan.json --out final.pdf`

The two passes don't interfere.

### 3.5 Signatures

Digital signatures require an X.509 cert and a signing library — out of
scope. For a *visual*-only signature (image of a handwritten signature),
treat it as a plain image overlay via `compose.md` §6.

## Verify

```bash
scripts/survey.py filled.pdf --pretty            # counts still right?
scripts/render_pages.py filled.pdf verify/        # visually confirm
```

If you flattened, confirm the widgets are gone:

```bash
scripts/probe_fields.py filled.pdf                # should return []
```
