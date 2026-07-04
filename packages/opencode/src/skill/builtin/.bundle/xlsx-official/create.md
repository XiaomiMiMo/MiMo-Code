# Creating spreadsheets from scratch

You are producing a new `.xlsx` from a prompt, a dataset, or a mix of both.
The user has no existing template to preserve.

## Library choice

| Task                                       | Library      | Why |
|--------------------------------------------|--------------|-----|
| Bulk data → single tidy sheet              | `pandas`     | `df.to_excel` handles thousands of rows in one call |
| Formulas, formatting, multiple sheets      | `openpyxl`   | Full read/write access, formula strings, styles |
| Very large writes, no formulas needed      | `xlsxwriter` | Streaming writer, smaller memory footprint |
| Both — data + formulas + formatting        | Start in pandas, finish in openpyxl (see below) |

`openpyxl` is the default. Reach for pandas when the payload is a DataFrame,
and xlsxwriter only when memory or throughput bites.

## Minimum viable workbook

```python
from openpyxl import Workbook

wb = Workbook()
ws = wb.active
ws.title = "Summary"

ws["A1"] = "Metric"
ws["B1"] = "Value"
ws["A2"] = "Total revenue"
ws["B2"] = "=SUM(Data!B2:B100)"

wb.create_sheet("Data")
wb.save("out.xlsx")
```

Notes:

- `wb.active` returns the sheet created implicitly; rename it before adding more.
- Coordinates can be `"A1"` strings **or** `.cell(row=1, column=1, value=...)`
  — pick one style per file and stay consistent.
- `wb.save` overwrites unconditionally. Guard against clobbering user files
  with an `os.path.exists` check when writing to a user-supplied path.

## Writing data

### From a list of dicts

```python
from openpyxl import Workbook

rows = [
    {"date": "2026-01-31", "product": "A", "revenue": 1200.50},
    {"date": "2026-02-28", "product": "B", "revenue":  980.00},
]

wb = Workbook()
ws = wb.active
ws.title = "Sales"

headers = list(rows[0].keys())
ws.append(headers)
for row in rows:
    ws.append([row[h] for h in headers])

wb.save("sales.xlsx")
```

`ws.append` writes the next row after the last one used. Combine with a header
row for a clean tidy layout.

### From a pandas DataFrame

```python
import pandas as pd

df = pd.DataFrame(rows)                    # rows from the previous block
df.to_excel("sales.xlsx", sheet_name="Sales", index=False)
```

`to_excel` needs the `openpyxl` engine for `.xlsx` output (it is picked
automatically when installed). Pass `index=False` unless the DataFrame index
carries real meaning.

### Multiple sheets in one file

```python
with pd.ExcelWriter("multi.xlsx", engine="openpyxl") as writer:
    df_sales.to_excel(writer, sheet_name="Sales",   index=False)
    df_costs.to_excel(writer, sheet_name="Costs",   index=False)
    df_agg.to_excel(writer,   sheet_name="Summary", index=False)
```

To attach openpyxl formatting after pandas writes, keep the writer open and
access `writer.book` / `writer.sheets`:

```python
with pd.ExcelWriter("multi.xlsx", engine="openpyxl") as writer:
    df.to_excel(writer, sheet_name="Sales", index=False)
    ws = writer.sheets["Sales"]
    ws.freeze_panes = "A2"
    ws.column_dimensions["A"].width = 14
```

## Formulas

Formulas are strings that begin with `=`. openpyxl writes them verbatim and
does not evaluate them.

```python
ws["B10"] = "=SUM(B2:B9)"
ws["C10"] = "=B10/COUNT(B2:B9)"
ws["D2"]  = "=IF(B2=0, 0, C2/B2)"        # guard against #DIV/0!
ws["E2"]  = "=VLOOKUP(A2, Products!A:C, 3, FALSE)"
```

Use built-in Excel functions freely — `SUM`, `AVERAGE`, `IF`, `IFERROR`,
`VLOOKUP`, `XLOOKUP`, `INDEX`, `MATCH`, `SUMIFS`, `COUNTIFS`, `INDIRECT`,
`OFFSET`, `TEXT`, `LEFT`, `RIGHT`, `CONCAT`, `TEXTJOIN`, `LET`. Newer
dynamic-array functions (`FILTER`, `UNIQUE`, `SEQUENCE`, `SORT`) only work in
Excel 365 / Excel 2021 and later.

