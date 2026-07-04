# Creating a .pptx from scratch

This guide covers two authoring surfaces. Pick one:

- **[python-pptx](#python-pptx-recipes)** — a Python object model over the
  PresentationML spec. Best for repeatable, data-driven decks (weekly
  reports, dashboards, template fill).
- **[PptxGenJS](#pptxgenjs-recipes)** — a JavaScript API that emits PPTX
  files. Best for design-heavy custom layouts where you want more shape /
  chart primitives than python-pptx exposes.

Both write valid PresentationML files that PowerPoint, Keynote, Google
Slides, and LibreOffice open cleanly.

## Which one should I use?

| Constraint | Choice |
|------------|--------|
| Python codebase already | python-pptx |
| Node codebase already | PptxGenJS |
| You want to fill a template made in PowerPoint | python-pptx |
| You want charts with custom colors + rounded backgrounds | PptxGenJS (more knobs) |
| You need speaker notes filled from a script | python-pptx (cleanest API) |
| You need SVG icons or React icon components on every slide | PptxGenJS + `react-icons` |
| You need to run in a container without Node installed | python-pptx |
| Bulk data → chart-heavy deck (100+ slides) | python-pptx (faster in practice) |

---

## python-pptx recipes

Install:

```bash
python3 -m pip install --upgrade python-pptx Pillow
```

### Skeleton

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor

prs = Presentation()                      # default template opens at 4:3
prs.slide_width  = Inches(13.333)          # so set 16:9 (720p) explicitly
prs.slide_height = Inches(7.5)

# layout indices for the default template:
#   0 title, 1 title+content, 2 section header, 3 two-content,
#   4 comparison, 5 title only, 6 blank, 7 content+caption,
#   8 picture+caption
title_slide = prs.slides.add_slide(prs.slide_layouts[0])
title_slide.shapes.title.text = "Q3 Product Review"
title_slide.placeholders[1].text = "What shipped, what slipped, what's next"

prs.save("review.pptx")
```

### Text on a slide

```python
from pptx.util import Pt
from pptx.enum.text import PP_ALIGN

slide = prs.slides.add_slide(prs.slide_layouts[5])   # title-only layout
slide.shapes.title.text = "Revenue grew 34% on 22% headcount"

# free-standing text box (not tied to a placeholder)
tb = slide.shapes.add_textbox(Inches(0.5), Inches(1.5), Inches(12.3), Inches(4.5))
tf = tb.text_frame
tf.word_wrap = True

p = tf.paragraphs[0]                   # first paragraph exists by default
p.text = "The efficiency story."
p.alignment = PP_ALIGN.LEFT
p.runs[0].font.size = Pt(28)
p.runs[0].font.bold = True

p2 = tf.add_paragraph()
p2.text = "Every product line beat plan; hiring stayed flat."
p2.runs[0].font.size = Pt(18)
```

Notes on text:

- `text_frame.paragraphs[0]` always exists. Do not call `add_paragraph()`
  for the first line; you'll get a blank line at the top.
- `run.font.size` must be a `Pt(...)` value. Passing a bare integer sets
  raw EMU and produces microscopic text.
- Set `text_frame.word_wrap = True` when you want the box to wrap; otherwise
  the text extends past the box's right edge without a visual clue.
- To match a placeholder's autofit behavior, don't touch it. To disable
  autofit and let text overflow, use `MSO_AUTO_SIZE.NONE`:

  ```python
  from pptx.enum.text import MSO_AUTO_SIZE
  tf.auto_size = MSO_AUTO_SIZE.NONE
  ```

### Bulleted list

```python
tf = tb.text_frame
tf.word_wrap = True

for i, item in enumerate(["First point", "Second point", "Third point"]):
    p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
    p.text = item
    p.level = 0
    p.runs[0].font.size = Pt(18)
```

`p.level = 1` for nested bullets. The theme controls the bullet character —
python-pptx does not expose direct control, so if the theme uses squares
and you want dots, either edit the master (see `edit.md`) or use free
text with a manual glyph.

### Shapes and stat callouts

```python
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor

slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank

# background block
rect = slide.shapes.add_shape(
    MSO_SHAPE.RECTANGLE, Inches(0), Inches(0), prs.slide_width, prs.slide_height
)
rect.fill.solid()
rect.fill.fore_color.rgb = RGBColor(0x1F, 0x3A, 0x5F)   # deep navy
rect.line.fill.background()                              # no border

# big number
n = slide.shapes.add_textbox(Inches(1), Inches(1.8), Inches(11), Inches(3))
n.text_frame.text = "34%"
r = n.text_frame.paragraphs[0].runs[0]
r.font.size = Pt(140); r.font.bold = True
r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

# label under the number
l = slide.shapes.add_textbox(Inches(1), Inches(5.1), Inches(11), Inches(1))
l.text_frame.text = "YoY revenue growth, Q3 vs Q3"
lr = l.text_frame.paragraphs[0].runs[0]
lr.font.size = Pt(22)
lr.font.color.rgb = RGBColor(0xC8, 0xD3, 0xE6)
```

Anti-pattern: setting the border by leaving `line` untouched. python-pptx's
default is a 1pt black line on rectangles; call `.line.fill.background()`
to make it invisible, or set a color explicitly.

### Images

```python
from pptx.util import Inches
slide.shapes.add_picture("chart.png", Inches(1), Inches(1.5), Inches(11), Inches(5.5))
```

If you omit `width` and `height`, python-pptx uses the image's native pixel
dimensions at 96 DPI. That is usually not what you want — pass at least
one dimension and let the other be derived by aspect ratio:

```python
pic = slide.shapes.add_picture("chart.png", Inches(1), Inches(1.5), width=Inches(11))
# height is now (11 / native_w) * native_h, aspect preserved
```

Resample large images before adding them:

```python
from PIL import Image
img = Image.open("photo.jpg")
img.thumbnail((1600, 1600))              # cap the longest side
img.save("photo_small.jpg", quality=88, optimize=True)
slide.shapes.add_picture("photo_small.jpg", Inches(1), Inches(1.5), width=Inches(11))
```

A 4000×3000 photo in a 720p slide bloats the file for zero visual benefit.

### Tables

```python
rows, cols = 4, 3
tbl = slide.shapes.add_table(rows, cols,
    Inches(1), Inches(1.5), Inches(11), Inches(4.5)).table

# header row
headers = ["Metric", "Q2", "Q3"]
for c, h in enumerate(headers):
    tbl.cell(0, c).text = h
    tbl.cell(0, c).text_frame.paragraphs[0].runs[0].font.bold = True

data = [
    ["Revenue", "$4.2M", "$5.6M"],
    ["Gross margin", "62%", "65%"],
    ["Headcount", "48", "51"],
]
for r, row in enumerate(data, start=1):
    for c, v in enumerate(row):
        tbl.cell(r, c).text = v
```

Column widths:

```python
tbl.columns[0].width = Inches(5)
tbl.columns[1].width = Inches(3)
tbl.columns[2].width = Inches(3)
```

### Charts

```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

data = CategoryChartData()
data.categories = ["Q1", "Q2", "Q3", "Q4"]
data.add_series("Revenue ($M)", (3.1, 3.9, 4.6, 5.4))

chart = slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    Inches(1), Inches(1.5), Inches(11), Inches(5.5),
    data
).chart

chart.has_title = True
chart.chart_title.text_frame.text = "Revenue by quarter"
chart.chart_title.text_frame.paragraphs[0].runs[0].font.size = Pt(20)
chart.has_legend = False
```

To style series colors (Office defaults look generic):

```python
from pptx.dml.color import RGBColor
series = chart.series[0]
fill = series.format.fill
fill.solid()
fill.fore_color.rgb = RGBColor(0x0D, 0x94, 0x88)
```

Supported chart types (subset that renders reliably across PowerPoint,
Keynote, LibreOffice):

| Enum member                    | Renders as              |
|--------------------------------|-------------------------|
| `COLUMN_CLUSTERED`             | vertical bars           |
| `BAR_CLUSTERED`                | horizontal bars         |
| `LINE`                         | line chart              |
| `LINE_MARKERS`                 | line + point markers    |
| `PIE`                          | pie                     |
| `DOUGHNUT`                     | donut                   |
| `XY_SCATTER`                   | scatter                 |
| `AREA` / `AREA_STACKED`        | area                    |

### Speaker notes

```python
notes_tf = slide.notes_slide.notes_text_frame
notes_tf.text = (
    "Open by acknowledging the miss on shipping notifications. "
    "Then pivot to the wins: three product launches, growth on flat headcount. "
    "Time to the last slide is roughly six minutes."
)
```

Notes support the same paragraph / run API as any text frame — bold, size,
color all work.

### Slide backgrounds

`python-pptx` does not expose slide background directly; use a full-slide
rectangle at the back z-order:

```python
bg = slide.shapes.add_shape(
    MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height
)
bg.fill.solid()
bg.fill.fore_color.rgb = RGBColor(0xF7, 0xF5, 0xF0)
bg.line.fill.background()

# push it to the back
spTree = bg._element.getparent()
spTree.remove(bg._element)
spTree.insert(2, bg._element)   # 2 skips the layout's nvGrpSpPr + grpSpPr
```

Or edit the master (see `edit.md` → *Editing slide masters*).

### Section dividers

Reuse layout 2 (`Section Header`), or clone a title slide and change the
title font to a section-appropriate style. Keeping section dividers on
their own layout means changing every divider is a single edit to the
master.

### Common pitfalls (python-pptx)

- **Reusing shape objects across slides** — `slide.shapes.add_shape(...)`
  returns a new shape. Do not stash the return and re-add to another slide
  — it copies the reference, not the object, and the second slide will
  render with a broken relationship.
- **`RGBColor` argument order** — hex nibbles as three integers. `RGBColor(0xFF, 0x00, 0x00)`
  is red; passing `"FF0000"` string raises `TypeError`.
- **Inches vs. EMU** — `Inches(1) == 914400 EMU`. Never pass raw integers
  to position/size fields unless you actually want EMU.
- **Charts without data** — `add_chart` requires at least one non-empty
  series, else PowerPoint errors on open. Placeholder chart? Give it a
  single `("", 0)` category.
- **Placeholder index depends on the layout.** `slide.placeholders[1]` is
  the subtitle on layout 0 but the *content* box on layout 1. Iterate:
  ```python
  for ph in slide.placeholders:
      print(ph.placeholder_format.idx, ph.name)
  ```

---

## PptxGenJS recipes

Install once (globally is easiest for CLI use):

```bash
npm install -g pptxgenjs
# for icon rasterization:
npm install -g react-icons react react-dom sharp
```

### Skeleton

```javascript
const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";          // 13.33" × 7.5" (16:9)
pres.author = "Your Name";
pres.title = "Q3 Product Review";

const slide = pres.addSlide();
slide.background = { color: "1F3A5F" };
slide.addText("Revenue grew 34% on 22% headcount", {
  x: 0.5, y: 3.0, w: 12.3, h: 1.5,
  fontSize: 40, bold: true, color: "FFFFFF", align: "left",
});

pres.writeFile({ fileName: "review.pptx" });
```

Available `pres.layout` values: `LAYOUT_16x9` (10 × 5.625), `LAYOUT_WIDE`
(13.333 × 7.5), `LAYOUT_16x10` (10 × 6.25), `LAYOUT_4x3` (10 × 7.5). Use
`LAYOUT_WIDE` for anything modern.

### Text

```javascript
// simple
slide.addText("Body copy", {
  x: 0.5, y: 1.5, w: 8, h: 1,
  fontSize: 18, color: "1F1F1F", align: "left", valign: "top",
  fontFace: "Calibri",
});

// rich text with mixed formatting
slide.addText([
  { text: "Growth: ", options: { bold: true } },
  { text: "34% YoY", options: { color: "0D9488" } },
  { text: " on flat headcount.", options: {} },
], { x: 0.5, y: 2.6, w: 12, h: 0.6, fontSize: 20 });

// multi-paragraph — each run with breakLine: true starts a new line
slide.addText([
  { text: "First point", options: { bullet: true, breakLine: true } },
  { text: "Second point", options: { bullet: true, breakLine: true } },
  { text: "Third point", options: { bullet: true } },
], { x: 0.5, y: 3.5, w: 12, h: 3, fontSize: 18 });
```

Never mix a hard-coded bullet glyph (`"• Item"`) with `bullet: true`. The
result is two bullets.

### Shapes

```javascript
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 0.5, w: 3, h: 1.5,
  fill: { color: "F7F5F0" },
  line: { color: "1F3A5F", width: 1 },
});

slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 0.5, y: 2.5, w: 3, h: 1.5,
  fill: { color: "FFFFFF" },
  line: { type: "none" },
  rectRadius: 0.1,
});

slide.addShape(pres.shapes.OVAL, {
  x: 4.5, y: 2.5, w: 1.2, h: 1.2,
  fill: { color: "0D9488" },
});
```

Colors are 6-character hex strings **without** a leading `#`. Never write
`#0D9488` or 8-character hex (`0D948880` to encode alpha) — both corrupt
the output. Use the dedicated `transparency` (0-100) property for opacity.

### Images

```javascript
// from disk
slide.addImage({ path: "chart.png",  x: 0.5, y: 1.5, w: 6, h: 4 });

// from URL (fetched at generate time — needs network)
slide.addImage({ path: "https://example.com/logo.png",
                 x: 12, y: 0.3, w: 1, h: 0.5 });

// from base64 (fastest, no I/O)
slide.addImage({ data: "image/png;base64,iVBORw0KGg...", x: 0.5, y: 1.5, w: 5, h: 3 });

// sized to fit inside a box, preserving aspect
slide.addImage({ path: "photo.jpg", x: 1, y: 1, sizing: { type: "contain", w: 6, h: 4 } });

// sized to cover a box, cropping if needed
slide.addImage({ path: "photo.jpg", x: 1, y: 1, sizing: { type: "cover",   w: 6, h: 4 } });
```

