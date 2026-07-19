---
name: enrich-company-and-contact-data
description: "Use for data-first company, contact, lead, and prospect discovery or enrichment, including firmographic or technographic completion, named-company profiling, entity resolution, ICP matching, prospect-list building, segmentation, trigger or sales-signal analysis, market and territory scans, and enrichment-backed comparisons. Exclude meeting preparation, outreach-led company research, and prioritization of an already established account book."
---

# Enrich Company And Contact Data


## Context-Gathering Intake

Whenever this skill asks for context, strongly prefer using the `answers-ask-user-input` skill and the `ask_user_input` tool over other tools such as `request_user_input`; otherwise ask directly in the conversation.

Prepare a sales person with a trusted, decision-ready view of companies or contacts: what is known, what is a strong match, what is still uncertain, and what action the data supports. This skill owns evidence resolution, ICP-fit and coverage comparisons, and source-grounded signal analysis; it does not own rep-work priority, outreach execution, or CRM writes.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to `plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices`.

## Enrichment Ranking

Use this priority order when the request is broad or the working set is ambiguous.

1. Explicit user-provided rows, domains, contacts, companies, ICP criteria, requested fields, or stated ranking rule
2. The named CRM account set, territory, target list, or documented ICP that the user points to
3. Entities that satisfy every hard filter, such as geography, industry, company size, technology, role, or seniority
4. Entities with high-confidence identity resolution and enough comparable evidence to support the requested output
5. Entities with a clear fit implication, reachable buying-team path, or source-grounded external signal
6. Near matches and unresolved entities, clearly separated from qualified results

Do not silently broaden a supplied list into discovery, merge ambiguous entities, or rank by a criterion the user cannot inspect.

If the user asks to score or tier a list, keep the judgment limited to ICP fit, enrichment completeness, identity confidence, or defined signal strength. If the user asks which accounts to work now, where to focus, or what rep action deserves priority, route to `prioritize-accounts`.

## Key Dependency Categories

These are particularly important for this workflow; use your best judgment to potentially include other data sources to improve quality.

- [Blocking] ~~Sales Intelligence for company/contact discovery, firmographics, technographics, intent, lookalikes, and provider-native signals. It blocks discovery, contact discovery, lookalikes, intent, and provider-native enrichment when equivalent requested data is not already grounded.
- ~~CRM for account identity, customer status, ownership, lifecycle stage, opportunity context, and duplicate resolution
- ~~Knowledge & Files for ICP definitions, territory rules, target lists, segmentation rules, and enrichment conventions
- User-provided rows, CSVs, exports, domains, emails, and ICP notes when they already define the work
- Public research only for narrow validation or gaps that configured sources cannot answer

Start with the category that owns the requested fields, then attempt only additional categories that materially improve coverage, identity confidence, or the decision. If a material category is unavailable, stale, conflicting, or provider-limited, state the limitation and its impact on coverage or confidence.

## Workflow Guidance

These enrichment-specific steps modify the corresponding default workflow stages in the index skill. Continue the remaining default stages, including the first output and proposed next steps.

- 1. Clarify and Gather Context
    - Resolve the smallest useful mode, entity scope, task shape, requested fields, ranking rule, and result limit.
    - If the anchor is ambiguous, make at most two narrow source calls to surface concrete candidates, then ask the user to choose before deeper enrichment. When two or three concrete modes, entities, or candidates are available, use `ask_user_input()`; otherwise ask one narrow text question.
- 2. First Draft
    - Start from the user-defined working set or the canonical source for the request, then retrieve only evidence that materially improves the result.
    - When the selected connected Sales Intelligence provider is ZoomInfo, load `zoominfo` before provider-specific search, enrichment, intent, similarity, or recovery. When it is Apollo, load `apollo`; apply Apollo v2-specific guidance only after verifying app version 2 or later.
    - For broad discovery, search before heavy enrichment and enrich only the final shortlist unless the user explicitly asks for exhaustive treatment.
    - Verify hard filters before calling a row qualified. Put close but unsupported candidates in Near Matches, Unclear, or Excluded.
    - Render the smallest useful table or shortlist, with field-level clickable source links, confidence, and visible gaps.

## Overall Rules

