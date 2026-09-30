# Reading a `.docx`

Three levels of read, ordered by how much structure you preserve:

| You want… | Use | Fidelity |
|-----------|-----|----------|
| Plain text for search, summarization, LLM input | `scripts/extract_text.py` | Text only. No tables, no formatting. |
| Structural walk (headings, tables, images, styles) | `python-docx` iteration | High. Everything the object model exposes. |
| Byte-for-byte inspection of what Word will render | `scripts/explode.py` | Complete — every XML element. |

Always start with the cheapest option that answers the question. If a user asks "what does this contract say about payment terms?", plain text is enough.

## Level 1 — plain text

```bash
uv run scripts/extract_text.py input.docx                # body text to stdout
uv run scripts/extract_text.py input.docx --out file.txt # write to a file
uv run scripts/extract_text.py input.docx --all          # include headers, footers, footnotes, endnotes, comments
```

Output goes to stdout by default. Redirect where you need it.

The extractor walks OOXML directly (no `python-docx` dependency), so it runs in any environment where the standard library is available. Table cells appear as separate paragraphs in reading order — good for search, less good for tabular analysis. When you need structured rows, use Level 2.

**Caveat**: plain-text extraction discards run formatting, styles, and images. Footnotes, headers, and comments are excluded unless you pass `--all`.

## Level 2 — structural walk with `python-docx`

The API mirrors the document tree closely; iterate what you need.

### List every heading (for outlining or ToC checking)

```python
from docx import Document

doc = Document("report.docx")
for p in doc.paragraphs:
    if p.style.name.startswith("Heading"):
        depth = int(p.style.name.split()[-1])
        print("  " * (depth - 1), p.text)
```

### Extract every table as a list of lists

```python
for i, table in enumerate(doc.tables):
    print(f"--- Table {i} ---")
    for row in table.rows:
        print([cell.text.strip() for cell in row.cells])
```

Cells can contain multiple paragraphs (`cell.paragraphs`). If a cell spans a merged region, its `.text` is repeated across all merged cells — deduplicate by tracking `cell._tc` identity if you need the true structure.

### Pull out every image with its position

```python
from docx.oxml.ns import qn

for i, section in enumerate(doc.sections):
    pass  # sections carry the page setup; not needed for image extraction

for rel in doc.part.rels.values():
    if "image" in rel.reltype:
        blob = rel.target_part.blob
        ext = rel.target_ref.split(".")[-1]
        with open(f"image_{rel.rId}.{ext}", "wb") as f:
            f.write(blob)
        print(rel.rId, rel.target_ref, len(blob), "bytes")
```

To find where each image sits inline: iterate `doc.element.iter(qn("w:drawing"))` and look up the parent `<w:p>`. The relationship ID is in `wp:docPr` or `a:blip r:embed`.

### Metadata (author, title, revision, dates)

```python
props = doc.core_properties
print("title:",   props.title)
print("author:",  props.author)
print("modified:", props.modified)      # datetime
print("revision:", props.revision)
print("keywords:", props.keywords)
print("subject:", props.subject)
print("category:", props.category)
```

`app.xml` also carries `pages`, `words`, `characters`, `template`, `application` — accessible via `doc.part.package.parts` by URI `docProps/app.xml`.

### Comments, footnotes, endnotes

Each lives in its own part. See `edit.md` → *Reading existing comments* for the walk pattern. Footnotes replace `w:footnoteReference` in the body; join by ID.

### Detecting tracked changes

```python
from docx.oxml.ns import qn

insertions = doc.element.findall(f".//{qn('w:ins')}")
deletions  = doc.element.findall(f".//{qn('w:del')}")
print(f"{len(insertions)} pending insertions, {len(deletions)} pending deletions")
```

If either is non-zero, tell the user the document has unaccepted changes before you extract text — otherwise the deleted text appears as if it's still there.

## Level 3 — raw XML inspection

When the structure walk misses something (custom XML parts, SDT / structured document tags, complex field switches):

```bash
uv run scripts/explode.py input.docx exploded/
xmllint --format exploded/word/document.xml | less
```

Search for the element you care about:

```bash
grep -n "w:sdt" exploded/word/document.xml
grep -n "w:instrText" exploded/word/document.xml       # every field code
grep -rn "customXml" exploded/                          # find custom XML parts
```

### Field codes

Field codes drive dynamic content (dates, page numbers, cross-refs, mail merges, ToCs). They look like:

```xml
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> DATE \@ "yyyy-MM-dd" </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:t>2026-07-04</w:t></w:r>        <!-- cached value; may be stale -->
<w:r><w:fldChar w:fldCharType="end"/></w:r>
```

The `w:t` between `separate` and `end` is the cached last-render. If the user reports "wrong date shown", the value cached there differs from what the field would compute — Word will refresh on `F9`.

### Numbering

Bullet and numbered lists point at `numbering.xml`:

```xml
<w:p>
  <w:pPr>
    <w:numPr>
      <w:ilvl w:val="0"/>       <!-- indent level -->
      <w:numId w:val="3"/>       <!-- points into numbering.xml -->
    </w:numPr>
  </w:pPr>
  <w:r><w:t>First bullet</w:t></w:r>
</w:p>
```

To reproduce numbering exactly when regenerating, keep the original `numbering.xml` intact instead of building your own list styles.

## Recipes

### "Summarize this file"

```bash
uv run scripts/extract_text.py --all report.docx > report.txt
```

Then feed `report.txt` to your LLM. If you need heading structure preserved for the summary, iterate `python-docx` and emit your own Markdown — see the outlining snippet above.

### "Find every place this contract mentions 'liability'"

```python
import re
from docx import Document
doc = Document("contract.docx")
for i, p in enumerate(doc.paragraphs):
    if re.search(r"\bliabilit", p.text, re.I):
        section = "unknown"
        for prev in doc.paragraphs[max(0, i-20):i]:
            if prev.style.name.startswith("Heading"):
                section = prev.text
        print(f"[{section}] {p.text.strip()}")
```

### "Verify this template has the placeholders my code expects"

```python
import re
from docx import Document
EXPECTED = {"client", "date", "amount", "contact_email"}
doc = Document("template.docx")
found = set()
tokens = re.compile(r"\{\{\s*(\w+)\s*\}\}")
for p in doc.paragraphs:
    found.update(tokens.findall(p.text))
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            found.update(tokens.findall(cell.text))
missing = EXPECTED - found
extra   = found - EXPECTED
print("missing:", missing)
print("extra:",   extra)
```

Run this before every batch merge — catches typos in placeholder names that would otherwise silently leave literal `{{amount}}` in the shipped document.

## Encoding gotchas

- Documents in East Asian languages set two fonts per run (`w:rFonts w:ascii="…" w:eastAsia="…"`). Text extraction is unaffected, but if you regenerate the document with a Latin-only font the East Asian characters render as `?` in some viewers.
- Smart quotes come out as U+2018/U+2019/U+201C/U+201D. If you'll feed the text to a downstream system that mishandles Unicode, normalize with `unicodedata.normalize("NFKC", text)` and/or a simple `translate()` map.
- `` (vertical tab) inside a paragraph is a **line break within a paragraph** (`<w:br/>`), not a paragraph break. When splitting text into lines, split on both `\n` and `\v`.