### Filling a formula down a column

```python
for row in range(2, 101):
    ws.cell(row=row, column=5, value=f"=B{row}*C{row}")
```

Absolute references (`$B$2`) survive drag-fill; relative references (`B2`)
shift. When writing programmatically, both are just strings — you decide.

### Escaping literal equals signs

If the cell content genuinely starts with `=` but is not a formula, prefix a
single quote: `ws["A1"] = "'=not a formula"`. Excel hides the quote.

## Styles and formatting

### Font, alignment, fills

```python
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side

bold = Font(name="Calibri", size=11, bold=True, color="1F1F1F")
center = Alignment(horizontal="center", vertical="center", wrap_text=True)
header_fill = PatternFill("solid", fgColor="F2F2F2")

for cell in ws[1]:                              # header row
    cell.font = bold
    cell.alignment = center
    cell.fill = header_fill
```

Colors are 8-character ARGB strings (`"FFF2F2F2"`) or 6-character RGB
(`"F2F2F2"`) — openpyxl accepts both. Alpha is almost always `FF`.

### Named styles (reusable)

```python
from openpyxl.styles import NamedStyle, Font, PatternFill, Alignment

input_style = NamedStyle(name="Input")
input_style.font = Font(color="0033CC")           # blue
input_style.number_format = "#,##0.00"
input_style.alignment = Alignment(horizontal="right")

if "Input" not in wb.named_styles:
    wb.add_named_style(input_style)

ws["B2"].style = "Input"
ws["B3"].style = "Input"
```

Registering once and applying by name keeps the file small and consistent.

### Column widths and row heights

```python
ws.column_dimensions["A"].width = 22        # ~22 characters
ws.column_dimensions["B"].width = 14
ws.row_dimensions[1].height = 22            # header row, taller

# Auto-fit is not native. Approximate with the longest value:
for column_cells in ws.columns:
    longest = max((len(str(c.value)) for c in column_cells if c.value is not None), default=8)
    ws.column_dimensions[column_cells[0].column_letter].width = min(longest + 2, 60)
```

Excel does not persist auto-fit metadata — LibreOffice does. Setting an
explicit width is the reliable choice.

### Number formats

```python
ws["B2"].number_format = "$#,##0.00"
ws["C2"].number_format = "0.0%"
ws["D2"].number_format = "yyyy-mm-dd"
```

Column-wide format — loop over the cells; `column_dimensions` does **not**
format cells written afterwards:

```python
for row in ws.iter_rows(min_row=2, min_col=2, max_col=2, max_row=ws.max_row):
    for cell in row:
        cell.number_format = "$#,##0.00"
```

See the number-format cheatsheet in [`SKILL.md`](SKILL.md).

### Borders

```python
thin = Side(style="thin", color="BFBFBF")
box = Border(left=thin, right=thin, top=thin, bottom=thin)

for row in ws.iter_rows(min_row=1, max_row=10, min_col=1, max_col=5):
    for cell in row:
        cell.border = box
```

Only apply borders where they help — a table body benefits, a summary line
does not.

### Freeze panes

```python
ws.freeze_panes = "A2"     # freeze header row
ws.freeze_panes = "B2"     # freeze header row + first column
```

Always freeze when the table scrolls.

### Merged cells

```python
ws.merge_cells("A1:D1")
ws["A1"] = "FY2026 Sales"
ws["A1"].alignment = Alignment(horizontal="center")
```

Only the top-left cell of the merged range is writable. Do not merge cells
inside a table body — sorting and filtering break.

## Charts

```python
from openpyxl.chart import LineChart, BarChart, PieChart, Reference

chart = LineChart()
chart.title = "Monthly revenue"
chart.y_axis.title = "USD"
chart.x_axis.title = "Month"

data = Reference(ws, min_col=2, min_row=1, max_col=2, max_row=13)   # includes header
cats = Reference(ws, min_col=1, min_row=2, max_row=13)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)

ws.add_chart(chart, "D2")   # anchor top-left of chart at D2
```

`BarChart`, `PieChart`, `ScatterChart`, and `AreaChart` follow the same
pattern. Chart title placement, axis formatting, and legend visibility all
have properties — check the openpyxl docs for the exact attribute names.

