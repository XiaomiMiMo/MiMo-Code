# Data analysis with pandas → openpyxl

You need to clean, transform, aggregate, or summarize tabular data and hand
the result back as a polished `.xlsx`. The pattern is:

1. **Read** into pandas (`read.md` covers this).
2. **Transform** in memory — pure pandas.
3. **Write** back through pandas for the data, then reopen with openpyxl to
   attach formulas, formatting, and named styles.

pandas is fast and expressive but produces plain workbooks — no formulas,
minimal formatting. openpyxl finishes the job.

## Standard pipeline

```python
import pandas as pd
from openpyxl import load_workbook
from openpyxl.styles import Font, Alignment, PatternFill

# 1. Read
df = pd.read_excel("raw.xlsx", sheet_name="Data")

# 2. Transform
df.columns = df.columns.str.strip().str.lower().str.replace(" ", "_")
df["revenue"] = pd.to_numeric(df["revenue"], errors="coerce").fillna(0)
df["month"]   = pd.to_datetime(df["date"]).dt.to_period("M").astype(str)

monthly = (
    df.groupby("month", as_index=False)
      .agg(revenue=("revenue", "sum"),
           orders =("order_id", "nunique"))
      .sort_values("month")
)
monthly["avg_order"] = monthly["revenue"] / monthly["orders"]

# 3. Write raw + summary
with pd.ExcelWriter("out.xlsx", engine="openpyxl") as w:
    df.to_excel(w,      sheet_name="Data",    index=False)
    monthly.to_excel(w, sheet_name="Monthly", index=False)

# 4. Polish
wb = load_workbook("out.xlsx")
for sheet_name in ("Data", "Monthly"):
    ws = wb[sheet_name]
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1F3A5F")
        cell.alignment = Alignment(horizontal="center")
    ws.freeze_panes = "A2"
    for col in ws.columns:
        w = max((len(str(c.value)) for c in col if c.value is not None), default=8)
        ws.column_dimensions[col[0].column_letter].width = min(w + 2, 40)

# 5. Add an average-order formula so the summary recomputes when data changes
mon = wb["Monthly"]
for row in range(2, mon.max_row + 1):
    mon.cell(row=row, column=4, value=f"=B{row}/C{row}")
    mon.cell(row=row, column=2).number_format = "$#,##0"
    mon.cell(row=row, column=4).number_format = "$#,##0.00"

wb.save("out.xlsx")
```

Then recalc:

```bash
python scripts/bake.py out.xlsx
```

## Common transforms

### Deduplicate

```python
df = df.drop_duplicates(subset=["order_id"], keep="last")
```

### Fill missing values sensibly

```python
df["region"] = df["region"].fillna("Unknown")
df["revenue"] = df["revenue"].fillna(0)
df["cost"]   = df.groupby("region")["cost"].transform(lambda s: s.fillna(s.median()))
```

Do not fill with `0` when the value is genuinely unknown — it lies to the
downstream reader.

### Reshape

```python
# Long → wide
pivot = df.pivot_table(
    index="month",
    columns="region",
    values="revenue",
    aggfunc="sum",
    fill_value=0,
)

# Wide → long
long = pivot.reset_index().melt(id_vars="month", var_name="region", value_name="revenue")
```

### Join tables

```python
merged = orders.merge(customers, on="customer_id", how="left")
```

Always specify `how=` explicitly. The default is `"inner"` — silently dropping
unmatched rows is a common source of bugs.

### Bin into categories

```python
df["revenue_band"] = pd.cut(
    df["revenue"],
    bins=[-float("inf"), 100, 1000, 10_000, float("inf")],
    labels=["<$100", "$100–$1k", "$1k–$10k", "$10k+"],
)
```

### Rolling / cumulative

```python
df = df.sort_values("date")
df["revenue_7d"]  = df["revenue"].rolling(window=7, min_periods=1).sum()
df["revenue_ytd"] = df.groupby(df["date"].dt.year)["revenue"].cumsum()
```

