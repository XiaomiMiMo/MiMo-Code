---
name: pdf-official
description: "Use this skill whenever a PDF file is being produced, opened, transformed, filled, or read. That includes: extracting text or tables from an existing PDF; combining, carving, rotating, cropping, or watermarking pages; composing a fresh PDF (report, invoice, certificate); filling AcroForm fields or overlaying text onto a non-fillable scanned form; encrypting or unlocking a PDF; running OCR over a scanned document; rendering pages to PNG/JPEG for visual analysis. Trigger on mentions of 'PDF', a filename ending in .pdf, requests like 'turn this into a PDF report', or references to AcroForm / form fields."
license: Apache-2.0 — see LICENSE for terms and third-party attributions
---

# PDF skill

An Apache-2.0 toolkit for reading, composing, transforming, and filling PDF
files. Written from scratch on top of permissively-licensed open-source
libraries (pypdf, pdfplumber, pypdfium2, reportlab, pdf-lib, qpdf) so this
can be embedded in commercial projects without special agreement.

## Route the task

Pick the sub-guide by the *verb* of the request.

| Task | Path | Read |
|------|------|------|
| Pull text / tables / metadata / images out of an existing PDF | Extract | [`extract.md`](extract.md) |
| Combine, carve, rotate, crop, watermark, encrypt, or shrink | Transform | [`transform.md`](transform.md) |
| Build a PDF that doesn't exist yet (report, invoice, certificate) | Compose | [`compose.md`](compose.md) |
| Fill a form (AcroForm or scanned) | Interactive | [`interactive.md`](interactive.md) |
| Scanned / image-only PDF (no selectable text) | Extract → *OCR* | [`extract.md`](extract.md) §5 |

If a task mixes several of these, follow the order:
**probe → plan → extract or compose → validate.**

Every path starts with a probe. `scripts/survey.py` returns page count,
whether the file is encrypted, whether it has an AcroForm, and whether
page 1 looks like a scan.

## First install

> **Bundled runtime:** when the `MIMO_PYTHON` environment variable is set, skip the installs below — run every command with `python3`/`uv run` replaced by `"$MIMO_PYTHON"` (pypdf/pypdfium2/reportlab/Pillow preinstalled; pip console scripts unavailable, use `"$MIMO_PYTHON" -m <module>`). A bundled qpdf is exposed as `MIMO_QPDF` (picked up automatically by the scripts here); invoke it directly as `"$MIMO_QPDF" --check file.pdf`.

Python-only path (all BSD / MIT / Apache) — covers 95% of tasks:

```bash
python3 -m pip install --upgrade pypdf pdfplumber pypdfium2 reportlab Pillow
```

Add these external binaries only when you actually need them:

```bash
# qpdf — merge/split/encrypt/repair, Apache-2.0
brew install qpdf                # macOS
apt-get install -y qpdf          # Debian / Ubuntu

# Tesseract — OCR for scanned PDFs, Apache-2.0
brew install tesseract
python3 -m pip install pytesseract pdf2image
apt-get install -y tesseract-ocr

# Poppler — pdftotext / pdftoppm / pdfimages, GPL-2.0
# Optional. Only install if you accept a GPL dependency at CLI level.
brew install poppler
apt-get install -y poppler-utils
```

Every script under `scripts/` uses argparse. Exit codes:
`0` OK · `1` runtime failure · `2` bad arguments · `3` validation failure
(`apply_values.py` / `overlay_text.py`; `sanity_check.py` reports findings
with exit `1`).
Any single script can be lifted into another project — none imports from a
shared framework.

## One-command triage

```bash
scripts/survey.py path/to/file.pdf --pretty
```

Sample output:

```json
{
  "path": "/abs/path/file.pdf",
  "page_count": 12,
  "is_locked": false,
  "form_field_count": 34,
  "looks_scanned": false,
  "metadata": {"Title": "...", "Author": "...", "Producer": "..."}
}
```

Route by the flags:

- `is_locked: true` → unlock first (`qpdf --password=… --decrypt`). Almost
  every reader library refuses locked files.
- `form_field_count > 0` → widgets path in [`interactive.md`](interactive.md) §1.
- `form_field_count == 0` AND you need to fill it → overlay path
  in [`interactive.md`](interactive.md) §2.
- `looks_scanned: true` → skip pypdf text extraction, go straight to OCR
  ([`extract.md`](extract.md) §5).

## Which library for which task

| Task | Preferred | Reason | Fallback |
|------|-----------|--------|----------|
| Plain text | `pdftotext -layout` | fastest, keeps columns | `pypdf` |
| Positioned text | `pdfplumber` | char-level bboxes | `pypdfium2.get_text` |
| Tables | `pdfplumber` | tunable `table_settings` | pandas over manual CSV |
| Page → image | `pypdfium2` | Apache/BSD, no GPL | `pdftoppm` (GPL) |
| Merge / carve / rotate | `pypdf` | pure Python | `qpdf --pages` (faster on huge files) |
| Encrypt / repair / linearise | `qpdf` | handles broken input | pypdf (basic encrypt only) |
| Compose from scratch | `reportlab` | mature, BSD | `pdf-lib` in Node |
| Fill AcroForm | `pypdf.update_page_form_field_values` | preserves widget appearances | `pdf-lib` in Node |
| Overlay on non-fillable | reportlab + `pypdf.merge_page` | two-layer merge, see interactive.md | — |

## Common gotchas

1. **PDF origin is bottom-left**, image origin is top-left. Every "off by a
   few points" bug is one of these two systems misapplied. Coordinate
   conversion is in one place: [`interactive.md`](interactive.md) §2.c.
2. **`pypdf.extract_text()` returns nothing for scans.** That's not a bug —
   there's no text stream. Use the `looks_scanned` flag and route to OCR.
3. **Unicode subscripts / superscripts render as black rectangles in
   reportlab** because Helvetica/Times/Courier don't ship those glyphs. Use
   `<sub>` / `<super>` XML in `Paragraph`, or move the pen manually on canvas.
   See [`compose.md`](compose.md) §5.
4. **XFA forms are not AcroForms.** If `probe_fields.py` returns `[]` on a
   PDF that clearly has widgets in Adobe Reader, it's XFA — flatten it in
   Acrobat first.
5. **`writer.encrypt(pw)` in pypdf uses RC4 by default**. For real AES-256,
   pass `algorithm="AES-256"`, or use `qpdf --encrypt … 256 --`.

## What's next

Open the sub-guide from the routing table and work through it end to end.
Each sub-guide has a Validation section at the bottom describing how to
confirm the result.
