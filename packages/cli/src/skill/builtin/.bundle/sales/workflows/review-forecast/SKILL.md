---
name: review-forecast
description: Use when the user wants forecast posture, forecast accuracy, commit, upside, forecast-call preparation, or a pipeline or deal-risk review for a seller book, team, period, report, or named deal set. Produce a manager-ready forecast rollup, risk posture, recommendation changes, evidence gaps, and follow-up actions.
---

# Review Forecast


## Context-Gathering Intake

Whenever this skill asks for context, strongly prefer using the `answers-ask-user-input` skill and the `ask_user_input` tool over other tools such as `request_user_input`; otherwise ask directly in the conversation.

Turn CRM or exported pipeline truth into a fast, manager-ready forecast readout. This skill owns the rollup, risk posture, recommendation changes, and follow-up actions; the initial review is read-only and never changes forecast categories, close dates, CRM records, tasks, or messages.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to `plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices`.

## Key Dependency Categories

These categories are particularly important for this workflow; use other sources only when they materially change a top recommendation.

- [Blocking] ~~CRM for authoritative opportunity, amount, stage, forecast category, close date, owner, next step, activity, report, and snapshot truth. It blocks unless a CRM report/export, pasted snapshot, or linked forecast-truth source is already grounded in context.
- ~~Knowledge & Files for forecast docs, manager notes, close plans, deal-desk trackers, approval trackers, and category conventions
- ~~Meeting Transcripts for recent customer evidence that changes timing, stakeholder, urgency, objection, or next-step confidence
- ~~Email for customer engagement, timing, unanswered asks, and commercial or procurement movement
- ~~Internal Messaging for manager, deal-desk, legal, product, approval, blocker, and account-team signals

Use ~~CRM as the default forecast truth. Use a user-provided/exported pipeline snapshot only as a fallback when CRM cannot be used. Notes, messages, and transcripts are supporting evidence, not substitutes for missing opportunity truth.

## Reference Loading

`SKILL.md` owns the normal forecast-review path and output shape. Use [references/request-schema.yaml](references/request-schema.yaml) when structured input, posture/category/amount enums, comparison inputs, or enrichment-mode normalization matters.

## Workflow Guidance

### 1. Resolve scope and forecast conventions

- If the review scope or forecast truth path is not clear, ask the user via `ask_user_input()`. For a bare invocation such as “review the forecast,” do not assume an owner book or truth source; offer: `My current forecast-period owner book from live CRM`, `A named team, owner, report, or pipeline view`, and `A pasted/exported forecast snapshot or deal set`.
- If the user names only “my forecast” without defining the source, offer the same explicit choices before building a rollup. Do not retrieve deeper opportunity evidence or render a posture review until the user selects a scope and truth path.
- Require one scope anchor: owner/book, team, period, named report or pipeline view, focused accounts, focused opportunities, or a supplied deal set.
- Require one forecast truth source: ~~CRM data, a CRM report/export, pasted pipeline table, current snapshot, or linked forecast context. If none exists, stop and ask for the smallest usable source rather than inferring a forecast from anecdotes.
- Before rendering a posture review, establish the forecast posture standard, category convention, and amount basis. Find concrete defaults in the supplied data, ~~CRM metadata, or ~~Knowledge & Files first. If any required choice is only inferred, present the sourced default and ask the user to confirm it before producing the posture review; proceed without confirmation only when the active thread or supplied source clearly defines all three.
- Do not interpret company-specific forecast categories, stage gates, or Commit/Upside norms beyond source-backed thread context, ~~CRM metadata, manager notes or RevOps docs from ~~Knowledge & Files, or user-provided guidance.
- If scope is ambiguous, make a bounded candidate pass before asking: at most three source reads, only enough to offer up to five concrete choices.
- Use owner scope only after the user explicitly selects or confirms it. When the user names accounts or opportunities, intentionally bypass owner-book scope; when the user names a report, team, or pipeline view, use that narrower scope and state it.
- Prefer the canonical ~~CRM report or filter for a named team, segment, book, or pipeline view and state the exact filter. For example, if a Startups forecast is represented by `Sales_Coverage_Opp__c = 'Startups'`, use that first instead of broadening across owner, account, and stamped-segment fields. Broaden only when the user asks, the canonical definition is known to be incomplete, or it returns an implausibly thin result; label the broader filter and do not compare it as if it were canonical.

### 2. Build the forecast truth set

