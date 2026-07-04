# pptx skill

Apache-2.0 licensed toolkit for producing, editing, and reading Microsoft
PowerPoint (`.pptx`) files with Claude. Written from scratch against the
public [ECMA-376 / ISO/IEC 29500](https://www.ecma-international.org/publications-and-standards/standards/ecma-376/)
specification of Office Open XML (PresentationML), so it can be embedded in
commercial products without special agreement.

## What's here

```
pptx/
├── SKILL.md         entry point and decision matrix
├── create.md        authoring a .pptx from scratch (python-pptx + PptxGenJS)
├── edit.md          template fill, slide surgery, raw XML edits, comments
├── read.md          text extraction, structure walk, metadata, contact sheets
├── LICENSE          Apache-2.0 + third-party attributions
└── scripts/
    ├── explode.py          .pptx → pretty-printed XML directory
    ├── assemble.py         XML directory → .pptx
    ├── dump_text.py        extract slide text (plain / markdown; stdlib-only)
    ├── render_pdf.py       render to PDF via LibreOffice for QA
    ├── render_slides.py    render each slide to PNG / JPG (PDF → poppler)
    ├── soffice_bridge.py   shared LibreOffice / poppler subprocess wrapper
    ├── contact_sheet.py    build a grid of slide thumbnails (Pillow)
    ├── insert_slide.py     clone a slide or spawn one from a layout
    ├── prune.py            reachability-based orphan-part cleanup
    └── diagnose.py         ZIP integrity, XML well-formedness, python-pptx load
```

Start with **SKILL.md** — it has the decision matrix that points you at the
right sub-guide.

## Quick start

Install once:

```bash
python3 -m pip install --upgrade python-pptx lxml Pillow
# For the from-scratch design workflow:
npm install -g pptxgenjs                 # optional; JS authoring surface
# Optional but useful for the QA loop:
brew install --cask libreoffice          # or: apt-get install libreoffice
brew install poppler                     # for pdftoppm (PDF → PNG)
```

Author a deck:

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[0])
slide.shapes.title.text = "Q3 Product Review"
slide.placeholders[1].text = "Growth, tradeoffs, what to do next"
prs.save("review.pptx")
```

Run the standard QA loop:

```bash
python scripts/diagnose.py       review.pptx           # opens cleanly?
python scripts/dump_text.py      review.pptx --notes   # what does it say?
python scripts/render_slides.py  review.pptx --out img/  # visual QA
```

## Design goals

1. **No proprietary dependencies.** All runtime dependencies are permissively
   licensed (`python-pptx` MIT, `lxml` BSD-3-Clause, `Pillow` MIT-CMU,
   `pptxgenjs` MIT). Optional external tools (LibreOffice, Poppler) are
   invoked as CLIs; nothing is bundled or statically linked.
2. **Standard library first where practical.** `dump_text.py`, `explode.py`,
   `assemble.py`, and `prune.py` work with only the standard library — lxml
   is a fast path, not a requirement.
3. **Small, self-contained scripts.** Each script has one job, a docstring
   with usage examples at the top, and a `main(argv)` entry point. No
   plugin systems, no shared framework code beyond the tiny
   `soffice_bridge.py` helper that abstracts the LibreOffice subprocess.
4. **Round-trippable.** `explode.py` + `assemble.py` produce byte-stable
   archives when the source tree is unchanged, so version control on
   exploded pptx trees stays sane.

## What this is not

- Not a full presentation renderer. Use LibreOffice, PowerPoint, or Keynote
  for that.
- Not an ECMA-376 schema validator. `diagnose.py` runs quick well-formedness
  checks and a `python-pptx` round-trip; it does not validate against the
  formal schemas.
- Not for `.ppt` (legacy PowerPoint 97-2003), `.pptm` (macro-enabled), or
  Keynote's `.key`. Convert to `.pptx` first with LibreOffice:
  `soffice --headless --convert-to pptx old.ppt`.

## Attribution

This skill is an independent implementation authored from scratch. Design
patterns come from the public [ECMA-376 / ISO/IEC 29500](https://www.ecma-international.org/publications-and-standards/standards/ecma-376/)
specification of Office Open XML (PresentationML) and the documentation of
the linked open-source libraries.

### Third-party components

When packaging this skill into a product, review the licenses of the tools
you actually ship:

  - `python-pptx` — MIT — https://github.com/scanny/python-pptx
  - `PptxGenJS`   — MIT — https://github.com/gitbrent/PptxGenJS
  - `lxml`        — BSD-3-Clause — https://lxml.de
  - `Pillow`      — MIT-CMU — https://python-pillow.org
  - `LibreOffice` / `soffice` — MPL 2.0 — invoked as an external binary; no linking
  - `Poppler` / `pdftoppm`    — GPL     — invoked as an external binary; no linking

The two external binaries (`soffice`, `pdftoppm`) are called via
`subprocess` — no code linking, no static or dynamic linkage. Their
copyleft terms apply only if you redistribute the binaries themselves.

## Contributing

The skill is meant to be forked and adapted. When you extend it:

- Keep each script self-contained (single file, doc-string usage at the top,
  no shared helpers imported from elsewhere in the repo except the small
  `soffice_bridge.py` shim). It should be safe to copy any one script into
  another project.
- Match the existing shape (`argparse`, `main(argv=None)`, numeric exit
  codes: `0` OK, `1` failure, `2` usage/IO).
- Test round-tripping (`explode → assemble → diagnose`) against any pptx
  you touch.
