---
name: xlsx-official
description: "Spreadsheet toolkit. Reach for it whenever the artifact on either side of the conversation is a workbook file — .xlsx, .xlsm, .xltx, .csv, .tsv — and the user wants that artifact produced, changed, cleaned, or read. Typical triggers: 'build me a model', 'update this sheet', 'add a column', 'compute the totals as formulas', 'sanity-check this xlsx', 'export sheet 2 to CSV', 'render the workbook as PDF', 'the spreadsheet in ~/Downloads is a mess, fix it'. Applies equally to financial models, ops reports, data cleanups, and template fills. Skip it when the workbook is only source material and the real output is a Word doc, an HTML page, a Python script that runs standalone, a Google Sheets integration, or an ingestion pipeline into a database — in those cases the spreadsheet is a means, not the deliverable."
license: Apache-2.0 — see LICENSE for terms and third-party attributions
---

# XLSX Skill

An Apache-2.0 toolkit for producing, editing, and reading Microsoft Excel
(`.xlsx`) files. Written from scratch against the public
[ECMA-376 / ISO/IEC 29500 (SpreadsheetML)](https://www.ecma-international.org/publications-and-standards/standards/ecma-376/)
specification and built on permissively-licensed tooling
(`openpyxl` MIT, `pandas` BSD-3-Clause, `lxml` BSD-3-Clause,
optional `xlsxwriter` BSD-2-Clause, optional external binary `soffice`
MPL 2.0) so it can be reused in commercial projects without restriction.

## Decision matrix

| Situation | Path | Read first |
|-----------|------|------------|
| Build a workbook from a prompt / dataframe / raw values | Author with `openpyxl` (formulas + formatting) or `pandas` (bulk data) | [`create.md`](create.md) |
| Edit an existing `.xlsx` — add rows, patch cells, refresh formulas | Load with `openpyxl`, preserve formulas & styles | [`edit.md`](edit.md) |
| Only need to read the data out (analysis, ETL, quick QA) | `pandas.read_excel` + `openpyxl` for structural inspection | [`read.md`](read.md) |
| Clean, aggregate, or transform tabular data before writing back | pandas pipeline, then hand back to openpyxl for final polish | [`analyze.md`](analyze.md) |
| Deep structural edits (custom XML parts, defined names, VBA-free surgery) | Unpack → edit XML → repack | [`edit.md`](edit.md) → *Raw XML workflow* |
| Recompute formula values before shipping | `scripts/bake.py` via LibreOffice | see *QA* below |

If the task mixes several of these, do them in this order:
**read → plan → edit/create → recalc → validate.**

## One-time environment setup

> **Bundled runtime:** when the `MIMO_PYTHON` environment variable is set, skip the pip installs below — run every command with `python3`/`uv run` replaced by `"$MIMO_PYTHON"` (e.g. `"$MIMO_PYTHON" scripts/overview.py book.xlsx`). openpyxl/pandas/lxml/xlsxwriter are preinstalled in that interpreter; pip console scripts are unavailable, so always go through `"$MIMO_PYTHON" -m <module>`. A bundled LibreOffice (for `bake.py`/`pdf_out.py`) is exposed as `MIMO_SOFFICE` and picked up automatically.

```bash
python3 -m pip install --upgrade openpyxl pandas lxml
# Optional but recommended:
python3 -m pip install --upgrade xlsxwriter
# For formula recalc and PDF export:
#   macOS       brew install --cask libreoffice
#   Debian/Ubuntu apt-get install -y libreoffice
```

Every script under `scripts/` uses only the standard library plus `openpyxl`
and `pandas`. No proprietary dependencies.

## Common commands

```bash
# 1. Describe a workbook (sheets, dimensions, formula count, sample rows)
python scripts/overview.py input.xlsx

# 2. Recalculate every formula, then flag any residual #REF! / #DIV/0! / etc.
python scripts/bake.py output.xlsx               # default 30s LibreOffice timeout
python scripts/bake.py output.xlsx --timeout 60  # custom timeout

# 3. Validate ZIP integrity, XML well-formedness, and openpyxl load
python scripts/audit.py output.xlsx

# 4. Convert to CSV (one file per sheet, or a single sheet by name/index)
python scripts/csv_out.py input.xlsx out_dir/           # all sheets
python scripts/csv_out.py input.xlsx out.csv --sheet 0  # first sheet

# 5. Convert to PDF for visual QA (needs LibreOffice)
python scripts/pdf_out.py output.xlsx           # writes output.pdf next to it

# 6. Unpack an .xlsx into readable XML parts (for surgical edits)
python scripts/explode.py input.xlsx unpacked/

# 7. Repack an unpacked directory into a fresh .xlsx
python scripts/assemble.py unpacked/ output.xlsx
```

Every script is a small, self-contained Python file. Read the top of the file
for full CLI options.

## Authoring principles

Excel is a **live calculation surface**, not a static table renderer. Users
open workbooks and expect to change numbers, watch the rest update, and trust
what they see. Keep that in mind:

1. **Use formulas, not hardcoded values.** Compute totals with `=SUM(...)`, not
   with a Python `sum()` written into the cell. When source data changes, the
   workbook must recompute itself.
2. **Put assumptions in dedicated input cells.** Reference them from formulas
   (`=B5*(1+$B$6)`), never inline (`=B5*1.05`). This is the single biggest
   determinant of whether a model is usable.
3. **One sheet per idea.** Inputs on one sheet, calculations on another, output
   on a third. Cross-sheet references (`Inputs!B5`) make dependencies explicit.
4. **Named styles beat ad-hoc formatting.** For anything reused (headers,
   totals, inputs, error markers), register a `NamedStyle` once and reapply.
5. **Freeze headers.** `sheet.freeze_panes = "A2"` (or `"B2"` if the first
   column is a row label) — every scrolling table needs this.
6. **Format numbers per column, in one pass.** Apply `cell.number_format` in a
   loop over the data range of each column (`for row in ws.iter_rows(min_col=3, max_col=3): ...`).
   Note: `column_dimensions['C'].number_format` does **not** reliably format
   cells you write afterwards — openpyxl-written cells carry their own style.
7. **Never rely on openpyxl to evaluate formulas.** It stores the string
   `"=SUM(...)"` and a cached previous value (if the file was opened before).
   Freshly written formulas have no cached value until LibreOffice or Excel
   recomputes.

## Number-format cheatsheet

| Kind | Format string | Renders |
|------|---------------|---------|
| Plain integer with thousands | `#,##0` | `1,234` |
| Currency (USD, hide zeros)   | `$#,##0;($#,##0);"-"` | `$1,234` / `($1,234)` / `-` |
| Currency (2 dp)              | `$#,##0.00`           | `$1,234.56` |
| Percentage (1 dp)            | `0.0%`                | `12.3%` |
| Multiplier                   | `0.00"x"`             | `1.35x` |
| Year as text                 | `0`                   | `2026` (no comma) |
| Short date                   | `yyyy-mm-dd`          | `2026-07-04` |
| Long date                    | `dddd, mmmm d, yyyy`  | `Saturday, July 4, 2026` |
| Scientific                   | `0.00E+00`            | `1.23E+04` |

Use parentheses for negatives in financial contexts; use a leading minus for
scientific or engineering contexts.

## Color and style conventions

There is no universal standard, but if the user does not specify one, this
palette is safe for internal financial or operational models:

| Purpose                | Value             | Rationale |
|------------------------|-------------------|-----------|
| Header text            | `#1F1F1F` on `#F2F2F2` fill | High contrast, print-safe |
| Input (user changes)   | Blue `#0033CC`    | Visually distinct from formulas |
| Formula (calculated)   | Black `#1F1F1F`   | Default reading color |
| Same-workbook link     | Green `#116611`   | "Comes from elsewhere in this file" |
| Cross-file link        | Red `#B22222`     | "Fragile — points outside this file" |
| Assumption to review   | `#FFF2CC` fill    | Yellow highlight, still readable in b/w |
| Error / warning        | `#FFC7CE` fill, `#9C0006` text | Excel's built-in "bad" style |

Override these whenever the file has an existing template — match it exactly.

## QA checklist — always run before declaring done

**Assume something is wrong.** Excel opens broken files quietly: a stray
`#REF!`, an off-by-one range, a formula that quietly evaluates to `0`. Verify
explicitly.

1. **Recalculate formulas.** openpyxl does not evaluate them — LibreOffice does.
   ```bash
   python scripts/bake.py output.xlsx
   ```
   Read the JSON output. `status: "clean"` with `error_count: 0` is the
   only acceptable result.

2. **Structural validation.**
   ```bash
   python scripts/audit.py output.xlsx
   ```
   Confirms the ZIP is well-formed, all XML parts parse, and openpyxl can
   round-trip the file.

3. **Spot-check the values.** Load with `data_only=True` after recalculation
   and read the cells you expect to be non-zero:
   ```python
   from openpyxl import load_workbook
   wb = load_workbook('output.xlsx', data_only=True)
   assert wb['Summary']['B10'].value == expected_total
   ```

4. **Visual sanity.** Render a PDF and scan the first and last sheets for:
   - Columns clipped because widths were left at default.
   - Numbers displayed as `########` (column too narrow for the format).
   - Formulas showing as text (missing leading `=`, or a leading apostrophe).
   - Headers repeated per page, print area set for large sheets.
   ```bash
   python scripts/pdf_out.py output.xlsx
   ```

If any of these fail, fix and re-run. Do not paper over.

## Common formula pitfalls

- **`#DIV/0!`** — wrap divisions defensively: `=IF(B2=0,0,A2/B2)` or
  `=IFERROR(A2/B2, 0)`. Prefer `IF` so real zeros stay visible; use `IFERROR`
  only for values that must always be numeric.
- **`#REF!`** — a cell reference points to a deleted row/column. Rebuild the
  formula against current coordinates; do not just delete the offending cell.
- **`#VALUE!`** — text where a number is expected, usually from a stray label
  in a data column. Check the column dtype in pandas before writing.
- **`#NAME?`** — the formula uses a function name Excel does not recognize.
  Common causes: typos (`=SUMM(...)`), locale-specific separators (`;` vs
  `,`), or dynamic-array functions like `FILTER` in older Excel versions.
- **`#N/A`** — usually from `VLOOKUP` / `XLOOKUP` / `MATCH` failing to find a
  key. Wrap in `IFNA(..., default)` when a miss is expected.
- **Cross-sheet reference typos.** `Sheet1!A1` works; `Sheet 1!A1` needs
  quoting: `'Sheet 1'!A1`. openpyxl accepts either — Excel demands the quoting.

## What is out of scope

- **`.xls` (Excel 97-2003 binary).** Convert to `.xlsx` first:
  `soffice --headless --convert-to xlsx old.xls`.
- **VBA / macros / `.xlsm`.** This skill does not emit or execute macros.
- **Password-protected or encrypted workbooks.** openpyxl cannot read encrypted
  files; strip protection through Excel/LibreOffice first.
- **Live Excel automation.** For COM (Windows) or AppleScript (macOS)
  integration, use a dedicated automation library — this toolkit is
  file-in / file-out.

## Where each detail lives

- **Creating from scratch**: [`create.md`](create.md) — workbooks, sheets,
  formulas, formatting, named styles, charts, images, freeze panes, print
  setup.
- **Editing / templating**: [`edit.md`](edit.md) — patching cells, appending
  rows, inserting columns, preserving formulas & styles, unpack/repack for
  deep XML surgery, defined names, data validation.
- **Reading / extracting**: [`read.md`](read.md) — pandas reads, structural
  inspection, formula extraction, conversion to CSV / TSV / PDF.
- **Data analysis**: [`analyze.md`](analyze.md) — pandas pipelines,
  reshaping, groupby, joins, then handing back to openpyxl for the final
  writeable artifact.
- **Scripts**: [`scripts/`](scripts/) — CLI utilities used throughout.