- Start with the canonical ~~CRM report/filter or supplied export. State the exact scope, period, source, amount basis, and data freshness in the output.
- For live ~~CRM, do only the minimum field or schema discovery needed to identify scope, amount, forecast, stage, owner, close-date, next-step, activity, and risk fields. Skip current-user and account-object discovery unless the scope is “my book” or account-level fields are needed.
- For a normal first pass, gather current open deals in scope and build the rollup first, normally by forecast category and optionally stage: deal count, primary amount, and expected forecast amount.
- Inspect detail rows only for the highest-value, highest-risk, stale, materially changed, or concentration-driving opportunities.
- Gather prior-snapshot rows only when the user supplies a comparison snapshot, a named snapshot/report is available, or the user explicitly asks for movement. Do not use broad field history to imply true forecast movement.
- If current-versus-prior coverage is partial, label that directly.
- Treat OpportunityHistory or similar field history as field history, not forecast-snapshot movement, unless a true prior snapshot exists.
- If data is too thin for category recommendations, downgrade to a risk-only readout and say why.

### 3. Add bounded evidence only where it changes the call

- Default to `light` enrichment for the top one to three uncertain or material deals after the rollup exists. Use `none` when the user asks for forecast-data-only review; use `standard` only for a requested deep review or when missing supporting evidence would materially change a high-value recommendation.
- Use ~~Meeting Transcripts and ~~Email for recent customer engagement, urgency, stakeholder, objection, decision-process, and timing signals.
- Use ~~Internal Messaging and ~~Knowledge & Files for blockers, approvals, close-plan gaps, legal/procurement risk, or manager context.
- Do not enrich every deal by default. Stop when the top recommendations are supported; name missing lanes that would materially change confidence.
- Do not broaden enrichment while a required scope anchor or forecast convention is unresolved; resolve or confirm it first.
- Do not let supporting lanes override CRM-owned amount, stage, forecast category, owner, close date, or opportunity state.

### 4. Evaluate risk and recommendation posture

- Evaluate material deals for next-step clarity, timing credibility, stakeholder coverage, decision-process visibility, proof of urgency, recent engagement, and data freshness.
- Flag supported hygiene signals such as missing next steps, stale activity, unclear close dates, weak stakeholder coverage, and category/amount/stage changes.
- Flag portfolio concentration when too much posture depends on one deal, owner, stage, segment, product, or timing bucket.
- Use simple `low`, `moderate`, and `high` risk labels. Separate sourced facts from directional inference.
- Recommend keep, downgrade, upside, or follow-up-check posture only when evidence supports it. Phrase unsupported changes as questions or `Needs confirmation`.
- When current and prior snapshots are supplied, add a concise `What Changed` subsection. Without a prior snapshot, say true movement was not evaluated and use current-state examples only when supported, such as booked Closed Won, Commit concentration, stale close dates, missing next steps, or large Closed Lost/churn rows.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Inspect one high-risk or concentration-driving deal more deeply.
- Draft a concise manager or forecast-call summary for review.
- Create a spreadsheet-ready rollup or risk follow-up structure.
- Draft CRM-ready corrections or next-step text for review.
- Check whether a matching weekly automation already reruns this `review-forecast` skill for the same scope and forecast convention; if none exists, offer to create one that gives the seller or manager a weekly forecast-risk readout.

Next steps to avoid:
- Automatically changing forecast categories, close dates, amounts, or CRM records.

### Automation Offer Guard

For current forecast, movement, or risk-review outputs, a weekly forecast-risk brief is the preferred automation offer when the user has a reusable owner book, team, report, pipeline view, period, or deal set plus stable forecast conventions. Frame the value in sales language: spotting commit risk, upside movement, stale next steps, close-date pressure, concentration, and deals that need manager attention before the forecast call.

The automation must be a scheduled rerun of this skill, not a separate custom pipeline summary. When creating or describing the automation, make the prompt call this skill directly and preserve the same forecast scope and conventions:

```text
Use the Sales `review-forecast` skill.
Rerun it weekly for the same forecast scope and convention.
Return the standard Forecast Review output.

owner_name: "[owner name when used]"
owner_email: "[owner email when used]"
focus_accounts: [same focused accounts when used]
focus_opportunities: [same focused opportunities when used]
forecast_period: "[same period or rolling current period]"
forecast_posture_standard: "[defend_commit, identify_upside, or conservative_manager_ready]"
forecast_category_convention: "[same sourced or user-confirmed convention]"
amount_basis: "[carr_arr, acv, tcv, weighted_amount, or crm_primary_amount]"
enrichment_mode: "[none, light, or standard]"
```

