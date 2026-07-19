---
name: report-to-google-doc
description: "Narrow conversion skill. Invoke only when the user explicitly asks to convert an existing local or blob-hosted HTML analytics report into a Google Doc, DOCX, or shareable document."
---

# Report To Google Doc

Use this skill only when the user explicitly needs a shareable Google Drive document from an existing HTML analytics report. The source must be an HTML report: a local file, a downloaded blob-hosted report, or a report produced by `$build-report`
HTML mode or an equivalent local portable report source.

The expected path is HTML -> DOCX -> Drive upload. It is acceptable for Drive to host the upload as a DOCX-backed viewer file rather than a native Google Docs MIME type. Do not use the old Google Docs batch-update request path.

## Workflow

1. Resolve the HTML report.

   Use an absolute local path. If the user provides a remote report, retrieve it first and pass the local HTML file to the helper. If the file is a sign-in page, redirect page, or tiny stub, stop and obtain the real report.

2. Run the bundled helper.

   ```bash
   python3 <REPORT_TO_GOOGLE_DOC_SKILL_DIR>/scripts/report_to_google_doc_plan.py \
     /absolute/path/to/report.html \
     --out-dir /tmp/report_to_google_doc_plan
   ```

   Omit `--render-workers` on the normal path. Only pass a worker count after benchmarking the same report family locally. If dependencies are missing,
   use a local virtual environment with `beautifulsoup4`, `pillow`, and `python-docx`; `cairosvg` or headless Playwright are optional renderers.

3. Inspect helper outputs.

   Required outputs:

   - `skeleton.txt`: source text with stable placeholders
   - `manifest.json`: parsed headings, tables, callouts, lists, styles, links,
     and rendered visual inventory
   - `preflight_checks.json`: source, width, DOCX, and rendered-image checks
   - `report.docx`: generated local Word document
   - `docx_upload_plan.json`: compact upload instructions
   - `placeholder_queries.json`: source mapping debug labels

   Do not upload until `preflight_checks.json` has `status: "passed"` with zero errors. Warnings must either be fixed or called out in the handoff.

4. Upload the DOCX.

   ```json
   mcp__codex_apps__google_drive._upload_file({
     "file_uri": "/tmp/report_to_google_doc_plan/report.docx",
     "file_name": "Report Name.docx",
     "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
   })
   ```

   Treat the returned Drive URL as the deliverable. Do not attempt to force native Google Docs conversion, and do not fall back to `_batch_update_document`.

5. Validate the uploaded result.

   Confirm the uploaded file is readable and non-empty. Compare uploaded text against the source inventory: title, section headings, executive summary or answer callout, caveats, recommendations, source notes, and source links.
   Inspect the local `report.docx` structure when available: heading counts,
   lists, tables, hyperlink relationships, and image relationships should match `manifest.json`.

6. Hand off the link.

   Return the Drive/Docs URL and, when useful, the local DOCX path or source HTML path. Connector success alone is not enough; the handoff is complete only after the uploaded file and local DOCX structure have been checked against the source report. Keep routine check and preflight details in support artifacts. Do not list internal checks in the user-facing handoff unless a check failed, was unavailable, or produced a user-relevant caveat.

## Standards

- Preserve every section, headline claim, metric card, metric definition,
  source note, chart takeaway, recommendation, caveat, and link from the HTML report.
- Preserve semantic formatting: headings, paragraphs, inline bold/emphasis,
  inline code, positive/negative colors, links, lists, callouts, metric-card grids, tables, notes, captions, and charts.
- Use DOCX-native structures wherever practical: headings, paragraphs, tables,
  bullets/numbered lists, links, inline images, paragraph shading, table cell shading, and text styles.
- Keep the report text column readable. Tables, charts, rendered table grids,
  screenshots, and visual blocks must not exceed the DOCX page text width.
- Preserve charts as inline images rendered from the source visual or its same-data SVG fallback, aligned to the same left edge as text and tables. A chart with missing bars, missing legend swatches, or all-black/all-white marks fails validation even if the DOCX contains an image object.
- Preserve multi-column report blocks. A two-column grid made only of titled mini-tables can remain a two-column rendered image capped to the text width;
  mixed two-column blocks with narrative text, pills, callouts, or non-table panels should preserve that content natively instead of dropping it.
- Do not expose customer-level details or sensitive links that were intentionally omitted from a sanitized report.
- Do not write Google Docs batch-update artifacts such as `seed_requests.json`,
  `remote_write_plan.json`, or `all_requests*.json`.

## Repairs

Use these fixes when validation exposes a conversion issue:

| Problem | Fix |
| --- | --- |
| Heading is regular weight | Fix the DOCX writer heading style or explicit run bolding. |
| Blank line after title or heading | Delete spacer paragraphs; skeletons should emit `\n`, not `\n\n`, after headings. |
| Body paragraphs have too much space | Delete literal blank paragraphs and set modest style spacing. |
| Table/image too wide | Set table columns or image width to the DOCX text column width. |
| Chart has labels but missing bars | Inline SVG class styles or use a headless screenshot before inserting. |
| Two-column table group is flattened | Treat the grid as one layout block with mini-table titles preserved. |
| Executive summary, metric cards, or section is missing | Fix parser inventory before upload. |
| Chart overlaps table | Insert the image on its own paragraph after the table. |
| Chart duplicated | Remove the extra image; keep exactly one source-order copy. |
| Inline bold/code/color missing | Fix manifest range splitting in the DOCX writer. |
| Source links show raw URLs | Replace with native linked labels or native bullets using HTML link text. |

## Local Checks

```bash
python3 -m py_compile <REPORT_TO_GOOGLE_DOC_SKILL_DIR>/scripts/report_to_google_doc_plan.py
python3 <REPORT_TO_GOOGLE_DOC_SKILL_DIR>/scripts/report_to_google_doc_plan.py \
  /absolute/path/to/report.html \
  --out-dir /tmp/report_to_google_doc_plan_smoke
jq '.status, .summary' /tmp/report_to_google_doc_plan_smoke/preflight_checks.json
test -f /tmp/report_to_google_doc_plan_smoke/report.docx
test -f /tmp/report_to_google_doc_plan_smoke/docx_upload_plan.json
git diff --check -- plugins/data-analytics/skills/build-report/report-to-google-doc
```