- Cite sourced claims with hyperlinks whenever links are available. If a source cannot provide a link, name the source and the limitation.
- CRM owns internal account truth; enrichment providers own provider-native external fields; user-provided records define the working set unless the user asks for discovery.
- Use Sales Intelligence for provider-native discovery, contact discovery, lookalikes, and signal scans; use CRM for existing customers, ownership, lifecycle stage, opportunity context, and named CRM lists; use Knowledge & Files for named ICP, territory, target-list, or segmentation rules that are not supplied.
- Do not use indirect or mirrored sources, broad web search, or Computer Use as substitutes for the authoritative category.
- Keep sourced facts separate from `Inference:`. Never invent emails, phones, titles, technologies, funding, hiring signals, intent, or missing fields.
- Do not claim exhaustive coverage from a bounded query. Keep provider limits, weak matches, and missing lanes visible.
- Do not update CRM, execute outreach, create records, or send messages in this workflow. If the user wants a CRM change, prepare the proposed field updates and require explicit approval before a separate write action.

## Output Contract

Every mode must include a compact `## Sources & Coverage` section before proposed next steps:

- **Used:** [Linked source or source label] — [fields, rules, or signals it supplied]
- **Unavailable or limited:** [Material category or provider gap] — [impact on confidence or coverage]
- **Coverage:** [Working set, query bound, or whether the result is exhaustive]

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Export the results to a spreadsheet with the visible evidence, confidence, and unresolved fields preserved.
- Prepare reviewed updates to the source of truth, such as CRM records, for missing or corrected fields.
- Verify near matches, ambiguous identities, or the smallest material coverage gap.
- Refine the filters, ICP rule, requested fields, or result limit using the user's guidance.
- Hand a qualified shortlist to account prioritization or company research when the user wants the next selling action.

Next steps to avoid:
- Executing outreach, silently broadening the working set, or updating CRM without explicit approval.

## Modes

### 1. Enrich Provided Records

- Use when the user supplies companies, contacts, domains, emails, rows, a CSV/export, or a CRM-backed list and wants missing fields completed or cleaned.
- Preserve the full supplied set, normalize obvious duplicates, and surface identity ambiguity instead of silently dropping or merging rows.
- Use CRM for customer/account truth when available, then enrich requested external fields.

#### Output Format

```md
# Enrichment Results

| Input Record | Resolved Entity | [Requested Field] | [Requested Field] | Confidence / Notes | Missing Or Unresolved |
| --- | --- | --- | --- | --- | --- |
| [Original input] | [Matched company/contact + source link] | [Grounded value + source link] | [Grounded value + source link] | [High/Medium/Low + reason] | [Gap or ambiguity] |

## Key Readout

- [Most useful pattern or implication]
- [Important source gap, duplicate, or weak match]
- [Recommended next check or action]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

### 2. Discover Companies Or Contacts

- Use when the user asks for new companies, contacts, likely buyers, decision makers, lookalikes, or ICP matches.
- Start from explicit search criteria or seed companies. Return only qualified matches as clean hits and keep near matches separate.
- For contacts, verify role, seniority, and company assignment before recommending a person.

#### Output Format

```md
# Qualified Matches

| Company / Contact | Why It Fits | Key Evidence | Confidence | Source |
| --- | --- | --- | --- | --- |
| [Entity] | [Hard criteria satisfied] | [Compact grounded evidence] | [High/Medium/Low] | [Clickable link] |

## Near Matches

- [Entity] — [Why it is close but not qualified]

## Gaps / Caveats

- [Coverage, provider, identity, or source limitation]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

### 3. Compare, Segment, Or Scan Signals

- Use when the user asks to compare a bounded set, score or tier a list, or find entities matching a defined external signal.
- Keep the visible comparison, tiering rule, or signal/proxy definition in the output so the user can inspect the judgment.
- Do not convert a weak proxy into a stronger claim.

#### Output Format

```md
# [Comparison / Segmentation / Signal Scan]

| Entity | [Comparison Field Or Tier] | Evidence / Signal | Confidence | Source | Notes |
| --- | --- | --- | --- | --- | --- |
| [Entity] | [Grounded value or visible tier] | [Observed signal or rationale] | [High/Medium/Low] | [Clickable link] | [Gap or caveat] |

## What Is Still Unclear

- [Missing field, unsupported ranking input, or next verification step]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```
