# Creating a `.docx` From Scratch

Use `python-docx` when you are producing a document from prompt + data and there is no reference template. Everything below is standard, publicly documented API — nothing here relies on private extensions.

Install once:

```bash
python3 -m pip install --upgrade python-docx lxml
```

## Skeleton

Every generator you write follows the same shape:

```python
from docx import Document
from docx.shared import Pt, Cm, RGBColor

doc = Document()                     # blank document with default styles
setup_page(doc)                      # margins, orientation, size
add_cover(doc, title="Q3 Financial Review", subtitle="Prepared for the Board")
doc.add_page_break()
add_toc_placeholder(doc)             # optional
doc.add_page_break()
add_body(doc, sections=...)
add_appendix(doc, tables=...)
doc.save("report.docx")
```

Keep each `add_*` function small (< 40 lines). It is much easier to fix a broken heading style than to debug a 300-line monolith.

## Page setup

```python
from docx.shared import Cm
from docx.enum.section import WD_ORIENTATION

def setup_page(doc, size="A4"):
    section = doc.sections[0]
    if size == "A4":
        section.page_width, section.page_height = Cm(21.0), Cm(29.7)
        section.top_margin = section.bottom_margin = Cm(2.54)
        section.left_margin = section.right_margin = Cm(3.18)
    else:                                     # Letter
        from docx.shared import Inches
        section.page_width, section.page_height = Inches(8.5), Inches(11.0)
        section.top_margin = section.bottom_margin = Inches(1.0)
        section.left_margin = section.right_margin = Inches(1.25)
    section.orientation = WD_ORIENTATION.PORTRAIT
```

`sections` is a list — a document can have multiple sections with different orientations (e.g. a landscape appendix). Add one with `doc.add_section(WD_SECTION.NEW_PAGE)`.

## Named styles (the important part)

Word's usefulness — Navigation Pane, ToC, cross-references, screen readers — all depend on paragraphs having the right **style name**. Assign styles by name, do not fake headings with bold text.

```python
title    = doc.add_paragraph("Q3 Financial Review", style="Title")
h1       = doc.add_paragraph("Executive Summary", style="Heading 1")
h2       = doc.add_paragraph("Key drivers", style="Heading 2")
body     = doc.add_paragraph("Revenue grew 12% year-over-year …", style="Normal")
quote    = doc.add_paragraph("Momentum is real.", style="Quote")
caption  = doc.add_paragraph("Figure 1 — quarterly revenue", style="Caption")
```

Built-in style names that always exist: `Normal`, `Title`, `Subtitle`, `Heading 1` … `Heading 9`, `List Bullet`, `List Number`, `Quote`, `Intense Quote`, `Caption`.

### Tweaking a built-in style

```python
from docx.shared import Pt, RGBColor

def tune_styles(doc):
    body = doc.styles["Normal"]
    body.font.name = "Calibri"
    body.font.size = Pt(11)
    body.paragraph_format.line_spacing = 1.15
    body.paragraph_format.space_after = Pt(6)

    for n, size in [(1, 18), (2, 14), (3, 12)]:
        s = doc.styles[f"Heading {n}"]
        s.font.name = "Calibri Light"
        s.font.size = Pt(size)
        s.font.bold = True
        s.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)
        s.paragraph_format.space_before = Pt(14 - 2 * n)
        s.paragraph_format.space_after = Pt(4)
```

Call `tune_styles(doc)` once, right after `Document()`.

## Runs — mixed formatting inside one paragraph

A paragraph is a list of *runs*. Each run has its own formatting. Do not create a new paragraph for a bold word.

```python
p = doc.add_paragraph()
p.add_run("Revenue: ").bold = True
p.add_run("$4.2M ")
r = p.add_run("(+12% YoY)"); r.italic = True; r.font.color.rgb = RGBColor(0x2E, 0x7D, 0x32)
```

## Lists

Use the built-in `List Bullet` / `List Number` styles — do NOT prefix `-` or `1.` characters into the paragraph text.

```python
for item in ["Product line growth", "Cost discipline", "Favorable FX"]:
    doc.add_paragraph(item, style="List Bullet")

for i, step in enumerate(["Review inputs", "Rebalance ledger", "Publish"], 1):
    doc.add_paragraph(step, style="List Number")
```

Nested lists: use `List Bullet 2`, `List Bullet 3` (or `List Number 2` etc.). Depth beyond 3 is usually a signal to switch to headings.

## Tables

