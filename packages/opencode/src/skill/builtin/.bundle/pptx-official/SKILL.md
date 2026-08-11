---
name: pptx-official
description: "Use this skill whenever a Microsoft PowerPoint (.pptx) file is being produced, opened, transformed, or read. That includes: authoring slide decks, pitch decks, executive readouts, training material, or any presentation deliverable; extracting text or structure from an existing .pptx; filling a .pptx template with values; converting a deck to PDF or images; splitting or merging decks; inspecting slides, layouts, masters, tables, images, charts, speaker notes, or comments. Trigger on words like 'deck', 'slides', 'presentation', 'pitch deck', 'keynote' (when a .pptx is expected as output), or any filename ending in .pptx. Do NOT trigger when the primary deliverable is a Word document, spreadsheet, PDF report, HTML site, or Google Slides API call, even if presentation-shaped content appears along the way."
license: Apache-2.0 — see LICENSE for terms and third-party attributions
---

# PPTX Skill

An Apache-2.0 toolkit for producing, editing, and reading Microsoft PowerPoint
(`.pptx`) files. Written from scratch against the public
[ECMA-376 / ISO/IEC 29500 (PresentationML)](https://www.ecma-international.org/publications-and-standards/standards/ecma-376/)
specification and built on permissively-licensed tooling (`python-pptx` MIT,
`pptxgenjs` MIT, `lxml` BSD-3-Clause, `Pillow` MIT-CMU, optional external
binaries `soffice` MPL 2.0 and `pdftoppm` GPL) so it can be reused in
commercial projects without restriction.

## Decision matrix

| Situation | Path | Read first |
|-----------|------|------------|
| Build a deck from a prompt or dataset — no source file to start from | Author with `python-pptx` (structured / repeatable) or PptxGenJS (design-heavy, JS) | [`create.md`](create.md) |
| You have a `.pptx` template to fill in — keep its master, layouts, look | Placeholder replacement via `python-pptx` | [`edit.md`](edit.md) → *Template fill* |
| Deep structural edits — reorder slides, splice XML, add unusual objects | Explode → edit XML parts → assemble | [`edit.md`](edit.md) → *Raw XML workflow* |
| Only need the text / speaker notes / structure out of a `.pptx` | Extraction pipeline | [`read.md`](read.md) |
| Turn a deck into PDF or PNG images (visual QA, publishing) | `scripts/render_pdf.py` / `scripts/render_slides.py` via LibreOffice | see *QA* below |
| Grid of slide thumbnails for previewing a template | `scripts/contact_sheet.py` (Pillow) | [`read.md`](read.md) → *Thumbnails* |

If the task mixes several of these, do them in this order:
**read → plan slide-by-slide → edit/create → validate → visual QA.**

## One-time environment setup

> **Bundled runtime:** when the `MIMO_PYTHON` environment variable is set, skip `uv`/pip installs — run every Python command below with `uv run` replaced by `"$MIMO_PYTHON"` (python-pptx/Pillow/lxml preinstalled; pip console scripts unavailable, use `"$MIMO_PYTHON" -m <module>`). A bundled LibreOffice is exposed as `MIMO_SOFFICE` (picked up automatically by `soffice_bridge.py`/`render_pdf.py`), and slide rasterisation automatically falls back to pypdfium2 in that interpreter when Poppler (`pdftoppm`) is absent. For the PptxGenJS authoring path, bundled Node.js is exposed as `MIMO_NODE`, with pptxgenjs/react/react-dom/sharp/react-icons/mathjax-full preinstalled in `MIMO_NODE_MODULES` — run scripts as `NODE_PATH="$MIMO_NODE_MODULES" "$MIMO_NODE" <script.js>` instead of `npm install`.

### Prerequisites

If `uv` or `bun` are not yet installed:

```bash
# Install uv (Python package/project manager)
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
# Windows: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Install bun (TypeScript runtime, replaces Node.js for this workflow)
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
# Windows: powershell -c "irm bun.sh/install.ps1|iex"
```

Only if the user explicitly refuses `uv` / `bun`, substitute `pip` (in a venv you manage yourself) for `uv`, and `npm`/`pnpm` + `npx tsx` for `bun` — everything else in this skill stays the same.

### Python (uv)

Python dependencies are managed by `uv`. Do not use `pip` directly.

```bash
# Initialize project (if no pyproject.toml exists)
uv init -p 3.12

# Add dependencies
uv add python-pptx lxml Pillow
uv add defusedxml                  # safe XML parsing (recommended for manual XML edits)
```

**Rules:**
- Never use `pip` — always `uv add` for packages.
- Never run `python scripts/...` directly — always `uv run scripts/...`.
- Don't manually manage environments with `python -m venv` or `source .venv/bin/activate`.

### TypeScript (bun)

For PptxGenJS creation, use `bun` (project-local, not global installs):

```bash
# Initialize (if no package.json exists)
bun init -y

# Add dependencies
bun add pptxgenjs                  # core PPTX creation library
bun add react react-dom sharp      # rasterization (icons + formulas)
bun add react-icons                # icon library (FA, MD, etc.)
bun add mathjax-full               # LaTeX formula rendering

# Type definitions (including Bun runtime types)
bun add -d @types/bun @types/react @types/react-dom
```

Create a `tsconfig.json` if one doesn't exist:
```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun"]
  }
}
```

Run scripts directly as TypeScript — no transpilation needed:
```bash
bun run create-ppt.ts
```

**Always run type checking after writing or modifying TS code:**
```bash
bun tsc --noEmit
```
Models may inadvertently use outdated PptxGenJS API signatures or
deprecated syntax without realizing it. A type check catches these
mismatches before runtime.

### System dependencies (PDF/PNG rendering)

```bash
# macOS
brew install --cask libreoffice
brew install poppler

# Debian/Ubuntu
sudo apt-get install -y libreoffice poppler-utils
```

Every script under `scripts/` uses only the standard library plus
`python-pptx`, `lxml`, and `Pillow`. No proprietary dependencies. External
binaries (`soffice`, `pdftoppm`) are invoked as subprocesses; nothing is
bundled or statically linked.

## Common commands

```bash
# 1. Extract text from every slide (title, body, notes) — the "what does it say?" query
uv run scripts/dump_text.py input.pptx --notes > input.txt

# 2. Convert a deck to PDF for review
uv run scripts/render_pdf.py input.pptx                     # writes input.pdf next to it

# 3. Convert every slide to a PNG (visual QA)
uv run scripts/render_slides.py input.pptx --out slides/       # writes slides/slide-1.png, ...

# 4. Grid thumbnail preview (planning which template slide to reuse)
uv run scripts/contact_sheet.py input.pptx --cols 3         # writes input.contact-sheet.jpg

# 5. Explode a .pptx into readable XML for surgical edits
uv run scripts/explode.py input.pptx unpacked/

# 6. Reassemble an exploded tree
uv run scripts/assemble.py unpacked/ output.pptx

# 7. Drop orphaned slides and unused media before reassembly
uv run scripts/prune.py unpacked/

# 8. Duplicate slide 3, or spin up a new slide from layout 5
uv run scripts/insert_slide.py unpacked/ --clone slide3.xml
uv run scripts/insert_slide.py unpacked/ --blank-from slideLayout5.xml

# 9. Well-formedness check (ZIP + XML + python-pptx round-trip)
uv run scripts/diagnose.py output.pptx
```

Every script is a small Python CLI. Some scripts (e.g. `render_pdf.py`,
`render_slides.py`, `contact_sheet.py`) import from a shared helper
(`soffice_bridge.py`) in the same directory — copy them together. Read the top
of each file for its full CLI options.

## Live preview

A live preview server is available for real-time slide feedback.
**Not started by default.** When multi-slide work begins, ask the user
if they want live preview enabled.

**Only offer this in a pure command-line environment.** This server is
for the MiMoCode CLI. If you are running inside a host that embeds
MiMoCode via the SDK — a web UI, a desktop app, an IDE plugin, etc. —
that host almost certainly has its own native preview / file-open
mechanism; use it instead and do NOT start this server.

If yes, and this is a CLI environment:

```bash
# `scripts/preview.ts` lives in this skill's bundle directory, not in
# your cwd. Prefix it with the absolute path shown in this skill's
# location header (the folder that contains SKILL.md) — refer to it
# as <SKILL_DIR> below.

# Start (spawns background server, prints URL, exits immediately)
bun run <SKILL_DIR>/scripts/preview.ts /path/to/output.pptx
bun run <SKILL_DIR>/scripts/preview.ts /path/to/output.pptx --port 5000

# Stop
bun run <SKILL_DIR>/scripts/preview.ts --stop /path/to/output.pptx
```

If the server is already running, `preview.ts` detects this via PID file
and prints the existing URL instead of spawning a duplicate.

The background server watches the `.pptx` file, debounces (800ms),
converts to PDF via LibreOffice, and pushes a WebSocket reload to the
browser. The browser's native PDF viewer provides scroll, thumbnails,
zoom, and search. Preview output goes to `.pptx-preview/` (separate
from `qa/`, no conflict with other scripts).

Give the user the printed URL to open in their browser.

**Live preview is for humans only — it does NOT replace visual QA.**
The preview server lets the user watch progress. You must still run
the visual QA subagent (render PNGs to `qa/`, spawn a vision model to
inspect them) as described in the "Visual QA execution model" section.
These are independent workflows:
- Preview server → user sees live updates in browser
- Visual QA subagent → automated inspection, catches issues you can't

**When to regenerate the .pptx during multi-slide work:** If the user
has the preview server running, regenerate the `.pptx` (re-run the
creation script) after completing each logical module — e.g. after
finishing a section's slides, not after every single shape placement.
This gives the user meaningful visual checkpoints without excessive
intermediate renders.

## Authoring principles

Slides are a **visual surface**. Users read the deck at 40 feet from the back
of a room, or in a browser tab three inches wide on a phone. Both have to
work. Keep these in mind:

1. **One idea per slide.** If you can't summarize the slide in a five-word
   title, split it in two. Long-form reasoning belongs in the doc that
   accompanies the deck, not on the slide itself.
2. **Title, not label.** The title is the thesis of the slide. "Revenue" is a
   label. "Revenue grew 34% on 22% headcount" is a title. Titles carry the
   argument; bodies carry the evidence.
3. **Every slide earns its visuals.** A slide without a chart, image, icon,
   or shape is usually a bullet dump. Turn it into a comparison, a stat
   callout, a diagram, or delete it.
4. **Layouts, not per-slide geometry.** For anything reused (section
   dividers, content pages, quote slides), define a `slide_layout` once and
   apply it. This makes swapping the theme a one-line change instead of a
   fifty-slide sweep.
5. **Aspect ratio matches the target.** 16:9 (default) for laptops and
   projectors; 4:3 only when explicitly asked (still common in academia and
   some corporate templates); 16:10 for older widescreen.
6. **Speaker notes carry the words.** Put the full narration into
   `slide.notes_slide.notes_text_frame` so the presenter can rehearse from
   the deck itself. On the slide, keep it to the phrase they can hold in
   their head.
7. **Bullets are not the default.** Bullet lists are the failure mode of
   most decks — comparisons, tables, icons-with-labels, and stat callouts
   almost always land better.

## Typography defaults (safe starting point)

| Element              | Font          | Size    | Weight  | Notes |
|----------------------|---------------|---------|---------|-------|
| Slide title          | Calibri / Segoe UI | 32-40pt | Bold    | One line — wrap = rework the title |
| Section header       | Calibri       | 24-28pt | Bold    | On dedicated divider slides |
| Body / bullets       | Calibri       | 18-22pt | Regular | Never below 18pt for a room; 14pt for on-screen decks |
| Stat callout         | Calibri Light | 60-96pt | Bold    | The number, then the label below at 14-18pt |
| Caption / footer     | Calibri       | 10-12pt | Regular | Muted gray `#7A7A7A` |
| Code / mono          | Consolas / Cascadia Code | 16-20pt | Regular | Left aligned, no word wrap |

Change the palette for the topic (financial → navy `#1F3A5F`; environment →
forest `#2C5F2D`; product launches → your brand's accent). Avoid pure black
on pure white for backgrounds — `#F7F5F0` cream on `#1F1F1F` ink reads
softer under a projector.

## Slide sizes

| Aspect | Width × Height (inches) | Pixels @ 96 DPI | When to use |
|--------|-------------------------|------------------|-------------|
| 16:9 widescreen (default) | 13.333 × 7.5    | 1280 × 720       | Almost every new deck |
| 16:10                      | 13.333 × 8.333  | 1280 × 800       | Older projectors; some corporate templates |
| 4:3 standard               | 10.0   × 7.5    | 960  × 720       | Academia, legacy templates, printed handouts |
| A4 landscape               | 11.69  × 8.27   | 1123 × 794       | Print-first decks (EU) |
| Letter landscape           | 11.0   × 8.5    | 1056 × 816       | Print-first decks (US) |

## QA checklist — always run before declaring done

**Assume something is wrong.** PowerPoint opens broken files quietly: a
misaligned text box, a chart pointing at deleted data, a stray placeholder
that survived template fill. Verify explicitly.

1. **Opens cleanly.** No repair dialog, no missing-part warning.
   ```bash
   uv run scripts/diagnose.py output.pptx
   ```

2. **Text integrity.** No placeholder residue and no unfilled `{{token}}`s:
   ```bash
   uv run scripts/dump_text.py output.pptx --notes \
       | grep -Ei "\{\{|TODO|TBD|lorem|ipsum|xxxx|click to add"
   ```
   Grep must return nothing.

3. **Visual sanity.** Render the whole deck to PNG, spot-check the first,
   last, and any slide you touched. Look for:
   - Text overflowing the placeholder or getting auto-shrunk past readability.
   - Two shapes overlapping (title over image, footer over content).
   - Legend / axis labels cut off on charts.
   - Icons at the wrong scale (tiny hairline icons, or huge stretched ones).
   - Off-brand colors that snuck in from a copied slide.
   ```bash
   uv run scripts/render_slides.py output.pptx --out qa/
   ```

4. **Layout hygiene.** Every non-master slide should reference a real layout,
   not `slideLayout1` by default for a section divider:
   ```bash
   uv run python -c "
   from pptx import Presentation
   prs = Presentation('output.pptx')
   for i, s in enumerate(prs.slides, 1):
       print(f'slide {i}: layout={s.slide_layout.name!r}')"
   ```

If any of these fail, fix and re-run — don't paper over.

## Visual QA execution model

**Slide images are expensive.** A single rendered PNG at 150 DPI consumes
thousands of context tokens. Loading multiple slides into the main
conversation for inspection will quickly exhaust your context budget and
crowd out useful working memory.

**Default: always use a subagent for visual inspection.** Spawn a
`general` subagent with the rendered PNG paths and the
inspection criteria from step 3 above. The subagent reports findings as
text (slide number + issue description); the images never enter the main
conversation context. This is mandatory unless the exception below applies.

```
actor({
  operation: {
    action: "run",
    subagent_type: "general",
    // omit `model` when your current model is vision-capable (preferred — see Model selection)
    description: "Visual QA slides",
    prompt: "Inspect the rendered slide images in qa/ for: text overflow, overlapping shapes, cut-off labels, wrong-scale icons, off-brand colors. Report each issue as 'slide N: <problem>'. Images: qa/slide-1.png through qa/slide-<N>.png."
  }
})
```

**Model selection (in priority order):**

1. **Prefer the user's current model.** Query the servable vision models via
   `actor({ operation: { action: "models", vision: true } })`. If your current
   model is in the list, **omit the `model` parameter** — the subagent inherits
   it, and visual QA runs on the model the user chose.
2. **Fallback: lightweight vision model, stated explicitly.** If your current
   model is not vision-capable, pick a **lightweight** vision model from the
   query result (haiku/flash/lite-class if present, otherwise the cheapest
   listed) and **tell the user in your reply** which model you used for visual
   QA and why (current model cannot inspect images).
3. **No vision model available.** If the query returns an empty list, do not
   guess a model id — skip the visual QA subagent, run the structural checks
   only, and tell the user visual inspection could not be performed.

**Never hardcode a model id.** Which models are servable varies per
deployment and changes over time; only ids returned by the vision models
query are guaranteed to work. A guessed id fails the subagent outright.

**Exception — direct inspection in the main context:** Only load slide
images directly (without a subagent) when the user explicitly requests
that the current model inspect a specific slide for fine-grained,
interactive editing (e.g. "look at slide 5 and adjust the title
position"). This requires the current model to be multimodal. If it
isn't, inform the user and offer to spawn a vision subagent instead.

## Common visual pitfalls

- **Titles wrap onto two lines** — either shorten the title or widen the
  placeholder. Wrapped titles push body content down and break layout
  alignment across slides.
- **Body text auto-shrinks below 14pt** — python-pptx respects the
  placeholder's autofit setting; if the resulting size is unreadable, split
  the slide instead of accepting the shrink.
- **Charts inherit Office defaults** — the pale blue / gray palette shipped
  with PowerPoint looks generic. Explicitly set `chart.chart_style` or use
  `python-pptx`'s low-level access to set fill colors on series.
- **Speaker notes forgotten** — a deck without notes cannot be rehearsed.
  Fill `notes_slide.notes_text_frame.text` on every slide, even if just a
  single sentence.
- **Images at wrong DPI** — a 4000×3000 photo on a 1280×720 slide bloats
  the file with no visual benefit. Resample down to ~150 DPI at the target
  display size (see `create.md` → *Images*).
- **Fonts not embedded** — `python-pptx` does not embed fonts. If the deck
  is opened on a machine without the chosen font, PowerPoint substitutes,
  and layout drifts. For **Latin** text, prefer system-safe fonts (Calibri,
  Arial, Segoe UI, Times New Roman, Consolas) or ship the .pptx alongside a
  font install step.
- **CJK text needs the East-Asian font slot** — `run.font.name` only sets the
  Latin typeface (`a:latin`); Chinese / Japanese / Korean glyphs come from the
  East-Asian slot (`a:ea`), which python-pptx does not expose. Leave it unset
  and CJK renders as tofu boxes or an inconsistent substitute. Set `a:latin` +
  `a:ea` + `a:cs` to a CJK-capable font on every run that contains CJK text
  (recipe in `create.md` → *CJK / East-Asian text*).

## What is out of scope

- **`.ppt` (PowerPoint 97-2003 binary)**. Convert first:
  `soffice --headless --convert-to pptx old.ppt`.
- **VBA / macros / `.pptm`.** This skill does not emit or execute macros.
- **Password-protected or encrypted decks.** `python-pptx` cannot read
  encrypted files; strip protection with PowerPoint or LibreOffice first.
- **Live PowerPoint automation.** For COM (Windows) or AppleScript (macOS)
  integration, use a dedicated automation library — this toolkit is
  file-in / file-out.
- **Keynote `.key` files.** Not a PresentationML format; use Apple's
  Keynote or LibreOffice for round-trip.

## Where each detail lives

- **Creating from scratch**: [`create.md`](create.md) — python-pptx recipes,
  PptxGenJS recipes, layouts, text, tables, images, charts, icons,
  backgrounds, speaker notes, palette and typography guidance.
- **Editing / templating**: [`edit.md`](edit.md) — placeholder fill, slide
  duplication / reorder / delete, explode/assemble for XML surgery, comments,
  cleanup of orphaned parts, common pitfalls.
- **Reading / extracting**: [`read.md`](read.md) — plain-text export
  (including speaker notes), structural walk, metadata, thumbnails, image
  extraction, conversion to PDF / PNG for QA.
- **Scripts**: [`scripts/`](scripts/) — CLI utilities (some share a local
  `soffice_bridge.py` helper; copy together when extracting).
- **Live preview**: [`scripts/preview.ts`](scripts/preview.ts) — launcher
  (start/stop); [`scripts/preview_server.ts`](scripts/preview_server.ts) —
  background server that watches .pptx, converts to PDF, serves with
  WebSocket hot-reload in the browser's native PDF viewer.
