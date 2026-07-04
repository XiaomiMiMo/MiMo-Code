# Editing an Existing `.docx`

Two workflows, pick the one that matches the change:

| Scope of change | Workflow | Trade-off |
|-----------------|----------|-----------|
| Fill placeholders / swap paragraphs / add sections | **`python-docx` in-place edit** | Preserves every existing style, image, header, and revision-history block. Safe default. |
| Bulk XML restructuring, splicing content from another file, custom OOXML elements | **Explode → edit XML → assemble** | More power, more ways to break the file. Use only when the API path won't do. |

Both share the same golden rule: **never overwrite the original file until the new one has passed QA.** Write to `output.docx`, verify, then rename.

## Workflow A — `python-docx` in-place edit

### Load and inspect first

```python
from docx import Document
doc = Document("template.docx")

for i, p in enumerate(doc.paragraphs):
    print(i, repr(p.style.name), p.text[:80])
```

You want to know exactly which paragraph indexes carry each placeholder before editing anything. Print the list, decide what to change, then edit.

### Placeholder replacement (safe pattern)

`python-docx` splits a paragraph into runs, and a placeholder like `{{name}}` can end up split across several runs — so a naive `paragraph.text = paragraph.text.replace(...)` **loses all formatting**. Use this pattern instead:

```python
import re

PLACEHOLDER = re.compile(r"\{\{\s*(\w+)\s*\}\}")

def substitute(paragraph, mapping):
    """Replace {{key}} tokens across split runs, preserving the first run's format."""
    text = "".join(r.text for r in paragraph.runs)
    if not PLACEHOLDER.search(text):
        return
    new_text = PLACEHOLDER.sub(lambda m: str(mapping.get(m.group(1), m.group(0))), text)
    first = paragraph.runs[0]
    for r in paragraph.runs[1:]:
        r.text = ""
    first.text = new_text
```

Then walk the document:

```python
mapping = {"client": "Acme Corp", "date": "2026-07-04", "amount": "$120,000"}

for p in doc.paragraphs:
    substitute(p, mapping)

for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            for p in cell.paragraphs:
                substitute(p, mapping)

# Headers/footers live under sections:
for section in doc.sections:
    for container in (section.header, section.footer,
                      section.first_page_header, section.first_page_footer):
        for p in container.paragraphs:
            substitute(p, mapping)
```

**Never** try to run `re.sub` on `doc.element.xml` — you'll corrupt the smart quotes, the RSID markers, and any preserved-space attributes.

### Inserting new paragraphs at a specific place

`python-docx` only exposes `doc.add_paragraph()` (append to end). To insert *after* an existing paragraph, use the internal element helper:

```python
from copy import deepcopy
from docx.oxml.ns import qn

def insert_paragraph_after(paragraph, text="", style=None):
    new_p = deepcopy(paragraph._p)                # copy formatting scaffolding
    for r in new_p.findall(qn("w:r")):
        new_p.remove(r)                           # blank out the text
    paragraph._p.addnext(new_p)
    from docx.text.paragraph import Paragraph
    new_paragraph = Paragraph(new_p, paragraph._parent)
    if style:
        new_paragraph.style = style
    if text:
        new_paragraph.add_run(text)
    return new_paragraph
```

### Deleting a paragraph

```python
def delete_paragraph(paragraph):
    element = paragraph._element
    element.getparent().remove(element)
    paragraph._p = paragraph._element = None
```

Delete iterating **backwards** if you're removing multiple in one pass, so indexes don't shift under you.

### Repeating a template block (rows or paragraphs)

For a table row template:

```python
from copy import deepcopy

template_row = table.rows[1]                       # row index 1 is the template
for record in records:
    new_row = deepcopy(template_row._tr)
    table._tbl.append(new_row)
    row = table.rows[-1]
    for cell, key in zip(row.cells, ("name", "role", "email")):
        cell.text = str(record[key])               # replaces the cell's text
table._tbl.remove(template_row._tr)                # remove the leftover template row
```

`cell.text = ...` resets the cell to a single plain run. If the template cell
carries formatting you need to keep, run the `substitute()` helper over
`cell.paragraphs` instead of overwriting.

## Workflow B — Explode → edit XML → assemble

Use only when Workflow A cannot express the change (e.g. rewriting a `w:sdt` structured document tag, editing custom XML parts, splicing two documents together preserving numbering IDs).

```bash
python scripts/explode.py template.docx exploded/
# … edit exploded/word/document.xml (or others) …
python scripts/assemble.py exploded/ output.docx --sanity
```

`explode.py` pretty-prints every XML file so diffs are readable. `assemble.py` writes parts in the order declared by `[Content_Types].xml` with fixed mtimes, so a reassemble of an unchanged tree produces a byte-identical archive. Pass `--sanity` to run the required-parts and ZIP-integrity probes after writing.

### File map of an exploded `.docx`