Formats that render everywhere: PNG, JPG, GIF. SVG works in modern
PowerPoint but not consistently in older LibreOffice — rasterize to PNG
if the deck has to survive every viewer.

### Icons (react-icons → PNG)

```javascript
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const { FaCheckCircle, FaChartLine } = require("react-icons/fa");

async function iconPng(Icon, color = "0D9488", pixelSize = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Icon, { color: "#" + color, size: String(pixelSize) })
  );
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}

// CommonJS has no top-level await — do async work inside a main() and
// call writeFile there too.
async function main() {
  const okData = await iconPng(FaCheckCircle, "0D9488", 256);
  slide.addImage({ data: okData, x: 0.5, y: 3, w: 0.5, h: 0.5 });
  await pres.writeFile({ fileName: "review.pptx" });
}
main();
```

`pixelSize` controls rasterization sharpness, not the on-slide display size.
Use 256 or higher; the on-slide size is `w`/`h` in inches.

### Charts

```javascript
slide.addChart(pres.charts.BAR, [{
  name: "Revenue",
  labels: ["Q1", "Q2", "Q3", "Q4"],
  values: [3.1, 3.9, 4.6, 5.4],
}], {
  x: 0.5, y: 1, w: 12, h: 5,
  barDir: "col",
  showTitle: true, title: "Revenue by quarter",
  chartColors: ["0D9488"],
  showLegend: false,
  catAxisLabelColor: "64748B",
  valAxisLabelColor: "64748B",
  valGridLine: { color: "E2E8F0", size: 0.5 },
  catGridLine: { style: "none" },
  showValue: true,
  dataLabelPosition: "outEnd",
});
```