## Images

```python
from openpyxl.drawing.image import Image

img = Image("logo.png")
img.width  = 120     # pixels, not points
img.height = 40
ws.add_image(img, "A1")
```

`Image` requires Pillow to be installed. Anchor images to a cell — never rely
on absolute pixel coordinates because they shift on different DPI settings.

## Data validation (dropdowns)

```python
from openpyxl.worksheet.datavalidation import DataValidation

dv = DataValidation(
    type="list",
    formula1='"North,South,East,West"',
    allow_blank=True,
    showDropDown=False,   # confusingly, False = show the dropdown
)
dv.error = "Choose a region from the list."
dv.errorTitle = "Invalid region"
ws.add_data_validation(dv)
dv.add("C2:C100")
```

For lists longer than ~255 characters, put the choices in a hidden sheet and
reference the range: `formula1="=Lists!$A$2:$A$100"`.

## Conditional formatting

```python
from openpyxl.styles import PatternFill
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule

# Highlight cells below 0 in red
red = PatternFill("solid", fgColor="FFC7CE")
ws.conditional_formatting.add(
    "C2:C100",
    CellIsRule(operator="lessThan", formula=["0"], fill=red),
)

# Three-color scale
ws.conditional_formatting.add(
    "D2:D100",
    ColorScaleRule(
        start_type="min", start_color="F8696B",
        mid_type="percentile", mid_value=50, mid_color="FFEB84",
        end_type="max", end_color="63BE7B",
    ),
)
```

Conditional formats are evaluated by Excel/LibreOffice at open time, not by
openpyxl. They will not affect `data_only=True` reads.

## Print setup

```python
ws.page_setup.orientation = "landscape"
ws.page_setup.paperSize = ws.PAPERSIZE_A4        # or PAPERSIZE_LETTER
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0                    # 0 = as many pages tall as needed
ws.print_options.horizontalCentered = True
ws.print_title_rows = "1:1"                      # repeat row 1 on every page
ws.print_area = "A1:F100"
ws.oddHeader.center.text = "&BFY2026 Sales Report"
ws.oddFooter.right.text = "Page &P of &N"
```

## Full working example

```python
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill, NamedStyle

wb = Workbook()

# ---- Inputs sheet -----------------------------------------------------
inputs = wb.active
inputs.title = "Inputs"

inputs["A1"] = "Assumption"
inputs["B1"] = "Value"
inputs.append(["Starting revenue", 1_000_000])
inputs.append(["Monthly growth",   0.05])
inputs.append(["COGS % of revenue", 0.42])

for cell in inputs[1]:
    cell.font = Font(bold=True)
    cell.fill = PatternFill("solid", fgColor="F2F2F2")

inputs.column_dimensions["A"].width = 24
inputs.column_dimensions["B"].width = 16
inputs["B2"].number_format = "$#,##0"
inputs["B3"].number_format = "0.0%"
inputs["B4"].number_format = "0.0%"

# ---- Model sheet ------------------------------------------------------
model = wb.create_sheet("Model")
model.append(["Month", "Revenue", "COGS", "Gross profit"])
for cell in model[1]:
    cell.font = Font(bold=True)

for i in range(1, 13):
    row = i + 1
    if i == 1:
        model.cell(row=row, column=2, value="=Inputs!B2")
    else:
        model.cell(row=row, column=2, value=f"=B{row - 1}*(1 + Inputs!$B$3)")
    model.cell(row=row, column=1, value=i)
    model.cell(row=row, column=3, value=f"=B{row}*Inputs!$B$4")
    model.cell(row=row, column=4, value=f"=B{row}-C{row}")

for col in ("B", "C", "D"):
    model.column_dimensions[col].number_format = "$#,##0"
    model.column_dimensions[col].width = 14
model.column_dimensions["A"].width = 8
model.freeze_panes = "A2"

# ---- Save + recalc ----------------------------------------------------
wb.save("model.xlsx")

# Then (outside this script) run:
#   python scripts/bake.py model.xlsx
# to fill in the computed values.
```

## After saving — always

```bash
python scripts/bake.py model.xlsx
python scripts/audit.py model.xlsx
```

If `bake.py` reports any errors, fix them and repeat. A workbook shipped
with `#REF!` in the middle of a formula is a bug, not a feature.