```python
def add_table(doc, header, rows):
    table = doc.add_table(rows=1 + len(rows), cols=len(header))
    table.style = "Light Grid Accent 1"     # any style Word ships with

    hdr = table.rows[0].cells
    for i, name in enumerate(header):
        hdr[i].text = name
        # Bold the header cells:
        for p in hdr[i].paragraphs:
            for r in p.runs:
                r.bold = True

    for r_idx, row in enumerate(rows, start=1):
        cells = table.rows[r_idx].cells
        for c_idx, value in enumerate(row):
            cells[c_idx].text = str(value)
```

Rules of thumb:

- **Set `table.style` before adding data**, then the borders paint automatically.
- **Numbers align right**, text left. Set alignment on the paragraph inside the cell, not the cell itself:
  ```python
  from docx.enum.text import WD_ALIGN_PARAGRAPH
  cells[c_idx].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
  ```
- **Never leave a cell empty** — insert a non-breaking space (` `) or a dash, otherwise Word can collapse the row height and the borders look broken.
- For merged headers use `cell.merge(other_cell)`.

## Images

```python
from docx.shared import Cm

doc.add_picture("chart.png", width=Cm(15))       # height auto-computes to preserve ratio
last_paragraph = doc.paragraphs[-1]
last_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_paragraph("Figure 1 — quarterly revenue", style="Caption")
```

Always add a caption paragraph directly beneath the image; readers can cross-reference "Figure 1" that way.

**Alt text** (accessibility, sometimes required by legal review):

```python
import docx
from docx.oxml.ns import qn

def set_alt_text(picture_shape, description):
    inline = picture_shape._inline
    docPr = inline.find(qn("wp:docPr"))
    docPr.set("descr", description)
    docPr.set("title", description[:80])
```

## Headers, footers, page numbers

```python
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def add_page_number(paragraph):
    run = paragraph.add_run()
    fldChar1 = OxmlElement("w:fldChar"); fldChar1.set(qn("w:fldCharType"), "begin")
    instrText = OxmlElement("w:instrText"); instrText.text = "PAGE"
    fldChar2 = OxmlElement("w:fldChar"); fldChar2.set(qn("w:fldCharType"), "end")
    run._r.append(fldChar1); run._r.append(instrText); run._r.append(fldChar2)

section = doc.sections[0]
footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
add_page_number(footer)

header = section.header.paragraphs[0]
header.text = "Q3 Financial Review — Confidential"
header.style = doc.styles["Header"]
```

**Different first-page header?** Set `section.different_first_page_header_footer = True` and edit `section.first_page_header` separately. Same idea for `.even_page_header` when `settings.evenAndOddHeaders` is on.

## Table of contents

Word builds the ToC from headings the moment a user opens the file — but only if a ToC field is present. Insert the field, then leave a placeholder for Word to fill in:

```python
def add_toc(doc):
    p = doc.add_paragraph()
    run = p.add_run()
    fldChar1 = OxmlElement("w:fldChar"); fldChar1.set(qn("w:fldCharType"), "begin")
    instrText = OxmlElement("w:instrText")
    instrText.set(qn("xml:space"), "preserve")
    instrText.text = 'TOC \\o "1-3" \\h \\z \\u'          # levels 1–3, hyperlinked
    fldChar2 = OxmlElement("w:fldChar"); fldChar2.set(qn("w:fldCharType"), "separate")
    fldChar3 = OxmlElement("w:t"); fldChar3.text = "Right-click and choose Update Field."
    fldChar4 = OxmlElement("w:fldChar"); fldChar4.set(qn("w:fldCharType"), "end")
    for x in (fldChar1, instrText, fldChar2, fldChar3, fldChar4):
        run._r.append(x)
```

On the first open in Word the user (or Word itself, if `settings.xml` has `w:updateFields`) will populate the entries.

## Cross-references and bookmarks

To reference "see Section 3.1" and have it update as sections shift:

```python
def bookmark(paragraph, name):
    start = OxmlElement("w:bookmarkStart"); start.set(qn("w:id"), "0"); start.set(qn("w:name"), name)
    end   = OxmlElement("w:bookmarkEnd"); end.set(qn("w:id"), "0")
    paragraph._p.insert(0, start); paragraph._p.append(end)

def ref(paragraph, name):
    run = paragraph.add_run()
    for tag, attr in [("fldChar", ("w:fldCharType", "begin")),
                      ("instrText", None),
                      ("fldChar", ("w:fldCharType", "end"))]:
        el = OxmlElement(f"w:{tag}")
        if attr: el.set(qn(attr[0]), attr[1])
        if tag == "instrText": el.text = f" REF {name} \\h "
        run._r.append(el)
```

## Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Navigation Pane empty | Headings styled as `Normal` with bold text | Assign `Heading 1/2/3` style. |
| ToC shows only "TOC" | Field never updated in Word | Add `w:updateFields` in `settings.xml` or ask user to F9 in Word. |
| Every paragraph inherits italics | You changed a run's font, then reused the same run object | Create a new run per paragraph. |
| Table borders vanish on save | You cleared `table.style` after populating cells | Set `table.style` **before** populating; don't reassign later. |
| Image renders huge | Only `width` or `height` supplied ≥ page width | Compute `Cm(15)` (roughly page-content width) and let the other axis auto-scale. |
| File opens with "content had problems" | Manually inserted XML with unbalanced tags | Reopen the exploded directory, run `xmllint --noout word/document.xml`, fix the offending element. |
| "Missing font" warning on open (Cambria, Calibri, CJK fonts) | `python-docx` default template embeds font references in theme XML that may not be installed | Patch the theme after `Document()` — see recipe below. |
| Chinese / non-ASCII text renders as `??` in some viewers | Font run has no East-Asian font | Set both the ASCII and East-Asian typefaces: `run.font.name = "Calibri"; run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "Microsoft YaHei")` — the `get_or_add_*` form is safe when the run has no `rPr`/`rFonts` yet; setting only `run.font.name` leaves CJK on the default font. Use a CJK-capable font for the `w:eastAsia` value. |

## Recipes

### Cover page

```python
def add_cover(doc, title, subtitle=None, author=None, date=None):
    for _ in range(6):
        doc.add_paragraph()                       # push content down the page
    p = doc.add_paragraph(title, style="Title")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if subtitle:
        p = doc.add_paragraph(subtitle, style="Subtitle")
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for _ in range(10):
        doc.add_paragraph()
    if author or date:
        line = " · ".join(x for x in (author, date) if x)
        p = doc.add_paragraph(line)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
```

### Two-column layout for a single section

```python
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

new_section = doc.add_section(WD_SECTION.CONTINUOUS)
sectPr = new_section._sectPr
cols = sectPr.find(qn("w:cols"))
if cols is None:
    cols = OxmlElement("w:cols")
    sectPr.append(cols)
cols.set(qn("w:num"), "2"); cols.set(qn("w:space"), "425")   # 425 twips ≈ 0.3 in
# … add paragraphs …
doc.add_section(WD_SECTION.CONTINUOUS)             # revert to single column
```

### Callout box (shaded paragraph)

```python
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

def shade_paragraph(paragraph, hex_color="F2F4F7"):
    pPr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    pPr.append(shd)

p = doc.add_paragraph("Note: figures are unaudited.")
shade_paragraph(p, "FFF4CE")
```

### Patch default theme fonts (suppress "missing font" warnings)

`Document()` ships with a theme referencing Cambria, Calibri, and CJK fallback fonts (MS Gothic, MS Mincho) that may not exist on the target system. Viewers warn about them even when every run has an explicit font. Patch the theme right after creation:

```python
from lxml import etree

doc = Document()

# --- patch theme font definitions ---
theme_rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
theme_part = doc.part.part_related_by(theme_rel)
theme_xml = etree.fromstring(theme_part.blob)

ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
for latin in theme_xml.xpath("//a:majorFont/a:latin | //a:minorFont/a:latin", namespaces=ns):
    latin.set("typeface", "Times New Roman")       # or your preferred Latin font
for font in theme_xml.xpath("//a:majorFont/a:font | //a:minorFont/a:font", namespaces=ns):
    if font.get("script", "") in ("Hans", "Hant", "Jpan", "Hang"):
        font.set("typeface", "SimSun")             # or your preferred CJK font

theme_part._blob = etree.tostring(theme_xml, xml_declaration=True, encoding="UTF-8", standalone=True)

# --- patch Courier → Courier New in macro styles ---
for style in doc.styles:
    if hasattr(style, "font") and style.font.name == "Courier":
        style.font.name = "Courier New"
```

Call this once, immediately after `Document()`, before adding content. Choose fonts you know exist on your target audience's systems. For CJK documents the most portable choices are SimSun / 宋体 (Chinese), MS Mincho (Japanese), or Malgun Gothic (Korean).

## Testing your generator

Every generator should be runnable and produce a file with **exactly one call**:

```bash
python your_generator.py --out out/report.docx --data data.json
```

Then run the four QA steps from `SKILL.md` — the ones you must never skip:

```bash
uv run python -c "import docx; docx.Document('out/report.docx')"
uv run scripts/extract_text.py out/report.docx | grep -Ei "TODO|TBD|\{\{"
uv run scripts/render_pdf.py out/report.docx
```

If the import check raises or the grep matches anything, treat it as a build
failure and fix before shipping. (`render_pdf.py` prints the produced PDF
path on success — inspect that PDF visually.)