Supported chart families: `BAR`, `LINE`, `PIE`, `DOUGHNUT`, `SCATTER`,
`BUBBLE`, `RADAR`, `AREA`.

### Tables

```javascript
slide.addTable([
  [
    { text: "Metric", options: { bold: true, fill: { color: "1F3A5F" }, color: "FFFFFF" } },
    { text: "Q2",     options: { bold: true, fill: { color: "1F3A5F" }, color: "FFFFFF" } },
    { text: "Q3",     options: { bold: true, fill: { color: "1F3A5F" }, color: "FFFFFF" } },
  ],
  ["Revenue",       "$4.2M", "$5.6M"],
  ["Gross margin",  "62%",   "65%"],
  ["Headcount",     "48",    "51"],
], {
  x: 0.5, y: 1.5, w: 12, colW: [6, 3, 3],
  fontSize: 14, border: { pt: 1, color: "E5E7EB" },
});
```

### Slide masters

Define once, apply repeatedly:

```javascript
pres.defineSlideMaster({
  title: "SECTION_DIVIDER",
  background: { color: "1F3A5F" },
  objects: [
    { placeholder: { options: { name: "title", type: "title",
                                x: 0.5, y: 3, w: 12.3, h: 1.5,
                                fontSize: 44, bold: true, color: "FFFFFF" },
                     text: "" } },
  ],
});

const s = pres.addSlide({ masterName: "SECTION_DIVIDER" });
s.addText("Part 2 — What's Next", { placeholder: "title" });
```

