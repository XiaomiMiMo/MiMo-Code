# Editing existing spreadsheets

You have an `.xlsx` on disk and you need to change it without losing its
formulas, styles, charts, or hidden metadata.

## Two workflows

| Situation | Workflow | Section |
|-----------|----------|---------|
| Adding rows / patching cells / inserting sheets — normal template fill | Load with openpyxl, mutate, save | *Standard editing* below |
| Deep structural change: adding custom XML parts, rewriting defined names, editing charts openpyxl cannot round-trip | Unpack ZIP → edit XML → repack | *Raw XML workflow* below |

Start with the standard workflow. Fall back to raw XML only when openpyxl
demonstrably drops something on save.

## Cardinal rule: never open with `data_only=True` if you plan to save

```python
# Good — formulas are preserved
wb = load_workbook("model.xlsx")

# BAD — reads cached values, then wb.save() writes them back as constants,
# permanently destroying every formula in the file
wb = load_workbook("model.xlsx", data_only=True)
wb.save("model.xlsx")
```

`data_only=True` is for reads only. Use it in a separate script or with a
different `load_workbook` call from the one you intend to save.

## Standard editing

### Loading + saving

```python
from openpyxl import load_workbook

wb = load_workbook("model.xlsx")   # keeps formulas as strings
ws = wb["Inputs"]                  # or wb.active for the first sheet

ws["B2"] = 1_500_000               # patch a hardcoded input
ws["B3"] = 0.07                    # bump the growth assumption

wb.save("model.xlsx")              # overwrites — write to a copy if unsure
```

Always save to a new path first in destructive workflows:

```python
import shutil
shutil.copy("model.xlsx", "model.backup.xlsx")
wb.save("model.xlsx")
```

### Appending rows to a data table

```python
ws = wb["Data"]

new_rows = [
    ("2026-05-31", "product-A", 1200.50),
    ("2026-06-30", "product-A", 1315.00),
]
for row in new_rows:
    ws.append(row)                        # writes to next unused row
```

