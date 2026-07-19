# Semantic Layer Skill Template

Use this reference when drafting the generated semantic-layer skill. The target skill should be small enough to load quickly and should route detailed data knowledge into references.

## Recommended File Shape

```text
<skills-root>/
  <area>-semantic-layer/
    SKILL.md
    references/
      source-inventory.md
      semantic-layer.md
      evidence.md
```

Use more reference files only when the area is large enough to justify them, such as `metrics.md`, `tables.md`, `query-patterns.md`, or `gotchas.md`.

For multiple product or business areas, create one folder per area. Keep shared source links or cross-skill references explicit rather than merging unrelated semantics into one large skill.

## Target SKILL.md Shape

```markdown
---
name: <area>-semantic-layer
description: Use when answering data questions for <area>, including metric definitions, table choice, joins, dashboard reconciliation, freshness, and known caveats.
---

# <Area> Semantic Layer

Use this skill to answer <area> data questions with the source-backed context in `references/semantic-layer.md`.

## Start Here

1. Read `references/semantic-layer.md`.
2. Use the listed canonical metrics, tables, grains, joins, filters, and caveats.
3. Check freshness before answering time-sensitive questions.
4. When sources disagree or coverage is weak, say so and verify against the cited source.

## References

- `references/semantic-layer.md`: metrics, tables, filters, query patterns, gotchas, freshness, and open questions.
- `references/source-inventory.md`: sources checked, coverage level, permissions, rejected candidates, and update boundaries.
- `references/evidence.md`: detailed provenance, only when the layer needs separate evidence tracking.

## Answering Rules

- Treat this skill as source-selection guidance, not as a substitute for live reads.
- Preserve metric grain, time zone, date columns, filters, and join keys.
- Do not let a saved delivery preference broaden the current request. In particular, a data question answered with SQL is not an SQL-delivery request; include source SQL in the visible response only when the user explicitly asks to see, write, review, debug, or receive SQL or query methodology.
- Label stale, inferred, partial, or conflicted evidence.
```

## semantic-layer.md Shape

```markdown
# <Area> Semantic Layer

## Quick Reference

- Area:
- Intended users:
- Coverage level:
- Source inventory: `references/source-inventory.md`
- Last synthesized:
- Freshness expectations:
- Default date and time zone rules:

## Entity Clarification

Use this section to disambiguate names that future agents may confuse.

| Entity | Means | Does Not Mean | Primary IDs | Grain Notes | Sources |
| --- | --- | --- | --- | --- | --- |

## Key Metrics

| Metric | Definition | Numerator | Denominator | Time Grain | Canonical Source | Caveats |
| --- | --- | --- | --- | --- | --- | --- |

## Standard Filters And Dimensions

| Filter Or Dimension | Default Logic | Override When | Applies To | Sources |
| --- | --- | --- | --- | --- |

## Key Tables

| Table | When To Use | Grain | Join Keys | Freshness | Caveats | Sources |
| --- | --- | --- | --- | --- | --- | --- |

## Query Patterns

- Pattern:
  - Use when:
  - Key tables:
  - Required filters:
  - Common joins:
  - Example skeleton:

## Gotchas

- Gotcha:
  - Impact:
  - How to avoid:
  - Source:

## Related Dashboards And Docs

| Source | Use It For | Caveats |
| --- | --- | --- |

## Open Questions

- Question:
  - Why it matters:
  - Best owner or source to check next:
```

## evidence.md Shape

Create `references/evidence.md` only when separate evidence tracking is useful, such as conflicting sources, multiple high-stakes metrics, or a large crawl. Small layers may keep source pointers directly in `references/semantic-layer.md`.

```markdown
# Evidence Register

| Fact Or Claim | Source Type | Source Link Or Path | Retrieved Or Observed | Confidence | Notes |
| --- | --- | --- | --- | --- | --- |
```

## source-inventory.md Shape

Create `references/source-inventory.md` whenever the workflow creates or drafts a target semantic-layer skill package. Intake-only runs may return the same inventory in chat without creating the file.

```markdown
# Source Inventory

## Coverage

- Coverage level:
- Sources checked:
- Missing high-value lanes:
- Rejected or lower-confidence candidates:

## Sources

| Source | Type | Locator | Connector Or Tool | Permission Status | Last Checked | Supports | Gaps Or Caveats | Automation Eligible | Update Boundary |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
```

Use `Sources checked`, `Missing high-value lanes`, and `Rejected or lower-confidence candidates` as the pre-save source-use checkpoint. Use `Automation Eligible` to distinguish sources the weekly automation can poll directly from sources that require manual export, one-off permission, or user review. Use `Update Boundary` to say whether the automation may update semantic-layer references automatically, must draft a proposed update, or must only report changes.

## Drafting Rules

- Put durable semantic facts in the generated skill's references, not in chat-only prose.
- Keep `SKILL.md` operational and short; move table catalogs, metric dictionaries, query examples, and evidence into references.
- Do not put setup-time policy or full evidence procedures into generated `SKILL.md` files; keep those guardrails in the setup flow and validators.
- Keep the source inventory current enough that a weekly polling automation can determine what to check and what update boundary applies.
- Use source links, file paths, dashboard IDs, table names, and repo paths as provenance.
- Label stale, inferred, query-history-only, or team-communication-only facts.
- Preserve unresolved conflicts as explicit open questions.
- Avoid raw sensitive data, credentials, long message quotes, and copied dashboard exports.
