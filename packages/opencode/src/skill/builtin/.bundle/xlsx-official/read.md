# Reading and extracting from spreadsheets

You need to pull data, structure, or metadata out of an existing `.xlsx`.

## Which reader to use

| Goal | Reader | Why |
|------|--------|-----|
| Read the data into memory for analysis | `pandas.read_excel` | Tidy DataFrame, dtype handling, sheet dict |
| Inspect formulas, styles, comments, structure | `openpyxl.load_workbook` | Full round-trip fidelity |
| Read *only* the numeric values (not the formulas) | `openpyxl.load_workbook(..., data_only=True)` | Uses cached values from last recalc |
| Just want plain-text output for grep / prompting | `scripts/csv_out.py` | One CSV per sheet, only needs openpyxl |
| Reading a very large file, memory-constrained | `openpyxl.load_workbook(..., read_only=True)` | Streaming iterator, no full parse |

## pandas — the fast path

```python
import pandas as pd

# Single sheet — first sheet by default
df = pd.read_excel("input.xlsx")

# Specific sheet by name or index
df = pd.read_excel("input.xlsx", sheet_name="Sales")
df = pd.read_excel("input.xlsx", sheet_name=0)

# All sheets as a dict of DataFrames
sheets = pd.read_excel("input.xlsx", sheet_name=None)
for name, df in sheets.items():
    print(name, df.shape)

# Skip garbage rows above the header
df = pd.read_excel("input.xlsx", header=3)         # header on row 4

# Custom header + skip trailing footer
df = pd.read_excel("input.xlsx", header=0, skipfooter=2)

# Force column types (avoids "1234" becoming an int)
df = pd.read_excel("input.xlsx", dtype={"account_id": str, "sku": str})

# Parse dates
df = pd.read_excel("input.xlsx", parse_dates=["order_date", "ship_date"])

# Only load specific columns (big files)
df = pd.read_excel("input.xlsx", usecols=["date", "product", "revenue"])

# Load a specific range
df = pd.read_excel("input.xlsx", sheet_name="Sales", usecols="A:E", nrows=1000)
```

Notes:

- `read_excel` uses the `openpyxl` engine automatically for `.xlsx`.
- It reads the **cached** cell values, so formulas show up as their most
  recently saved values. If the file was written by openpyxl without a
  recalc, formula cells come back as `None`. Run `scripts/bake.py` first.
- Merged cells are read only in the top-left cell; the rest of the merge is
  `NaN`. Use `df.ffill()` if you need to un-merge visually.

## openpyxl — structural reads

```python
from openpyxl import load_workbook

wb = load_workbook("input.xlsx", data_only=True)      # for values
# OR
wb = load_workbook("input.xlsx", data_only=False)     # keep formula strings

# List sheets
for name in wb.sheetnames:
    ws = wb[name]
    print(f"{name}: {ws.max_row} rows × {ws.max_column} cols")

# Read every cell
ws = wb["Sales"]
for row in ws.iter_rows(min_row=2, values_only=True):
    date, product, revenue = row
    ...
```

`values_only=True` returns tuples of values instead of `Cell` objects — much
faster and lighter for pure data reads.

### Reading formulas

```python
wb = load_workbook("input.xlsx", data_only=False)
ws = wb["Model"]

for row in ws.iter_rows(min_row=2):
    for cell in row:
        if cell.data_type == "f":
            print(cell.coordinate, "=", cell.value)
```

### Reading comments and hyperlinks

```python
for row in ws.iter_rows():
    for cell in row:
        if cell.comment:
            print(cell.coordinate, cell.comment.author, cell.comment.text)
        if cell.hyperlink:
            print(cell.coordinate, cell.hyperlink.target)
```

### Reading merged ranges

```python
for merged in ws.merged_cells.ranges:
    print(merged, "→", ws.cell(row=merged.min_row, column=merged.min_col).value)
```

### Reading defined names

```python
for name, dn in wb.defined_names.items():
    print(name, dn.attr_text)
```

## Extracting only what you need

### Tables (Excel ListObjects)

```python
ws = wb["Sales"]
for name, tbl in ws.tables.items():
    print(name, tbl.ref)
    rng = ws[tbl.ref]                   # e.g. A1:D100
    headers = [c.value for c in rng[0]]
    rows = [[c.value for c in r] for r in rng[1:]]
```

### Named ranges as DataFrames