If the sheet has a defined `Table` object (Excel's ListObject), you should
expand its range so filters and totals pick up the new rows:

```python
from openpyxl.worksheet.table import Table

tbl = ws.tables["SalesTable"]
tbl.ref = f"A1:C{ws.max_row}"             # extend to include appended rows
```

### Inserting and deleting rows / columns

```python
ws.insert_rows(idx=5, amount=3)           # insert 3 blank rows starting at row 5
ws.delete_rows(idx=10, amount=1)          # delete row 10
ws.insert_cols(idx=2, amount=1)           # insert one column between A and B
ws.delete_cols(idx=4, amount=2)           # delete D and E
```

**Warning:** openpyxl inserts/deletes rows and columns naively — it does *not*
update formulas that reference the affected range. If you insert a row above
`=SUM(B2:B10)`, that formula still references `B2:B10`, which is now the wrong
range. Two mitigations:

1. Structure formulas to reference whole columns (`=SUM(B:B)` sums the entire
   column and survives inserts) or defined names (see below).
2. After inserting/deleting, walk every formula string and shift references
   manually. Use `openpyxl.formula.translate.Translator` for programmatic
   translation:

```python
from openpyxl.formula.translate import Translator

# Original formula lives at B2. After inserting a row above it, the formula
# is now at B3 and should shift references down by one row.
formula = ws["B3"].value                          # e.g. "=A2*1.05"
ws["B3"] = Translator(formula, origin="B2").translate_formula("B3")
```

### Patching cells by label lookup

Working with column letters is fragile. Look up columns by header text:

```python
def col_by_header(ws, header, row=1):
    for cell in ws[row]:
        if cell.value == header:
            return cell.column_letter
    raise KeyError(header)

rev_col = col_by_header(ws, "Revenue")
ws[f"{rev_col}5"] = 42_000
```

### Modifying formulas

```python
# Read current formula
current = ws["D2"].value                # "=B2-C2"

# Rewrite with a guard against divide-by-zero
ws["E2"] = "=IF(B2=0, 0, D2/B2)"

# Fill it down
for row in range(3, ws.max_row + 1):
    ws[f"E{row}"] = f"=IF(B{row}=0, 0, D{row}/B{row})"
```

Do not use `.value` to check whether a cell contains a formula — a hardcoded
string beginning with `=` looks identical. Use `cell.data_type == 'f'` to be
safe:

```python
if ws["D2"].data_type == "f":
    print("formula:", ws["D2"].value)
```

### Adding a new sheet without breaking existing links

```python
new = wb.create_sheet("QA")
wb.move_sheet("QA", offset=-1)           # move it before the current position

# Or place it at a specific index:
wb.create_sheet("Cover", 0)              # 0 = first tab
```

Renaming a sheet does *not* auto-rewrite formulas that reference it. Rename
carefully:

```python
old_name = "Sheet1"
new_name = "Model"
wb[old_name].title = new_name

# Then walk all formulas and rewrite references
import re
for sheet in wb.worksheets:
    for row in sheet.iter_rows():
        for cell in row:
            if cell.data_type == "f" and old_name in (cell.value or ""):
                cell.value = re.sub(rf"\b{re.escape(old_name)}!", f"{new_name}!", cell.value)
```

### Defined names (named ranges)

Named ranges make formulas self-documenting and survive row inserts:

```python
from openpyxl.workbook.defined_name import DefinedName

wb.defined_names["GrowthRate"] = DefinedName(
    name="GrowthRate",
    attr_text="Inputs!$B$3",
)

# In a formula (B1 holds the base value):
ws["B2"] = "=B1*(1 + GrowthRate)"
```

List existing names:

```python
for name, dn in wb.defined_names.items():
    print(name, dn.attr_text)
```

### Preserving styles when patching cells

Assigning `.value` alone keeps the existing style. Assigning `.style` or
constructing a new `Font` replaces it. If you need to preserve everything but
the value:

```python
ws["B2"].value = 42                   # style, format, alignment untouched
```

If you assign via `ws.cell(row=1, column=2).value = 42`, the same holds.

### Working with tables (ListObjects)

```python
from openpyxl.worksheet.table import Table, TableStyleInfo

tbl = Table(
    displayName="Sales",
    ref="A1:D100",
)
tbl.tableStyleInfo = TableStyleInfo(
    name="TableStyleMedium2",
    showRowStripes=True,
)
ws.add_table(tbl)
```

To modify an existing table, edit `ws.tables[name].ref` and re-save. Table
totals rows are automatic — do not write formulas into them by hand.

## Raw XML workflow

Some edits openpyxl cannot round-trip cleanly:

- **Complex charts** — colors, custom legends, secondary axes may reset to
  defaults after openpyxl saves.
- **Custom XML parts** — content controls, custom document properties.
- **Comments with rich formatting** — openpyxl only handles plain text.
- **Threaded comments** (Excel 365 style) — openpyxl silently drops them.
- **Slicers and pivot table customizations** — openpyxl is read-only here.

For any of these, unpack the file, edit the XML directly, and repack.

### Unpack

```bash
python scripts/explode.py input.xlsx unpacked/
```

The layout you get:

```
unpacked/
├── [Content_Types].xml       # MIME map for every part
├── _rels/                    # top-level relationships
├── docProps/                 # app / core / custom document properties
├── xl/
│   ├── workbook.xml          # sheet names, defined names, calc settings
│   ├── _rels/workbook.xml.rels
│   ├── worksheets/
│   │   ├── sheet1.xml        # cell data + formulas + styles refs
│   │   └── ...
│   ├── sharedStrings.xml     # string dedup table
│   ├── styles.xml            # fonts, fills, number formats
│   ├── theme/theme1.xml
│   ├── charts/               # chart XML if any
│   └── drawings/             # image & chart anchors
```

### Editing XML safely

Use `xml.etree.ElementTree` or `lxml`. Namespaces are mandatory in
SpreadsheetML — never strip them.

```python
from lxml import etree

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r":    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

tree = etree.parse("unpacked/xl/worksheets/sheet1.xml")
root = tree.getroot()

for c in root.iterfind(".//main:c", NS):
    ref = c.get("r")                             # e.g. "B2"
    if ref == "B2":
        f = c.find("main:f", NS)
        if f is not None:
            f.text = "SUM(B3:B100)"              # note: no leading "="

tree.write(
    "unpacked/xl/worksheets/sheet1.xml",
    xml_declaration=True, encoding="UTF-8", standalone=True,
)
```

Key SpreadsheetML rules:

- Formula elements (`<f>`) do **not** include the leading `=`. Values do.
- Numeric values live in `<v>` children. String values are indices into
  `sharedStrings.xml` when `t="s"`; inline strings use `<is><t>...</t></is>`.
- Style references (`s="7"`) point into `styles.xml`. Do not change them
  unless you also update `styles.xml`.
- Every cell inside a `<row>` must have a `r=` attribute; every row must have
  an `r=` attribute matching its position (1-indexed).

### Repack

```bash
python scripts/assemble.py unpacked/ output.xlsx
python scripts/audit.py output.xlsx
python scripts/bake.py output.xlsx
```

`assemble.py` rebuilds the ZIP with the correct member order (`[Content_Types].xml`
must be first) and standard deflate compression. `audit.py` confirms the
result parses.

## Tracked changes and comments

### Adding a comment

```python
from openpyxl.comments import Comment

ws["B2"].comment = Comment(
    text="Source: Q4 filing, page 14",
    author="Analyst",
)
ws["B2"].comment.width  = 200
ws["B2"].comment.height = 60
```

### Reading comments

```python
for row in ws.iter_rows():
    for cell in row:
        if cell.comment:
            print(f"{cell.coordinate}: {cell.comment.author}: {cell.comment.text}")
```

## Common mistakes to avoid

- **Saving over the source file without a backup.** One bad `wb.save` is
  unrecoverable. Copy to `.bak` first.
- **Using `data_only=True` and saving.** Every formula in the file becomes a
  constant. This is silent and irreversible.
- **Assuming `ws.max_row` reflects the visible last row.** It includes empty
  formatted rows. If you need the true data extent, iterate and check for
  non-empty cells.
- **Editing `.xlsx` files that are open in Excel.** Excel holds an exclusive
  lock; `wb.save` will fail on Windows and succeed but leave a lock file on
  macOS/Linux. Ask the user to close the file first.
- **Trusting openpyxl to reflow formulas after row/column inserts.** It does
  not. Rewrite affected formulas manually or use whole-column references.

## After editing — always

```bash
python scripts/bake.py output.xlsx
python scripts/audit.py output.xlsx
```

If you touched a formula, spot-check its new value with:

```python
from openpyxl import load_workbook
wb = load_workbook("output.xlsx", data_only=True)   # read-only view
print(wb["Model"]["B12"].value)
```
