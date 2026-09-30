---
name: report-to-pdf
description: "Narrow conversion skill. Invoke only when the user explicitly asks to convert an existing Data Analytics report, dashboard, or inline chart export into a PDF artifact."
---

# Report To PDF

Use this skill only when the user explicitly needs a PDF from an existing Data Analytics report, dashboard, or chart artifact. Prefer a static HTML export or another portable report file as the source.

The expected path is static HTML -> browser headless print-to-PDF -> PDF verification. If only a non-portable source exists, create or retrieve the matching static HTML/export source first.

## Workflow

1. Resolve the static source.

   Use an absolute local path to a static HTML report/export or a local URL served from that static export. If the source is a blob stub, sign-in page, redirect page, incomplete viewer, or an app shell that contains boot scripts but not the report content, stop and obtain a static HTML/export source before continuing.

   When the user provides a hosted artifact URL, first determine whether it exposes a usable static export or package source. If the static export is unavailable but the validated artifact payload is still available in the current run, create the matching static HTML/export from that payload and preserve source provenance in the handoff. If neither a static export nor the artifact payload is available, stop with a blocker instead of printing the live app shell or rebuilding the report from memory.

   When creating or repairing the static source, keep visible metadata reader-facing. Do not copy internal artifact runtime fields, package plumbing, or validator/debug state into the report body, header, footer, or source section. For example, omit raw labels such as snapshot status, package path, widget type, manifest path, renderer IDs, validation status, and local temp paths from the visible PDF. If a runtime detail matters for audit or troubleshooting, preserve it in support notes rather than the visible PDF. Translate data-state caveats into reader language only when they affect interpretation, such as "synthetic demo data" or "partial source coverage."

2. Generate the PDF with Chrome CLI headless print-to-PDF.

   Use the platform-specific Chrome executable available in the environment. Common examples are `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS and `google-chrome`, `chromium`, or `chromium-browser` on Linux. This is the primary conversion method because it prints the static HTML with a browser rendering engine and usually preserves selectable text, layout, charts, tables, and print CSS.

   ```bash
   chrome \
     --headless=new \
     --disable-gpu \
     --no-first-run \
     --no-default-browser-check \
     --no-pdf-header-footer \
     --print-to-pdf=/absolute/path/to/report.pdf \
     /absolute/path/to/report.html
   ```

3. If Chrome is unavailable or cannot produce a valid PDF, use a renderer-backed fallback.

   Use the next available local mechanism that renders the same static HTML/export source and prints or saves that rendered page to PDF. Keep the fallback tool-agnostic: the requirement is faithful HTML rendering followed by PDF output, not a specific implementation. Do not replace this with a model-authored PDF layout, manually redrawn charts, or a report reconstructed from memory.

   A fallback is acceptable only when:

   - the static HTML/export remains the source of truth
   - the rendered output preserves the report title, narrative, charts, tables, caveats, and source details
   - app-only controls are omitted
   - the resulting PDF passes the same verification checks as the primary Chrome path

   If no available local renderer can print the static HTML/export faithfully, stop and report the blocker with the missing capability and the source file that could not be converted.

4. Verify the PDF itself.

   Confirm page count and metadata with `pdfinfo` or equivalent. Extract text with `pdftotext` or equivalent when the PDF should contain selectable text. Render representative pages with `pdftoppm` or equivalent and inspect them for blank charts, clipped content, missing source details, unwanted controls, internal runtime metadata, and layout regressions. For short reports, render every page. Include a negative check for app-only control labels such as share, edit, refresh, publish, toolbar, menu, and drag affordances, plus internal artifact labels such as snapshot status, widget type, manifest path, package path, validation status, and local temp paths.

5. Repair before handoff.

   If the output is blank, clipped, missing charts, missing source details, or includes app-only chrome, fix the static HTML/export source, print stylesheet, or renderer invocation and regenerate. Do not hand off an unverified PDF unless the user explicitly accepts the limitation.

6. Hand off the PDF.

   Return the PDF path and, when useful, the source HTML path or URL. Keep routine check details in support artifacts. Do not list internal checks in the user-facing handoff unless a check failed, was unavailable, or produced a user-relevant caveat. If the static HTML/export had to be created from an artifact payload because the hosted URL did not expose one, say that briefly. If required checks could not be completed, state the gap clearly.

## Standards

- Preserve the reader-facing artifact content: title, narrative, charts, tables, caveats, source details, and generated-at or source freshness details when present.
- Omit app-only controls: top bars, share menus, edit controls, refresh controls, drag handles, hover-only menus, and interactive-only affordances.
- Omit internal artifact and conversion metadata from the visible PDF. Do not show raw runtime fields, implementation state, package labels, local paths, validator/debug labels, or status strings that exist only to operate the app or export pipeline. Keep audit-useful internals in support files, and use plain reader-facing caveats in the PDF when a data state affects interpretation.
- Prefer a text PDF with selectable/searchable text. Use a screenshot/image PDF only when a faithful text PDF is not viable, and state that text may not be selectable or searchable.
- Keep the static source as the PDF source of truth. Do not reconstruct the report from memory when a source HTML/export exists.
- Do not create a model-authored PDF from scratch as a normal fallback. Direct PDF construction is acceptable only as an explicitly labeled last-resort workaround after the user accepts the quality limitation.
- Keep generated PDF support files together when possible: static HTML source, PDF output, extracted text, page previews, and any notes about source retrieval or renderer fallback.

## Verification Guidance

Before handoff, verify the PDF with the local tools available in the environment:

- Confirm the PDF exists, is non-empty, and has the expected page count and page size.
- Confirm text is selectable/searchable when a text PDF is expected.
- Render or preview representative pages; for short reports, prefer checking every page.
- Inspect for blank pages, clipped charts, missing tables, missing source details, unwanted app controls, and leaked internal artifact or conversion metadata.
- If the skill file itself was edited, run the repository's normal markdown or diff checks.

Examples when available: `pdfinfo`, `pdftotext`, `pdftoppm`, file-size checks, and `git diff --check`.
