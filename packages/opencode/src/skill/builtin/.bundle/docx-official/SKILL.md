---
name: docx-official
description: "Use this skill whenever a Microsoft Word (.docx) file is being produced, opened, transformed, or read. That includes: drafting reports, letters, contracts, RFPs, technical documents, or any long-form written deliverable; extracting text or structure from an existing Word file; filling a Word template with values; converting Word to PDF or plain text; splitting or merging documents; inspecting styles, headings, sections, tables, images, comments, or tracked changes. Trigger on mentions of 'Word doc', 'DOCX', 'Office document', a filename ending in .docx, or requests like 'turn this into a Word report'."
license: Apache-2.0 — see LICENSE for terms and third-party attributions
---

# DOCX Skill

An Apache-2.0 toolkit for producing, editing, and reading Microsoft Word (`.docx`) files. Written from scratch against the public [ECMA-376 / ISO/IEC 29500](https://www.ecma-international.org/publications-and-standards/standards/ecma-376/) specification and built on permissively-licensed tooling (`python-docx` MIT, `lxml` BSD-3-Clause, optional external binaries `pandoc` and `soffice`) so it can be reused in commercial projects without restriction.

## Decision matrix

| Situation | Path | Read first |
|-----------|------|------------|
| No source file — build a document from a prompt / data | Author from scratch with `python-docx` | [`create.md`](create.md) |
| You have a `.docx` template to fill in or lightly modify | Placeholder replacement via `python-docx`, keeps styles | [`edit.md`](edit.md) → *Workflow A — `python-docx` in-place edit* |
| Deep structural edits, new sections, custom XML, unusual layouts | Explode → edit XML → assemble | [`edit.md`](edit.md) → *Workflow B — Explode → edit XML → assemble* |
| You only need the text / structure / metadata out of a `.docx` | Extraction pipeline | [`read.md`](read.md) |
| Need a PDF preview for QA | `scripts/render_pdf.py` via LibreOffice | see *QA* below |

If the task mixes several of these, do them in this order: **read → plan → edit/create → validate**.

## One-time environment setup

All scripts include [PEP 723](https://peps.python.org/pep-0723/) inline metadata, so `uv run` resolves dependencies automatically — no manual install step needed. Just run:

```bash
uv run scripts/extract_text.py input.docx
```

If you don't use `uv`, install dependencies once:

```bash
python3 -m pip install --upgrade python-docx lxml
# Optional but recommended:
#   LibreOffice (for docx → pdf preview):   brew install --cask libreoffice   (macOS)
#                                           apt-get install -y libreoffice    (Debian/Ubuntu)
#   Poppler   (for pdf → image, QA loop):   brew install poppler
```

Alternatively, if this skill lives in a persistent workspace you can `uv init` a project, `uv add python-docx lxml`, and run scripts with `uv run scripts/...` from the project root — this gives you a lockfile and reproducible environment.

All scripts here use the standard library plus `python-docx`. No proprietary dependencies.

## Common commands

```bash
# 1. Extract plain text (best for "what does this file say?" questions)
uv run scripts/extract_text.py input.docx > input.txt

# 2. Explode a .docx into readable XML for structural surgery
uv run scripts/explode.py input.docx exploded/

# 3. Assemble an exploded directory into a fresh .docx
uv run scripts/assemble.py exploded/ output.docx

# 4. Render a .docx as PDF (used for visual QA)
uv run scripts/render_pdf.py output.docx           # writes output.pdf next to it

# 5. Well-formedness check (ZIP integrity + parseable XML + python-docx open)
uv run scripts/audit.py output.docx

# 6. Accept every tracked change without needing Word/LibreOffice
uv run scripts/resolve_revisions.py reviewed.docx clean.docx

# 7. Add a comment to an exploded directory
uv run scripts/annotate.py exploded/ "Please check" --author "Reviewer" --anchor "text"
```

Every script is a small, self-contained Python file. Read the top of the file for full CLI options.

## Authoring principles

Word is a **flowing** document format, not a slide surface. Users expect it to look like something a human wrote in Word — not a design tool trying to reinvent typography. Keep that in mind:

1. **Rely on named styles.** Use `Heading 1`, `Heading 2`, `Normal`, `Title`, `Quote`, `List Bullet`, `List Number`, `Caption`. They are what makes Word's ToC, navigation pane, and cross-references work.
2. **One idea per paragraph.** Long paragraphs are fine; run-on paragraphs are not. Break at logical boundaries.
3. **Structure first, prose second.** Draft the heading tree, then write inside it. Reviewers scan headings before words.
4. **Tables for tabular data only.** Do not use tables to fake multi-column layouts — export to PDF and users see the borders through the layout.
5. **Line length is set by page margins, not by hard breaks.** Never insert manual line breaks to control wrapping.
6. **Use fields, not literal text, for things that change** — page numbers, dates, ToC, cross-references. `python-docx` supports field codes via low-level XML (see `edit.md`).
7. **Every image needs alt text** — accessibility, and Word screams at you in review mode when it's missing.

## Typography defaults (safe starting point)

| Element        | Font          | Size | Weight | Notes |
|----------------|---------------|------|--------|-------|
| Title          | Calibri Light | 28pt | Bold   | Centered or left, one line |
| Heading 1      | Calibri Light | 18pt | Bold   | Space before 12pt |
| Heading 2      | Calibri Light | 14pt | Bold   | Space before 10pt |
| Heading 3      | Calibri       | 12pt | Bold   | Space before 6pt |
| Body           | Calibri       | 11pt | Regular| Line spacing 1.15, space after 6pt |
| Caption        | Calibri       | 9pt  | Italic | Muted gray `#595959` |
| Code / mono    | Consolas      | 10pt | Regular| Left-aligned, no first-line indent |

Change the palette for the topic — muted navy `#1F3A5F` for legal/finance, warm charcoal `#2E2A26` for editorial. Avoid pure `#000000` for body text; `#1F1F1F` reads softer on print.

## Page setup (A4 vs Letter)

Ask the user which one to use. If you cannot ask, default to the region implied by the language (Chinese/European → A4, US English → Letter). Margins:

| Size   | Width × Height    | Standard margins (T/B/L/R) |
|--------|-------------------|-----------------------------|
| A4     | 21.0 × 29.7 cm    | 2.54 / 2.54 / 3.18 / 3.18 cm |
| Letter | 8.5 × 11.0 in     | 1.00 / 1.00 / 1.25 / 1.25 in |

## QA checklist — always run before declaring done

**Assume something is wrong.** Word files fail silently: a broken relationship, an unclosed `<w:p>`, a missing style — Word will still open the file but strip content or throw a "content had problems" warning. Verify explicitly.

1. **Open cleanly** — no repair prompt.
   ```bash
   uv run python -c "import docx; docx.Document('output.docx')"   # loads without exceptions
   ```
2. **Text integrity** — no placeholder residue.
   ```bash
   uv run scripts/extract_text.py output.docx | grep -Ei "TODO|TBD|\{\{|lorem|xxxx"
   ```
   Grep must return nothing.
3. **Visual sanity** — render a PDF, open the first and last pages, scan for:
   - Widowed headings alone at the bottom of a page.
   - Tables split awkwardly across pages.
   - Images pushed to their own page because they exceeded content width.
   - Missing page numbers, wrong header/footer content.
   ```bash
   uv run scripts/render_pdf.py output.docx
   ```
4. **Style hygiene** — every heading uses a real style, not just bold+large text:
   ```bash
   uv run python -c "
   import docx; d = docx.Document('output.docx')
   for p in d.paragraphs:
       if p.text and p.style.name == 'Normal' and p.runs and p.runs[0].bold:
           print('possible fake heading:', p.text[:80])"
   ```

If any of these fail, fix and re-run — don't paper over.

## What is out of scope

- **`.doc` (legacy Word 97-2003)** — this skill only targets `.docx` (Office Open XML). Convert `.doc` to `.docx` with LibreOffice first: `soffice --headless --convert-to docx old.doc`.
- **Live collaborative editing** — the Word online API is a separate concern; here we produce and modify files.
- **Macros / VBA** — do not generate `.docm` files. If the user asks for automation, offer a Python script that regenerates the doc instead.

## Where each detail lives

- **Creating from scratch**: [`create.md`](create.md) — headings, paragraphs, styles, tables, images, page setup, headers/footers, tables of contents.
- **Editing / templating**: [`edit.md`](edit.md) — placeholder replacement, section swap, raw XML surgery, tracked changes, comments.
- **Reading / extracting**: [`read.md`](read.md) — plain-text export, structural walk, metadata, table extraction.
- **Scripts**: [`scripts/`](scripts/) — self-contained CLI utilities used by all of the above.