```
exploded/
├── [Content_Types].xml       ← MIME types for each part; touch only when adding new part types
├── _rels/.rels               ← top-level relationships (points to word/document.xml)
├── docProps/
│   ├── app.xml               ← application metadata (page count, template name)
│   └── core.xml              ← author, title, revision, dates — safe to edit
├── word/
│   ├── document.xml          ← the body — 95% of edits happen here
│   ├── styles.xml            ← named-style definitions
│   ├── numbering.xml         ← list numbering formats (only present if lists are used)
│   ├── settings.xml          ← Word settings (updateFields, evenAndOddHeaders, …)
│   ├── header1.xml, footer1.xml, …
│   ├── comments.xml, endnotes.xml, footnotes.xml
│   ├── media/                ← all embedded images
│   ├── theme/theme1.xml      ← font/color theme
│   └── _rels/                ← per-part relationship files
```

### Rules when editing XML by hand

1. **Preserve the XML declaration.** Every part must start with `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`.
2. **Namespace prefixes are load-bearing.** `w:`, `r:`, `wp:`, `a:`, `pic:` — all defined on the root `<w:document>` (or the equivalent root). Do not strip them or the file fails to open.
3. **`xml:space="preserve"`** on every `<w:t>` element that contains leading/trailing whitespace or is inside a preserved-space run. When in doubt, add it.
4. **Every paragraph is `<w:p>`** with an optional `<w:pPr>` (properties) and one or more `<w:r>` (runs). A stray closing tag imbalance corrupts the entire body.
5. **Relationship IDs** (`w:rId="rId42"`) inside `document.xml` **must exist** in `_rels/document.xml.rels`. When you insert an image, add both a media file *and* a matching `<Relationship Id="rId..." Type=".../image" Target="media/…"/>`.
6. **Character references** are safer than raw Unicode when hand-editing:
   `&#x2019;` = `’`, `&#x201C;` = `“`, `&#x201D;` = `”`, `&#x2026;` = `…`.

### Minimal paragraph replacement in raw XML

Find:

```xml
<w:p>
  <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
  <w:r><w:t>{{summary}}</w:t></w:r>
</w:p>
```

Replace with:

```xml
<w:p>
  <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
  <w:r>
    <w:rPr><w:b/></w:rPr>
    <w:t xml:space="preserve">Summary: </w:t>
  </w:r>
  <w:r>
    <w:t>Revenue rose 12% YoY.</w:t>
  </w:r>
</w:p>
```

Reassemble, then run the QA loop.

## Comments and tracked changes

Comments and revision marks live in separate XML parts. Three modes:

### Adding a new comment

Use the bundled script against an exploded directory:

```bash
python scripts/explode.py template.docx exploded/
python scripts/annotate.py exploded/ "Please double-check this figure." \
    --author "Reviewer" --anchor '$4.2M'
python scripts/assemble.py exploded/ commented.docx
```

`annotate.py` wires up all three files that OOXML requires (`comments.xml`, the `.rels` entry, `[Content_Types].xml`) and inserts the anchor markers into `document.xml`. If the anchor string isn't found, it prints an XML snippet to paste in by hand.

### Reading existing comments

```python
from docx import Document
doc = Document("reviewed.docx")

part = doc.part.related_parts
comments = None
for rel_id, rel in doc.part.rels.items():
    if rel.reltype.endswith("/comments"):
        comments = rel.target_part
        break

if comments is not None:
    for el in comments.element.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}comment"):
        author = el.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}author")
        text = "".join(t.text or "" for t in el.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"))
        print(author, "→", text)
```

### Accepting all tracked changes programmatically

Use the bundled script — it walks the OOXML directly with `lxml` and needs no LibreOffice round-trip:

```bash
python scripts/resolve_revisions.py reviewed.docx clean.docx
```

Semantics: `<w:ins>` blocks are unwrapped (their content stays), `<w:del>` blocks are removed, formatting-change markers (`w:rPrChange`, `w:pPrChange`, …) are stripped, and paragraphs whose pilcrow is marked deleted are merged with the following paragraph — the same rules Word's *Accept All* applies.

If you'd rather bounce through LibreOffice (e.g. to also collapse orphaned bookmarks), open-and-resave:

```bash
soffice --headless --convert-to docx --outdir out/ reviewed.docx
```

## When Word refuses to open the file

Word's error dialog rarely tells you what's wrong. Diagnose:

```bash
python -c "
import zipfile, xml.etree.ElementTree as ET
with zipfile.ZipFile('broken.docx') as z:
    for name in z.namelist():
        if name.endswith('.xml') or name.endswith('.rels'):
            try:
                ET.fromstring(z.read(name))
            except ET.ParseError as e:
                print(name, e)
"
```

Nine times out of ten, the culprit is an unbalanced `<w:r>` or a missing namespace declaration in a hand-edited XML part.

## Anti-patterns

- **Don't run `sed` on `document.xml`.** Line-based tools mangle multi-line elements and quiet-succeed with garbage.
- **Don't `copy.deepcopy(doc)`.** `python-docx` objects share XML trees with the underlying `Document`; deep copies drift and corrupt. If you need two variants, save-and-reload.
- **Don't reassign `paragraph.text`** when the paragraph carries formatting. Use the `substitute()` helper above.
- **Don't rely on paragraph index across edits.** Insertion shifts indexes; capture references to the specific paragraph objects you'll touch before you start mutating.
- **Don't leave orphan runs** (empty `<w:r>` with no `<w:t>`) — they render as invisible glyphs that can push a page break.