For team, report, or pipeline-view scopes that are not expressible as owner, account, or opportunity fields, keep the stable scope in the plain-language prompt text and let this skill resolve the forecast truth set using its normal workflow guidance.

The recurring output should follow this skill's Forecast Review format: review scope, overall forecast posture, key movements, highest-risk deals, recommendation changes, evidence gaps, and follow-up actions. Keep it read-only; it may recommend checks, corrections, or CRM-ready text for review, but must not change forecast categories, close dates, amounts, CRM records, tasks, or messages unless the user separately asks and approves.

Before offering the weekly forecast brief, check whether the user already has a matching local automation installed. Inspect local automation records under `$CODEX_HOME/automations/*/automation.toml`, or `~/.codex/automations/*/automation.toml` when `CODEX_HOME` is unset, and match by name, prompt, skill name, cadence, owner book, team, report, pipeline view, forecast period, amount basis, category convention, or other stable scope details. Treat active and paused matches as already installed.

- If a matching automation exists, do not suggest creating another one. Continue with the next most relevant non-automation follow-up.
- If no matching automation exists, end with one clear offer to check/create a weekly rerun of `review-forecast` for the same scope. Describe the recurring output as a manager-ready weekly forecast brief covering risk, upside, stale next steps, concentration, and recommended checks. Do not create or update the automation until the user explicitly agrees.
- If the automation surface is unavailable, do not mention tool details; offer to help set up a recurring forecast-risk brief when automations are available.

## Modes

- `Current Forecast Review` — default; current rollup, top risks, recommendations, and actions.
- `Movement Review` — use when a prior snapshot or explicit comparison source exists; add true movement.
- `Risk-Only Review` — use when forecast truth is sufficient for risk but too thin for posture changes.
- `Focused Deal Review` — use for named accounts or opportunities instead of a full book.

## Output Format

Return these sections in order.

```md
# Forecast Review: [Scope]

## Review Scope

- **Scope:** [Owner, team, report, period, or deal set]
- **Forecast truth:** [Live CRM, export, pasted data, or linked source]
- **Amount basis:** [CARR/ARR, ACV, TCV, weighted amount, or CRM primary amount]
- **Category convention:** [Sourced convention or user-confirmed interpretation]
- **Data freshness:** [Date/time or limitation]

## Overall Forecast Posture

[Manager-ready posture summary]

| Forecast Category | Deal Count | Primary Amount | Expected Amount | Confidence |
| --- | ---: | ---: | ---: | --- |
| [Category] | [Count] | [Amount] | [Amount] | [High/Medium/Low] |

## Key Movements

- [True movement backed by a prior snapshot, or “True movement not evaluated; no prior snapshot was available.”]

## Highest-Risk Deals

| Deal | Amount | Current Posture | Risk | Why | Recommended Check or Change | Source |
| --- | ---: | --- | --- | --- | --- | --- |
| [Deal] | [Amount] | [Category] | [Low/Moderate/High] | [Evidence] | [Action or posture] | [Link/label] |

## Recommendation Changes

- **[Deal]:** [Keep / Downgrade / Upside / Needs confirmation] — [grounded reason and confidence]

## Evidence Gaps

- [Gap] — [impact on confidence] — [smallest next collection step]

## Follow-Up Actions

1. [Action] — [Owner or suggested owner] — [Due or TBD] — [Expected outcome] — [Source]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

## Rules

- Do not fabricate opportunities, amounts, stages, close dates, owners, forecast categories, customer engagement, movements, or links.
- Explain whether the review used live CRM truth, exported/report data, pasted pipeline data, or another user-provided source.
- Include true movement only with a prior snapshot or explicit comparison source; otherwise keep `Key Movements` and state the limitation.
- Label uncertain recommendations `Likely`, `Possible`, or `Needs confirmation`; avoid false precision.
- Keep the initial review read-only. Draft downstream manager notes, CRM-ready text, spreadsheet structure, or risk follow-up only when requested; never write or send without a separate explicit approval step.

## Failure Handling

If scope or forecast truth cannot be resolved, state the blocker, offer concrete candidates when available, and ask for the smallest missing source or convention. If optional evidence is unavailable, continue from the forecast truth set and make the confidence limit visible.