## Emitting formulas from a pandas pipeline

This is the payoff of using openpyxl on top of pandas: aggregations that live
in Excel and recompute when users edit the raw sheet.

**Rule:** any total, ratio, or summary the user might want to update should
be a **formula**, not a Python-computed constant.

Anti-pattern:

```python
totals = df.groupby("region")["revenue"].sum().reset_index()
totals.to_excel(writer, sheet_name="Totals", index=False)   # numbers hardcoded
```

If the user later fixes a typo in the Data sheet, `Totals` does not update.

Better:

```python
regions = df["region"].dropna().unique()

with pd.ExcelWriter("out.xlsx", engine="openpyxl") as w:
    df.to_excel(w, sheet_name="Data", index=False)

    # Write the totals sheet as headers + formulas
    ws = w.book.create_sheet("Totals")
    ws.append(["Region", "Revenue"])
    for i, region in enumerate(regions, start=2):
        ws.cell(row=i, column=1, value=region)
        cell = ws.cell(row=i, column=2,
                       value=f'=SUMIFS(Data!C:C, Data!B:B, "{region}")')
        cell.number_format = "$#,##0"
```

Now the totals recompute in Excel. The raw `df.groupby(...)` result can still
be checked at test time to confirm the formulas produce the expected numbers.

## Reading formulas back into pandas

Sometimes the file arrives with formulas and you want the *computed* values:

```python
# The file must have been saved by Excel (or by bake.py) since edits
df = pd.read_excel("model.xlsx", sheet_name="Model")
```

If the file was written by openpyxl and never recalced, formula cells come
back as `None`. Fix it:

```bash
python scripts/bake.py model.xlsx
```

Then re-read.

## Categorical data in openpyxl output

pandas categoricals write as their underlying values by default:

```python
df["region"].astype(str).to_excel(...)     # forces string, safe
```

Or convert to string before writing, especially if the categories are used in
formulas — Excel does not understand pandas categoricals.

## Datetime gotchas

Excel stores dates as serial numbers (days since 1900-01-01 or 1904-01-01
depending on the workbook). openpyxl converts back and forth automatically,
but timezone-aware timestamps do not round-trip:

```python
df["ts"] = df["ts"].dt.tz_convert("UTC").dt.tz_localize(None)
```

Drop the timezone before writing, then rely on a separate column or naming
convention to communicate the offset.

## Performance

- Use `pd.read_excel(..., engine="openpyxl")` explicitly — it is the only
  engine that supports `.xlsx` reliably across pandas versions.
- Very large writes: prefer `xlsxwriter` for pandas' engine, then reopen with
  openpyxl only for the small parts that need formulas or formatting:

```python
with pd.ExcelWriter("big.xlsx", engine="xlsxwriter") as w:
    df.to_excel(w, sheet_name="Data", index=False)   # streams

wb = load_workbook("big.xlsx")
mon = wb.create_sheet("Monthly")
# ... add formulas ...
wb.save("big.xlsx")
```

- Avoid iterating `for i, row in df.iterrows()` when writing rows — call
  `df.to_excel` or convert to a NumPy array first.

## Validating your pipeline

Before shipping:

1. **Recalculate** — the writer only stored formula strings.
   ```bash
   python scripts/bake.py out.xlsx
   ```
2. **Sanity-check totals** — the pandas value and the Excel formula should
   match.
   ```python
   from openpyxl import load_workbook
   wb = load_workbook("out.xlsx", data_only=True)
   assert wb["Totals"]["B2"].value == monthly.iloc[0]["revenue"]
   ```
3. **Diff against a known-good snapshot** if the pipeline runs on a schedule.
   Save last month's output alongside this month's and compare row counts /
   sums / min-max ranges.

If numbers do not agree, investigate before shipping. Do not "fix" the file
by hardcoding the pandas value — it means one of the formulas is wrong.
