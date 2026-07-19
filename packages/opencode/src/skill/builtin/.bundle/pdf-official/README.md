# pdf skill

Apache-2.0 toolkit for reading, composing, transforming, and filling PDF
files. Built on top of permissively-licensed open-source libraries so the
guides and scripts can be embedded in commercial products without special
agreement.

## Layout

```
pdf/
├── SKILL.md            entry point + routing matrix
├── extract.md          pull text, tables, metadata, images out of a PDF
├── compose.md          author a fresh PDF (reportlab, canvas + Platypus)
├── transform.md        combine, carve, rotate, crop, watermark, encrypt
├── interactive.md      fill AcroForm widgets or stamp text onto scans
├── LICENSE             Apache-2.0 + third-party attributions
└── scripts/
    ├── survey.py           metadata + counts + form / scan hints (JSON out)
    ├── text_dump.py         extract text (poppler or pypdf; auto-fallback)
    ├── render_pages.py      rasterise pages via pypdfium2 (no GPL)
    ├── combine.py           append PDFs, optional --preserve-metadata
    ├── carve.py             split by range / per page / fixed chunk
    ├── reorient.py          rotate selected pages
    ├── recognize.py         Tesseract OCR wrapper, optional --parallel
    ├── sanity_check.py      graduated OK/INFO/WARN/ERROR check list
    ├── probe_fields.py      list AcroForm widgets OR dump page skeleton
    ├── apply_values.py      fill AcroForm from values.json (validated)
    └── overlay_text.py      stamp text/checks onto a non-fillable PDF
```

Start with `SKILL.md` — it has the routing matrix that points you at the
right sub-guide.

## Quick start

Install the permissive Python-only path:

```bash
python3 -m pip install --upgrade pypdf pdfplumber pypdfium2 reportlab Pillow
```

Add OCR and CLI helpers on demand:

```bash
# macOS
brew install qpdf tesseract poppler
# Debian / Ubuntu
apt-get install -y qpdf tesseract-ocr poppler-utils
```

Skim any document in three commands:

```bash
scripts/survey.py contract.pdf --pretty      # metadata, page count, form
scripts/text_dump.py contract.pdf > out.txt   # plain text
scripts/render_pages.py contract.pdf pages/   # PNG per page for inspection
```

Combine three quarterly reports and encrypt:

```bash
scripts/combine.py 2026Q1.pdf 2026Q2.pdf 2026Q3.pdf --out annual.pdf
qpdf --encrypt reader owner 256 --print=full -- annual.pdf annual-locked.pdf
```

## Design goals

1. **Permissive default.** Runtime Python deps are BSD / MIT / Apache. qpdf
   and Tesseract are Apache-2.0. Poppler (GPL) is optional — the skill runs
   end to end without it.
2. **Single-file scripts.** Every script under `scripts/` is one file with a
   docstring at the top and a `_main(argv)` entry point. Any one script can
   be copied into another project without touching the rest.
3. **Explicit coordinate systems.** PDF points (y up from bottom) for
   authoring; image pixels (y down from top) for visual analysis. The
   conversion lives in one place (`interactive.md` §2.c).
4. **Show the library call first, wrapper second.** Every guide demonstrates
   the underlying pypdf/reportlab/pypdfium2 call before the CLI wrapper, so
   readers can swap in their own script.

## What this is not

- Not a pixel-perfect renderer — use a browser, `pdftoppm`, or `pypdfium2`
  directly for that.
- Not a schema validator. `scripts/sanity_check.py` is an "opens + round-trips
  cleanly" check, not conformance to ISO 32000.
- Not an XFA form filler. pypdf only handles AcroForm; XFA-only files must
  be flattened first.

## Attribution

Independent implementation. Design patterns come from public documentation
of the linked open-source libraries and the ISO 32000 PDF specification.

Third-party license attributions for every runtime dependency (pypdf,
pdfplumber, pypdfium2, reportlab, pdf-lib, pdfjs-dist, qpdf, Tesseract,
poppler-utils, ImageMagick) are enumerated in [`LICENSE`](LICENSE). If you
are packaging this skill into a product, that section is what your legal
review should check — especially the notes on the optional poppler-utils
(GPL-2.0) and ImageMagick paths.

## Contributing

- Keep each script single-file with argparse + a `_main(argv)` entry.
- Prefer the Python-only path (no poppler, no ImageMagick) when both work.
- New capabilities go in the matching sub-guide (`extract`, `compose`,
  `transform`, or `interactive`) with a runnable example before the wrapper.
- Exit codes: `0` OK, `1` runtime failure, `2` bad usage, `3` validation
  failure.
