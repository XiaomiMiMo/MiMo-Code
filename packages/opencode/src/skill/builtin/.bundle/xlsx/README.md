# xlsx skill (Apache-2.0)

A permissively-licensed toolkit for creating, editing, reading, and analyzing
Microsoft Excel (`.xlsx`) files.

## About

This is an independent implementation, written from scratch against the public
ECMA-376 SpreadsheetML specification and built on permissively-licensed
third-party libraries. It is licensed under Apache-2.0 (see [`LICENSE`](LICENSE)),
which allows commercial use, modification, and redistribution.

- **Written from scratch.** The API surface follows what the ECMA-376
  specification and the underlying open-source libraries (`openpyxl`, `pandas`)
  naturally provide.
- **Apache-2.0 licensed.** Use it in commercial projects, ship it to customers,
  and fork it freely, subject to the terms in [`LICENSE`](LICENSE).

## Bundling this skill in a product?

If you plan to redistribute this skill as part of a larger product, you take
on the license obligations of every dependency you ship with it. The core set:

| Dependency        | License        | Redistribution requirement |
|-------------------|----------------|-----------------------------|
| This skill        | Apache-2.0     | Preserve `LICENSE` file; keep the notice; state changes if you modify. |
| openpyxl          | MIT            | Preserve copyright + permission notice. |
| pandas            | BSD-3-Clause   | Preserve copyright + notice; do not use contributors' names to endorse without permission. |
| lxml              | BSD-3-Clause   | Same as pandas. |
| xlsxwriter (opt.) | BSD-2-Clause   | Preserve copyright + notice. |
| LibreOffice       | MPL 2.0        | Only if you *bundle* the binary. Merely calling it as a subprocess (which is what this skill does) does not trigger MPL. |

None of these are copyleft in a way that "infects" your product code, but all of
them require you to keep their license text alongside anything you ship.
Practical checklist for a product build:

1. Copy this skill's [`LICENSE`](LICENSE) into your `THIRD_PARTY_LICENSES/` or
   equivalent directory in your product.
2. Add the license texts of `openpyxl`, `pandas`, `lxml`, `xlsxwriter` (if you
   depend on them) — they usually live in the `LICENSE` file of each installed
   package.
3. If you install LibreOffice as part of your product, ship its `LICENSE` and
   `NOTICE` files too.
4. If you modified the skill, note the modifications (Apache-2.0 §4b).

## What's inside

| File / directory | Purpose |
|------------------|---------|
| [`SKILL.md`](SKILL.md) | Entry point — decision matrix, environment setup, QA checklist. Read this first. |
| [`create.md`](create.md) | Author a new workbook from prompts or data. Formatting, formulas, charts, styles. |
| [`edit.md`](edit.md) | Modify an existing workbook without destroying its formulas or templates. |
| [`read.md`](read.md) | Extract data, inspect structure, convert to CSV / plain text / PDF. |
| [`analyze.md`](analyze.md) | Data-analysis workflows with pandas — cleaning, transforming, summarizing. |
| [`scripts/`](scripts/) | Self-contained Python CLIs used by all of the above. |

## Runtime requirements

```bash
python3 -m pip install --upgrade openpyxl pandas lxml
# Recommended extras
python3 -m pip install --upgrade xlsxwriter openpyxl-image-loader
# For recalculation + PDF export:
#   macOS       brew install --cask libreoffice
#   Debian/Ubuntu apt-get install -y libreoffice
```

**Note on the `overview.py` name:** the script is deliberately not named
`inspect.py`, because that would shadow Python's stdlib `inspect` module and
break NumPy's import when the script's directory ends up on `sys.path`.

`openpyxl` writes formulas as strings — it does not evaluate them. If you emit
formulas and want their values to appear in the saved file, run
`scripts/bake.py` after saving. LibreOffice does the recalculation in a
headless subprocess.

## Non-goals

- **`.xls` (legacy Excel 97-2003).** Convert to `.xlsx` first with LibreOffice:
  `soffice --headless --convert-to xlsx old.xls`.
- **VBA macros.** This skill does not produce `.xlsm` files or write VBA. If
  the user needs automation, ship a Python script alongside the workbook.
- **Real-time Excel automation** (via COM on Windows or AppleScript on macOS).
  This is a file-in / file-out toolkit.

## Where each capability lives

Start at [`SKILL.md`](SKILL.md) — the decision matrix routes you to the right
guide.
