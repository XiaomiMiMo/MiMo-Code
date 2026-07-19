# Editing a .pptx

Three workflows, listed by increasing invasiveness. Pick the least
invasive one that solves the task.

| Workflow | When to use |
|----------|-------------|
| **Template fill** — python-pptx, keep styling | You have a `.pptx` template and want to replace text / images while keeping the design |
| **Slide surgery** — reorder, add, delete slides | Structure changes but content per slide stays the same |
| **Raw XML** — explode → edit → assemble | Anything the python-pptx API doesn't expose: custom XML parts, uncommon shapes, deep master edits |

---

## Template fill

The most common editing task: someone hands you a `.pptx` with a designed
look and asks you to swap the content.

### Discover what's in the template

```bash
uv run scripts/contact_sheet.py template.pptx --cols 3
uv run scripts/dump_text.py template.pptx --notes --numbered > tpl.txt
```

Open `template.contact-sheet.jpg` next to `tpl.txt`. Now you can see the
visual layout of each slide alongside its text — that pairing is what you
need to decide "the section 2 divider is slide 4, the two-column team
slide is slide 7," etc.

### Fill via python-pptx

```python
from pptx import Presentation

prs = Presentation("template.pptx")

# Slides are ordered as they appear in the deck.
slide = prs.slides[0]
slide.shapes.title.text = "Q3 Product Review"                 # replace the title placeholder
slide.placeholders[1].text = "What shipped, what slipped"     # replace the subtitle

# Iterate the placeholders when you don't know the layout by heart:
for ph in slide.placeholders:
    print(ph.placeholder_format.idx, ph.name, "|", (ph.text or "")[:60])

prs.save("filled.pptx")
```

Rules of thumb:

- `shapes.title` is a shortcut for `placeholders[0]` on layouts that have
  one. On a blank layout (`slide_layouts[6]`) it returns `None`.
- Overwriting `.text` collapses all runs in the placeholder into one
  paragraph and one run. That destroys any bold, color, or font-size
  styling inside the placeholder. To preserve styling, replace at the run
  level:

  ```python
  for para in placeholder.text_frame.paragraphs:
      for run in para.runs:
          if "{{title}}" in run.text:
              run.text = run.text.replace("{{title}}", "Q3 Review")
  ```

- Placeholder text set via `.text` inherits the font from the layout —
  which is usually what you want. Set explicit `run.font.size` /
  `run.font.bold` only when you need to override the layout.

### Fill with double-mustache tokens

A robust convention: build the template with `{{title}}`, `{{stat}}`,
`{{point1}}` placeholders inside real placeholder shapes, then fill:

```python
from pptx import Presentation

FILLS = {
    "{{title}}": "Q3 Product Review",
    "{{subtitle}}": "Growth on flat headcount",
    "{{stat}}": "34%",
    "{{stat_label}}": "YoY revenue growth",
}

def replace_in_runs(paragraph, mapping):
    """Replace tokens while preserving each run's styling."""
    for run in paragraph.runs:
        for key, value in mapping.items():
            if key in run.text:
                run.text = run.text.replace(key, value)

prs = Presentation("template.pptx")
for slide in prs.slides:
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for para in shape.text_frame.paragraphs:
            replace_in_runs(para, FILLS)
prs.save("filled.pptx")
```

Tokens must live in a **single run** or the replacement misses them —
PowerPoint sometimes splits `{{title}}` across two runs when you edit the
template by hand. Fix this by re-typing the token from scratch inside
PowerPoint, or by joining runs before replacement:

```python
def joined_text(paragraph):
    return "".join(r.text for r in paragraph.runs)

def replace_and_rewrite(paragraph, mapping):
    text = joined_text(paragraph)
    for key, value in mapping.items():
        text = text.replace(key, value)
    if not paragraph.runs:
        return
    # keep the first run's styling; drop the rest
    for run in paragraph.runs[1:]:
        run._r.getparent().remove(run._r)
    paragraph.runs[0].text = text
```

### Fill images inside placeholders

Some templates have picture placeholders (`ph_type == PP_PLACEHOLDER.PICTURE`).
Replace them with:

```python
from pptx.util import Inches

for ph in slide.placeholders:
    if ph.placeholder_format.type != 18:      # PP_PLACEHOLDER.PICTURE
        continue
    ph.insert_picture("photo.png")            # keeps the placeholder's crop and position
```

If the template uses a plain image shape (not a picture placeholder),
delete the old shape and add a new one at the same position:

```python
old = None
for shape in slide.shapes:
    if shape.shape_type == 13 and shape.name == "hero_image":  # 13 = PICTURE
        old = shape
        break
if old is not None:
    left, top, width, height = old.left, old.top, old.width, old.height
    old._element.getparent().remove(old._element)
    slide.shapes.add_picture("photo.png", left, top, width, height)
```

### Delete unwanted content

Never leave a placeholder holding `{{project_name}}` or `Click to add
title` — a QA reviewer will spot it in five seconds. If a slide has more
slots than content, delete the slot entirely rather than clearing its
text:

```python
for shape in list(slide.shapes):
    if shape.has_text_frame and shape.text_frame.text.strip().startswith("{{unused"):
        shape._element.getparent().remove(shape._element)
```

---

## Slide surgery

### List / print slides

```python
from pptx import Presentation
prs = Presentation("input.pptx")
for i, s in enumerate(prs.slides):
    title = s.shapes.title.text if s.shapes.title else "(no title)"
    print(f"{i:2d}  layout={s.slide_layout.name!r:35s}  title={title!r}")
```

### Duplicate a slide