### PptxGenJS pitfalls (things that silently corrupt the file)

- **`#` prefix on hex colors** — `color: "#FF0000"` corrupts the file.
  Always use bare hex: `"FF0000"`.
- **8-character hex to fake alpha** — corrupts the file. Use the
  `transparency: 0-100` property on `fill`, or the `opacity: 0.0-1.0`
  property on shadow.
- **Reusing option objects across calls** — PptxGenJS mutates option
  objects in-place (converting inches to EMU, hex to Office xml). Sharing
  one `{ shadow: {...} }` between two calls corrupts the second call.
  Factory the object:
  ```javascript
  const makeShadow = () => ({ type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.15 });
  slide.addShape(pres.shapes.RECTANGLE, { x:1, y:1, w:3, h:2, fill:{color:"FFFFFF"}, shadow: makeShadow() });
  slide.addShape(pres.shapes.RECTANGLE, { x:5, y:1, w:3, h:2, fill:{color:"FFFFFF"}, shadow: makeShadow() });
  ```
- **Unicode bullet glyphs with `bullet: true`** — you get a double bullet.
  Pick one.
- **`rectRadius` on `RECTANGLE`** — ignored silently. Use
  `ROUNDED_RECTANGLE`.
- **Negative shadow `offset`** — corrupts the file. Cast the shadow upward
  with `angle: 270` and a **positive** offset.

---

## Palettes to steal

Generic corporate blue is a tell. Pick a palette that matches the topic
and commit to it — one dominant tone (60-70%), one supporting, one accent.

| Palette             | Primary   | Secondary | Accent    | Feels like            |
|---------------------|-----------|-----------|-----------|-----------------------|
| Deep navy           | `1F3A5F`  | `C8D3E6`  | `F3B23E`  | Executive / finance   |
| Forest              | `2C5F2D`  | `97BC62`  | `F5F5F5`  | Environment / land    |
| Terracotta          | `B85042`  | `E7E8D1`  | `A7BEAE`  | Editorial / consumer  |
| Cobalt & sand       | `12457A`  | `E9DFC7`  | `E97A5C`  | Design / product      |
| Charcoal minimal    | `1F1F1F`  | `F2F2F2`  | `E63946`  | Serious, minimal      |
| Teal / mint         | `0D9488`  | `5EEAD4`  | `1F1F1F`  | Modern SaaS           |
| Berry & cream       | `6D2E46`  | `A26769`  | `ECE2D0`  | Publishing / food     |
| Solar               | `F0A202`  | `1D3557`  | `F1FAEE`  | Optimistic tech       |

Two rules:

1. Never give all colors equal weight. The primary dominates; secondary
   fills the space; accent is used **sparingly** for the one thing that
   should catch the eye.
2. Dark backgrounds work great for title, transition, and closing slides —
   commit to dark or commit to light for the body slides, do not zig-zag.

## Typography pairings

Pair a header face with personality against a clean, boring body face:

| Header             | Body            | Feels like        |
|--------------------|------------------|-------------------|
| Calibri Light      | Calibri          | Default / safe    |
| Georgia            | Calibri          | Editorial         |
| Cambria            | Calibri          | Print / academic  |
| Segoe UI Semibold  | Segoe UI         | Product / SaaS    |
| Trebuchet MS       | Calibri          | Casual / warm     |
| Impact             | Arial            | Bold headline     |
| Palatino           | Garamond         | Long-form serif   |
| Consolas           | Calibri          | Technical         |

Sizes:

| Element         | Size    |
|-----------------|---------|
| Title           | 32-40pt |
| Section header  | 24-28pt |
| Body            | 18-22pt |
| Stat callout    | 60-96pt |
| Caption         | 10-12pt |

## After you generate

Always run the QA loop from `SKILL.md` — even three-slide decks fail QA
more often than you'd think. Assume something is wrong; find it.
