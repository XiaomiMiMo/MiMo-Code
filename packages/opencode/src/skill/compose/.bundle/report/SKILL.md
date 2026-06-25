---
name: compose:report
hidden: true
description: "Use after implementation is verified and before merge — consolidates multiple spec iterations into a single final-state report, marks related specs, and records key lessons"
---

# Writing Final Reports

## Overview

Consolidate a feature's spec history into a single human-readable final report. The report presents the final implemented state as its primary content — what WAS BUILT, not what was tried. A brief Journey Log at the end captures notable failures and pivots for future designers.

**Core principle:** Final state first. The reader should understand the feature from this report alone, without reading any spec.

**Announce at start:** "I'm using the report skill to write the final report for this feature."

**Save reports to:** the `reports/` directory given in the `<compose_docs_dir>` block of your prompt, as `<feature-name>.md`
- No date in filename — the report is overwritten in place when the feature evolves
- Git history tracks revisions
- User preferences for report location override this default

## Update Semantics

Specs are **accumulative** (new file per iteration). Final reports are **overwrite** (same file updated in place):
- If a report already exists for this feature, read it first, then overwrite with updated content
- Append new Journey Log entries from this iteration (don't discard previous entries)
- Update the `specs` and `plans` lists to include any new entries

## When to Use

Standard step after implementation is complete and verified — write a final report summarizing what was delivered.

**Skip when:**
- User explicitly asks to skip the report
- Change is trivially small (single bug fix, typo, config tweak) and not worth documenting

## Checklist

1. **Identify all related specs and plans** — find every iteration of this feature's design in specs/ and plans/
2. **Read the implemented code** — understand what actually shipped (code is truth, not specs)
3. **Draft main sections** — What Was Built, Architecture, Usage, Verification (scale each section to complexity: a few sentences if straightforward, detailed for complex features, but never longer than the plan)
4. **Draft Journey Log** — brief flat bullet list, max 5 items
5. **Assemble report** — combine sections, add frontmatter, save to reports/
6. **Self-review** — verify report against code (not specs), check for placeholders, confirm length is proportional to feature complexity
7. **Mark specs and plans** — prepend NOTE header to each spec and plan file
8. **Commit and transition** — commit report + markers, invoke compose:merge

## Report Document Structure

Every report MUST use this structure:

```markdown
---
feature: <feature-name>
status: delivered
specs:
  - <spec-1-path>
  - <spec-2-path>
plans:
  - <plan-path>
branch: <branch-name>
commits: <first-sha>..<last-sha>
---

# [Feature Name] — Final Report

## What Was Built

[1-3 paragraph executive summary. What does the feature do? What problem
does it solve? Written for first contact — no "v1 tried X" narrative.]

## Architecture

[Final architecture as implemented. Components, boundaries, data flow,
key interfaces. Self-contained — reader needs no spec file.]

### Design Decisions

[Important choices and rationale. Frame as "we chose X because Y" —
never "we tried A, then B, then settled on X".]

## Usage

[How to use/configure/interact. Commands, config options, API surface.
Concrete examples.]

## Verification

[How the feature was verified. Test summary, manual testing, edge cases.]

## Journey Log

> Brief notes on what informed the final design. Not required reading.

- [dead end] Tried X — failed because Y
- [pivot] Switched from A to B after discovering C
- [lesson] Transferable insight here

## Source Materials

| File | Role | Notes |
|------|------|-------|
| `path/to/spec-1.md` | Initial design | See §3 for context on constraint X |
| `path/to/spec-2.md` | Revised after Y | Superseded by this report |
| `path/to/plan.md` | Implementation plan | Complete |
```

## Marking Specs and Plans

For each file listed in `specs` and `plans`, insert this NOTE block between the document title (H1) and the rest of the content:

```markdown
> [!NOTE]
> This document may not reflect the current implementation.
> See the final report for up-to-date state:
> [Final Report](../reports/<feature-name>.md)
```

**Rules:**
- Place between the H1 title and remaining content
- Do NOT move or delete files (git history and links preserved)
- Do NOT modify the body below the marker
- The marker is idempotent (can be re-applied safely)
- Use GitHub-compatible admonition syntax (`[!NOTE]`, not `[!CAUTION]`)

## Writing Guidelines

**Scale to complexity:**
- Simple feature: each main section is 1-2 paragraphs
- Complex feature: detailed sections, but the report should never exceed the plan in length
- If it's getting longer than the plan, you're over-documenting

**"What Was Built" section:**
- Write as if this feature always existed in its current form
- No historical narrative, no "originally we planned..."
- A new team member should understand the feature from this section alone

**"Architecture" section:**
- Derive from CODE, not from specs (specs may have drifted)
- If code and spec disagree, document what the code does
- Include file paths, key types, data flow

**"Design Decisions" section:**
- Only include decisions that would surprise a reader or that have non-obvious rationale
- "We chose X because Y" format — NOT "we tried A, B, C and settled on X"
- If a decision's rationale is obvious from the code, skip it

**"Journey Log":**
- Flat bullet list, max 5 items total
- Each item prefixed with `[dead end]`, `[pivot]`, or `[lesson]`
- Each item is 1-2 sentences
- Only include items that would help a FUTURE designer avoid the same mistakes

## Self-Review Checklist

After assembling the report, check:
1. **Accuracy** — Does the report match the code? (grep key function names, verify file paths exist)
2. **Self-contained** — Can a reader understand the feature without reading any spec?
3. **No placeholders** — No "TBD", "TODO", or "fill in later"
4. **Length proportional** — Not longer than the plan, not shorter than 1 paragraph per section
5. **Journey Log brief** — Max 5 items, each 1-2 sentences

## Key Principles

- **Final state first** — Report describes "what is", not "what was tried"
- **Self-contained** — Reader needs only this report to understand the feature
- **Code is truth** — When specs and code diverge, document what code does
- **Journey is secondary** — Journey Log serves future designers, not understanding
- **Non-destructive** — Specs and plans get soft markers, never deleted or moved
- **Machine-readable** — Frontmatter `specs`/`plans` lists enable tooling
- **Bidirectional** — Report links to specs/plans, they link back to report

## Integration

**Preceded by:** compose:verify (feature must be verified before documenting)
**Followed by:** compose:merge (the terminal workflow step)

After saving the report and marking specs, offer transition:

> "Final report written and committed to `<path>`. Related specs marked. Ready to finish the branch — invoking compose:merge."