`python-pptx` doesn't ship a first-class `duplicate()`. Use the explode /
XML flow (see below), or use this recipe based on
[python-pptx issue #132](https://github.com/scanny/python-pptx/issues/132):

```python
import copy
from pptx import Presentation

def duplicate_slide(prs, index):
    """Duplicate the slide at `index` (0-based); returns the new Slide."""
    src = prs.slides[index]
    blank_layout = src.slide_layout
    new_slide = prs.slides.add_slide(blank_layout)

    # copy every shape from src to new_slide
    for shape in src.shapes:
        el = copy.deepcopy(shape.element)
        new_slide.shapes._spTree.insert_element_before(el, "p:extLst")

    # copy speaker notes
    if src.has_notes_slide:
        new_slide.notes_slide.notes_text_frame.text = (
            src.notes_slide.notes_text_frame.text
        )
    return new_slide

prs = Presentation("input.pptx")
duplicate_slide(prs, 3)      # duplicates slide index 3 to the end
prs.save("output.pptx")
```

For anything more than a shallow duplicate (charts, embedded objects,
custom XML), fall back to the explode workflow — the copy-shape trick
above doesn't re-wire relationships (`_rels/`) that a chart or embedded
media needs.

### Reorder slides

```python
from pptx import Presentation

def move_slide(prs, old_index, new_index):
    """Move slide `old_index` to `new_index` (both 0-based)."""
    xml_slides = prs.slides._sldIdLst
    slides = list(xml_slides)
    xml_slides.remove(slides[old_index])
    xml_slides.insert(new_index, slides[old_index])

prs = Presentation("input.pptx")
move_slide(prs, 5, 1)         # move slide 6 to position 2
prs.save("output.pptx")
```

### Delete slides

```python
from pptx import Presentation

def delete_slide(prs, index):
    slides = list(prs.slides._sldIdLst)
    prs.slides._sldIdLst.remove(slides[index])

prs = Presentation("input.pptx")
delete_slide(prs, 0)          # drops the title slide
prs.save("output.pptx")
```

Deleted slides survive as unreferenced XML parts in the ZIP. That
doesn't break rendering, but it inflates the file. Run
`scripts/prune.py` on the exploded tree to drop them (see next
section).

---

## Raw XML workflow

For anything the python-pptx API doesn't expose — custom shapes,
non-standard XML parts, deep master edits, or fixing files that don't
open cleanly.

### Explode

```bash
uv run scripts/explode.py input.pptx unpacked/
```

You get a directory tree like:

```
unpacked/
├── [Content_Types].xml
├── _rels/.rels
├── docProps/{app,core}.xml
├── ppt/
│   ├── presentation.xml
│   ├── _rels/presentation.xml.rels
│   ├── slides/
│   │   ├── slide1.xml
│   │   ├── slide2.xml
│   │   └── _rels/
│   │       ├── slide1.xml.rels
│   │       └── slide2.xml.rels
│   ├── slideLayouts/…
│   ├── slideMasters/…
│   ├── notesSlides/…
│   ├── theme/…
│   └── media/            (images, video, audio)
```

XML parts are pretty-printed. Non-XML parts (images, embedded fonts) are
copied byte-for-byte.

### Slide order lives in `ppt/presentation.xml`

Slide order is a list of `<p:sldId>` elements inside `<p:sldIdLst>`:

```xml
<p:sldIdLst>
  <p:sldId id="256" r:id="rId2"/>
  <p:sldId id="257" r:id="rId3"/>
  <p:sldId id="258" r:id="rId4"/>
</p:sldIdLst>
```

Each `r:id` points at a `<Relationship>` in `ppt/_rels/presentation.xml.rels`,
which in turn names the slide part (`slides/slide1.xml`, etc.).

- **Reorder**: rearrange `<p:sldId>` elements. The `id=` values must stay
  unique but do not need to be sequential.
- **Delete**: remove the `<p:sldId>` element. Run `prune.py`
  afterwards to also delete the slide part and its rels; otherwise the
  file just gets bigger while the deleted slide stays hidden.
- **Add**: use `insert_slide.py` (see below) — never manually copy
  `slide{n}.xml` files. Manual copying misses the `_rels` file, the
  `[Content_Types].xml` entry, and the notes back-reference.

### `insert_slide.py`

Two modes:

```bash
# Duplicate an existing slide (copies the slide XML and its rels; the
# notesSlide part is *shared* with the original, not copied)
uv run scripts/insert_slide.py unpacked/ --clone slide3.xml

# Build a new blank slide from a layout
uv run scripts/insert_slide.py unpacked/ --blank-from slideLayout5.xml
```

Both modes print the new slide's `<p:sldId>` element. Paste it into
`<p:sldIdLst>` at the position you want:

```
<p:sldId id="272" r:id="rId17"/>
```

The `id` and `rId` are guaranteed unique by the script.

### `prune.py`

```bash
uv run scripts/prune.py unpacked/
```

Drops any slide not referenced by `<p:sldIdLst>`, its `_rels/*.xml.rels`,
any orphaned notes slides, and any media files (`ppt/media/*`) not
referenced by a remaining rels file. Prints a summary of what was
removed.

Run this before `assemble.py` whenever you've done a delete or you're
touching a hand-edited exploded tree.

### Editing slide XML

Every slide is a self-contained XML file whose top-level element is
`<p:sld>`. Text lives inside runs (`<a:r>`) inside paragraphs (`<a:p>`)
inside text bodies (`<p:txBody>`) inside shape (`<p:sp>`) elements:

```xml
<p:sp>
  <p:nvSpPr>...</p:nvSpPr>
  <p:spPr>...</p:spPr>
  <p:txBody>
    <a:bodyPr wrap="square"/>
    <a:lstStyle/>
    <a:p>
      <a:pPr algn="l"/>
      <a:r>
        <a:rPr lang="en-US" sz="2800" b="1"/>
        <a:t>Revenue grew 34%</a:t>
      </a:r>
    </a:p>
  </p:txBody>
</p:sp>
```

To change the text, edit the `<a:t>` element. To bold it, add `b="1"` on
`<a:rPr>`. To make it 24pt, set `sz="2400"` (units are hundredths of a
point).

Rules:

- **Preserve whitespace on `<a:t>`** — leading/trailing spaces are
  stripped unless the element carries `xml:space="preserve"`.
- **Never concatenate multi-item content into one `<a:t>`.** Give each
  bullet or step its own `<a:p>` element with its own `<a:pPr>`.
- **Use XML entities for smart quotes and non-ASCII inside `<a:t>`** if
  your editor mangles UTF-8. `&#x201C;` for `“`, `&#x201D;` for `”`,
  `&#x2018;` / `&#x2019;` for single quotes.
- **Do not use `xml.etree` to write PresentationML.** It corrupts
  namespaces on write. Use `lxml.etree` or `defusedxml.minidom`.
- **Bullet formatting is inherited from the layout by default.** If you
  add a `<a:buChar>` or `<a:buNone>`, it overrides the layout — do so
  only when you actually mean to.

### Comments

PowerPoint comments live in `ppt/comments/` (modern format) or
`ppt/commentAuthors.xml` + per-slide `commentsN.xml` (legacy format).
`python-pptx` does not expose comments; edit the XML directly:

```xml
<!-- ppt/commentAuthors.xml -->
<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cmAuthor id="0" name="Reviewer" initials="RV" lastIdx="1" clrIdx="0"/>
</p:cmAuthorLst>
```

```xml
<!-- ppt/comments/comment1.xml -->
<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cm authorId="0" dt="2026-07-04T09:00:00Z" idx="1">
    <p:pos x="1000" y="1000"/>
    <p:text>Please double-check this metric.</p:text>
  </p:cm>
</p:cmLst>
```

Add matching entries in `[Content_Types].xml` and in the slide's rels
file. Comments are rendered by PowerPoint's review pane; they do not
appear on the slide surface.

### Reassemble

```bash
uv run scripts/assemble.py unpacked/ output.pptx
uv run scripts/diagnose.py output.pptx
```

`assemble.py` writes `[Content_Types].xml` first (matching PowerPoint's
convention), then all other parts in POSIX-sorted order. Two consecutive
assemblies of the same unmodified tree produce byte-identical archives.

---

## Editing slide masters

The slide master defines the theme colors, the master fonts, and the
default text placeholders that every layout (and thus every slide)
inherits from. Editing the master is the fastest way to re-theme an
entire deck.

Master XML lives at `ppt/slideMasters/slideMaster1.xml`. To change all
titles to a deep navy:

```xml
<!-- inside <p:txStyles><p:titleStyle><a:lvl1pPr>...</a:lvl1pPr> -->
<a:defRPr sz="4000" b="1">
  <a:solidFill>
    <a:srgbClr val="1F3A5F"/>
  </a:solidFill>
</a:defRPr>
```

Colors from a scheme are safer than hex-coded overrides — they let you
retheme by swapping the theme XML:

```xml
<a:defRPr sz="4000" b="1">
  <a:solidFill>
    <a:schemeClr val="accent1"/>
  </a:solidFill>
</a:defRPr>
```

The scheme colors themselves are in `ppt/theme/theme1.xml` under
`<a:clrScheme>`.

---

## Common editing pitfalls

- **Placeholder text lost after `.text =`** — assigning to `.text`
  collapses all runs. If the placeholder had a mix of bold + italic +
  colored text, all of that is gone. Fix by iterating `paragraphs[i].runs[j]`
  and replacing per-run.
- **Ghost slides in the ZIP** — deleting a `<p:sldId>` leaves the slide
  part behind. `prune.py` is not optional; run it.
- **Wrong content type after adding a comment or chart** — a new part
  must have a matching `<Override PartName="..." ContentType="..."/>` in
  `[Content_Types].xml`, or PowerPoint refuses to render it.
- **Editing XML with `xml.etree`** — corrupts default namespaces on
  write (`<a:p>` becomes `<ns0:p>`). Use `lxml.etree` (`etree.tostring(..., pretty_print=True, xml_declaration=True, encoding="UTF-8")`)
  or `defusedxml.minidom.parseString`.
- **Duplicating a chart slide with the copy-shape trick** — the shape
  element gets copied but its relationship to `chart{n}.xml` doesn't.
  The duplicated chart renders empty. For chart-bearing slides, use the
  explode workflow + `insert_slide.py --clone`.
- **Editing shapes that reference the master by ID** — a shape can
  inherit its placeholder position from the layout. If you set `left` /
  `top` on the layout's placeholder, every slide that hasn't overridden
  it moves. Verify with the visual QA render.

## After you edit

Always run the QA loop from `SKILL.md`:

```bash
uv run scripts/diagnose.py output.pptx
uv run scripts/dump_text.py output.pptx --notes | grep -Ei "\{\{|TODO|TBD|lorem|click to add"
uv run scripts/render_slides.py output.pptx --out qa/
```

Assume something is wrong. The most common failure is placeholder text
that survived template fill; grep is cheap, use it.
