---
name: report-to-google-slides
description: "Narrow conversion skill. Invoke only when the user explicitly asks to convert an existing HTML analytics report into a native Google Slides deck."
---

# Report To Google Slides

Use this skill only when the user explicitly has an existing HTML analytics report and wants a Google Slides deliverable. The output should be a deck, not a pasted report. A stakeholder skimming the slides should understand the answer, evidence,
caveats, and recommended follow-up without opening the source report.

This skill consumes a local portable report, preferably self-contained HTML. If another format is the only source, first create an equivalent local HTML or structured report from the same evidence.

## Workflow

1. Resolve the local HTML report.

   Use an absolute file path. If the user provides a remote report, retrieve it outside this skill first. If the local file is a sign-in page, redirect page,
   or very small stub, stop and obtain the real report before continuing.

2. Run the helper.

   ```bash
   python3 <REPORT_TO_GOOGLE_SLIDES_SKILL_DIR>/scripts/report_to_google_slides.py \
     <LOCAL_HTML_REPORT_PATH> \
     --out-dir /tmp/report_to_google_slides
   ```

3. Inspect local outputs.

   Required outputs:

   - `deck.pptx`: editable local PowerPoint file
   - `manifest.json`: parsed source inventory and coverage counts
   - `deck_plan.json`: slide-by-slide plan with named elements
   - `preflight_checks.json`: local quality checks and pass/fail status
   - `assets/`: rendered chart images

   Do not import the PPTX until `preflight_checks.json` has `status: "passed"`.
   Then run `unzip -t <out-dir>/deck.pptx`.

4. Import and verify in Google Slides.

   Import `deck.pptx` with `mcp__codex_apps__google_drive._import_presentation` using `upload_mode="native_google_slides"`. Verify the imported deck with `_get_presentation_outline` and `_get_slide_thumbnail` for every slide when possible. At minimum, inspect the cover, one chart slide, one table slide,
   and the caveats/sources slides.

5. Repair before handoff.

   If thumbnails show clipped text, missing charts, low contrast, blank images,
   or awkward sizing, revise the helper output or source assumptions and regenerate before handing off the deck URL.

6. Hand off the deck.

   Return the Google Slides URL and, when useful, the local PPTX path or source HTML path. Keep routine check, preflight, thumbnail-inspection, and import-check details in support artifacts. Do not list internal checks in the user-facing handoff unless a check failed, was unavailable, or produced a user-relevant caveat.

## Standards

- Preserve the report's decision-critical information: headline claim,
  executive summary, major findings, metric definitions, material charts,
  decision-critical tables, recommendations, implications, caveats,
  assumptions, freshness notes, and source/provenance notes.
- Translate report prose into slide-native communication. Lead with the takeaway, use one main idea per slide, and put supporting detail in concise callouts, bullets, tables, chart annotations, or speaker notes.
- Tighten copy before shrinking fonts.
- Keep gross metric reads, net/incremental reads, causal claims, and caveats visibly separated when the source report distinguishes those lenses.
- Use editable text and native PPTX tables wherever practical. Use native PPTX bullets; do not fake bullets with typed dashes.
- Preserve source charts as evidence images. Do not screenshot the whole HTML report or paste whole report sections.
- Support self-contained HTML reports whose chart evidence is available as inline SVG, accessible tables, or embedded images; render those into local chart evidence images before building the deck.
- Use one chart per evidence slide unless the report has a stronger grouped comparison.
- Keep table slides legible. If a full table is too dense, keep the main comparison in the deck and move extra detail to speaker notes or source slides.
- Source notes should be visible but quiet.

## Visual System

The helper derives colors and hierarchy from the HTML report CSS and chart palette, then applies a restrained analytics deck layout. It does not follow external deck files or company-specific branding.
