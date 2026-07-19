# docx skill

Apache-2.0 licensed toolkit for producing, editing, and reading Microsoft Word
(`.docx`) files with Claude. Written from scratch against the public
[ECMA-376 / ISO/IEC 29500](https://www.ecma-international.org/publications-and-standards/standards/ecma-376/)
specification of Office Open XML, so it can be embedded in commercial products
without special agreement.

## What's here

```
docx/
├── SKILL.md         entry point and decision matrix
├── create.md        authoring a .docx from scratch (python-docx recipes)
├── edit.md          template fill, XML surgery, tracked changes, comments
├── read.md          text extraction, structural walk, metadata
├── LICENSE          Apache-2.0 + third-party attributions
└── scripts/
    ├── explode.py            .docx → pretty-printed XML directory
    ├── assemble.py           XML directory → .docx
    ├── extract_text.py       extract plain text (stdlib fallback if lxml absent)
    ├── render_pdf.py         render to PDF via LibreOffice for QA
    ├── transcode.py          doc→docx, docx→pdf, docx→png via LibreOffice
    ├── audit.py              report-style well-formedness probes
    ├── resolve_revisions.py  accept every tracked change without Word/LibreOffice
    └── annotate.py           add a review comment (comments.xml + rels wired up)
```

Start with **SKILL.md** — it has the decision matrix that points you at the
right sub-guide.

## Quick start

All scripts include [PEP 723](https://peps.python.org/pep-0723/) inline metadata, so
`uv run` resolves dependencies automatically:

```bash
uv run scripts/audit.py report.docx           # opens cleanly?
uv run scripts/extract_text.py report.docx    # what does it actually say?
uv run scripts/render_pdf.py report.docx      # visual sanity check
```

If you don't use `uv`, install dependencies once:

```bash
python3 -m pip install --upgrade python-docx lxml
# Optional but useful for the QA loop:
brew install --cask libreoffice           # or: apt-get install libreoffice
brew install poppler                       # for pdftoppm (PDF → PNG)
```

Author a document:

```python
from docx import Document
doc = Document()
doc.add_heading("Q3 Financial Review", 0)
doc.add_paragraph("Revenue rose 12% YoY.")
doc.save("report.docx")
```

Run the standard QA loop:

```bash
uv run scripts/audit.py report.docx           # opens cleanly?
uv run scripts/extract_text.py report.docx            # what does it actually say?
uv run scripts/render_pdf.py report.docx             # visual sanity check
```

## Design goals

1. **No proprietary dependencies.** All runtime dependencies are permissively
   licensed (`python-docx` MIT, `lxml` BSD-3-Clause). Optional external tools
   (LibreOffice, Poppler) are invoked as CLIs; nothing is bundled or linked.
2. **Standard library first.** Scripts fall back to `xml.etree` and `zipfile`
   where practical, so text extraction and packing work in restricted
   environments that don't have `python-docx` installed.
3. **Small, self-contained scripts.** Each script has one job, a docstring
   with usage examples at the top, and a `main(argv)` entry point you can
   inspect at a glance. No plugin systems, no shared framework code.
4. **Round-trippable.** `explode.py` + `assemble.py` produce byte-for-byte stable
   archives when the source tree is unchanged, so version control on exploded
   docx trees stays sane.

## What this is not

- Not a full document renderer. Use LibreOffice, Word, or Pandoc for that.
- Not an ECMA-376 schema validator. `audit.py` runs quick well-formedness
  checks and a `python-docx` round-trip; it does not validate against the
  formal schemas.
- Not for `.doc` (legacy Word 97-2003), `.docm` (macro-enabled), or `.rtf`.
  Convert to `.docx` first with LibreOffice: `soffice --headless --convert-to docx file.doc`.

## Attribution

This skill is an independent implementation. Design patterns and API usage
come from public documentation of Office Open XML (ECMA-376 / ISO/IEC 29500)
and the linked open-source libraries. No third-party proprietary code is
included.

## Third-party licenses

This skill only bundles Apache-2.0 licensed code of its own. The runtime and
optional tools it calls out to have their own licenses, which you must
comply with when redistributing a product that ships (or auto-installs) any
of them:

| Component | License | Redistribution notes |
|-----------|---------|----------------------|
| python-docx | MIT | permissive — attribution suffices |
| lxml | BSD-3-Clause | permissive — attribution suffices |
| docx-js (Node) | MIT | permissive — attribution suffices |
| Pandoc | GPL | invoked as a separate binary; static linking or bundling triggers GPL obligations |
| LibreOffice / soffice | MPL 2.0 | invoked as a separate binary; source-availability applies to any MPL files you modify |
| Poppler (`pdftoppm`) | GPL | invoked as a separate binary; same caveats as Pandoc |

If your product ships as a self-contained bundle that includes the GPL/MPL
binaries, review the corresponding license before release.

## Contributing

The skill is meant to be forked and adapted. When you extend it:

- Keep each script self-contained (single file, doc-string usage at the top,
  no shared helpers imported from elsewhere in the repo). It should be safe
  to copy any one script into another project.
- Match the existing docstring style and CLI shape (`argparse`, `main(argv)`,
  numeric exit codes: `0` OK, `1` failure, `2` usage/IO).
- Test round-tripping (explode → assemble → inspect) against any docx you touch.