```python
def read_named_range(wb, name):
    dn = wb.defined_names[name]
    # dn.destinations yields (sheet_name, cell_range) tuples
    for sheet, ref in dn.destinations:
        ws = wb[sheet]
        rng = ws[ref]
        return [[c.value for c in row] for row in rng]

data = read_named_range(wb, "SalesRegion")
```

## Handling messy inputs

### Detecting the real header row

If the file has a title, a blank row, and *then* the header, pandas' default
`header=0` reads the title as the header. Two options:

```python
# 1. Skip the noise
df = pd.read_excel("input.xlsx", header=3, skiprows=0)

# 2. Auto-detect: find the first row that looks like headers
raw = pd.read_excel("input.xlsx", header=None)
for i, row in raw.iterrows():
    if row.notna().sum() >= 3 and all(isinstance(v, str) for v in row.dropna()):
        df = pd.read_excel("input.xlsx", header=i)
        break
```

### Fixing merged-cell headers

```python
raw = pd.read_excel("input.xlsx", header=[0, 1])         # two-row header
raw.columns = [" ".join(str(c) for c in col if str(c) != "nan").strip()
               for col in raw.columns]
```

### Stripping whitespace and empty columns

```python
df.columns = df.columns.str.strip()
df = df.dropna(axis=1, how="all")                        # empty columns
df = df.dropna(axis=0, how="all")                        # empty rows
df = df.reset_index(drop=True)
```

### Coercing types

```python
df["revenue"] = pd.to_numeric(df["revenue"], errors="coerce")
df["date"]    = pd.to_datetime(df["date"], errors="coerce")
df["email"]   = df["email"].astype("string").str.lower()
```

`errors="coerce"` turns unparseable values into `NaN`/`NaT` — safer than
`raise` for exploratory reads, but check the result: `df["revenue"].isna().sum()`.

## Converting to other formats

### CSV (one per sheet)

```bash
python scripts/csv_out.py input.xlsx out_dir/
```

Programmatic version:

```python
import pandas as pd
sheets = pd.read_excel("input.xlsx", sheet_name=None)
for name, df in sheets.items():
    df.to_csv(f"out_dir/{name}.csv", index=False)
```

### TSV

```python
df.to_csv("out.tsv", sep="\t", index=False)
```

### PDF (for visual QA)

```bash
python scripts/pdf_out.py input.xlsx
```

Requires LibreOffice. See `scripts/runtime/libreoffice.py` for the wrapper.

### Plain text summary

For quick prompt context or grep:

```bash
python scripts/overview.py input.xlsx
```

Outputs JSON with sheet names, dimensions, dtype guesses, and a small sample.

## Performance tips

- **Large files with only a few sheets you care about**: pass `sheet_name`
  explicitly. `sheet_name=None` reads *every* sheet.
- **Very wide sheets**: use `usecols=` to restrict columns.
- **Streaming read**: `openpyxl.load_workbook(..., read_only=True)` avoids
  loading the whole XML into memory. You lose write ability and some
  attributes but can iterate millions of rows.

```python
wb = load_workbook("huge.xlsx", read_only=True, data_only=True)
ws = wb["Data"]
for row in ws.iter_rows(values_only=True):
    process(row)
wb.close()
```

- **Only read specific rows**: `ws.iter_rows(min_row=N, max_row=M, values_only=True)`.

## Formula extraction (source auditing)

For understanding a model's logic without running it:

```python
from openpyxl import load_workbook

wb = load_workbook("model.xlsx", data_only=False)
for sheet in wb.worksheets:
    for row in sheet.iter_rows():
        for cell in row:
            if cell.data_type == "f":
                print(f"{sheet.title}!{cell.coordinate}\t{cell.value}")
```

Pipe to a file, then grep for `VLOOKUP`, `INDIRECT`, external references
(`[Book2.xlsx]`), etc.

## What openpyxl cannot read

- **Encrypted files.** Convert with LibreOffice or a dedicated decryption
  library first.
- **`.xls`** (Excel 97-2003 binary). Convert with
  `soffice --headless --convert-to xlsx old.xls`, or use the `xlrd` library
  (last supported version reads .xls, but no longer maintained).
- **Threaded comments** (Excel 365-only). openpyxl silently drops them —
  unpack the file and read `xl/threadedComments/` XML manually.
- **Some chart customizations.** The data references are readable; visual
  attributes may not round-trip.

If openpyxl fails on a file, run `scripts/audit.py` — the error message
will point to the specific part.
