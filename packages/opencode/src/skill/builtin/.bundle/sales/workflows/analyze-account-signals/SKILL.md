---
name: analyze-account-signals
description: Use when the user wants to know what changed with one account, monitor an owner portfolio or watchlist, or rank accounts needing attention from recent evidence. Produce an evidence-backed account brief or bounded watchlist summary with recommended actions.
---

# Analyze Account Signals


## Context-Gathering Intake

Whenever this skill asks for context, strongly prefer using the `answers-ask-user-input` skill and the `ask_user_input` tool over other tools such as `request_user_input`; otherwise ask directly in the conversation.

Turn fresh account evidence into a concise view of what changed, why it matters, and what to do next. This skill owns a read-only account brief or bounded watchlist summary; it does not create tasks, post digests, store monitoring state, or write CRM updates.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to `plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices`.

## Key Dependency Categories

These categories are particularly important for this workflow; use other sources only when they materially improve the signal story.

- [Blocking] ~~CRM for authoritative account identity, owner, opportunity, stage, amount, activity, customer-health, and account-status truth. It blocks the default account-signal readout unless sufficiently complete account truth is already grounded in context.
- ~~Meeting Transcripts for recent customer language, decisions, commitments, objections, follow-ups, and stakeholder movement
- ~~Email for customer-facing progression, unanswered asks, tone shifts, attachments, and promised next steps
- ~~Internal Messaging for internal coordination, blockers, stakeholder alignment, and escalation signals
- ~~Knowledge & Files for account plans, notes, briefs, implementation docs, and prior account context
- ~~Calendar for recent or upcoming customer sessions, commitments, and scope reduction for large portfolios

Use ~~CRM as the default account anchor. Use sufficient user-provided/exported account truth only as a fallback when CRM cannot be used. Communications, files, and calendar evidence explain recency and movement; they do not override CRM-owned account or opportunity fields.

## Reference Loading

`SKILL.md` owns the normal mode split, bounded retrieval, and output shape. Load references only when their extra detail changes the decision:

- Use [references/request-schema.yaml](references/request-schema.yaml) when structured input, legacy aliases, selector precedence, or machine-readable output shape matters.
- Use [references/signal-taxonomy.md](references/signal-taxonomy.md) when signal classification, confidence, recency, ranking, delta status, or display labels are ambiguous.

## Workflow Guidance

### 1. Choose the mode and scope

- If the mode isn't clear, ask the user via `ask_user_input()`. For a bare invocation such as “Analyze account signals for me,” do not assume an Adhoc Account Brief or Monitor Summary; offer:
  - `Adhoc Account Brief for one account`
  - `Monitor Summary for accounts I own in CRM`
  - `Monitor Summary for a watchlist, owner, or territory`
- Use `Adhoc Account Brief` for one named account or “what changed with [account]?” requests. If the user selected Adhoc but did not supply an account, domain, or CRM id, search, rank, and offer up to five concrete account candidates via `ask_user_input()`. Do not retrieve deeper evidence or draft the brief until the user selects one.
- Use `Monitor Summary` for owner, territory, portfolio, watchlist, daily-monitor, or “which accounts need attention?” requests. If the user selected Monitor but did not supply a watchlist, owner, territory, or portfolio, offer:
  - `Accounts I own in CRM`
  - `A named owner or territory`
  - `A watchlist or account list I provide`
  Do not broaden to a representative seller or retrieve deeper evidence until the user selects a scope.
- Require exactly one account for Adhoc. Require a watchlist, owner, territory, portfolio, or sufficiently detailed account list for Monitor.
- Default to the last 14 days unless the user provides another window. Preserve supplied focus areas such as expansion, churn, rollout blockers, or stakeholder movement.
- Accept `sfdc_account_id` as a legacy alias for `crm_account_id`. When structured input conflicts with prompt wording, use the structured input as the source of truth and state the resolved scope.
- After the mode and scope are known, if the anchor is ambiguous, make a bounded candidate pass before asking: start with ~~CRM when available, make at most three source reads, and offer up to five concrete candidates.
- If the user says `okay` in response to concrete candidates presented in the current conversation, pick a suitable recent, important-looking, or high-signal account from those candidates instead of skipping. Ask one concise clarification when no suitable account, owner portfolio, or watchlist is visible.

### 2. Bound and resolve the account universe

- For Adhoc, resolve one account by stable CRM id, exact name/domain, or sufficiently detailed user-provided account context.
- For Monitor, use an explicit watchlist as the full scope. Otherwise use the requested owner/territory/portfolio in ~~CRM with a bounded first pass.
- For owner-scoped Monitor, prefer primary-owner scope; paginate only while the provider indicates more results and until 50 accounts are collected.
- If the primary-owner lookup returns zero accounts and the user explicitly requested account-team, territory, role, collaborator, or go-to-market-linked coverage, retry once with the selected ~~CRM app's supported filters and the same cap.
- If the broader retry times out or fails, continue with primary-owner results when present; otherwise ask for a watchlist or narrower owner scope.
- Keep Monitor to at most 50 accounts. If the resolved universe is larger, use upcoming external customer meetings in ~~Calendar over the next 14 days to reduce to at most 50; if that cannot reduce it, ask for a narrower scope instead of picking an arbitrary slice.
- Prefer exact name/domain matches and do not trust the top resolver result blindly when several plausible accounts remain.

### 3. Collect bounded recent evidence

- For each selected account, collect primary ~~CRM truth and user-provided context first. Use ~~Knowledge & Files for account plans or notes that explain the active workstream.
- For Adhoc, or when primary evidence is thin, deepen selectively in this order when relevant: ~~Email, ~~Knowledge & Files, ~~Meeting Transcripts, ~~Internal Messaging, then ~~Calendar.
- For Monitor, finish the bounded primary pass across the account set before deepening individual accounts. Deepen only accounts with a possible material delta, ambiguity, or high-value risk/opportunity.
- Parallelize only independent account lookups, with a practical cap of 10 at a time. Treat a batch timeout or schema error as a call-shape failure, not proof that the source is unavailable; retry failed accounts once by stable account id when available, then mark them unavailable and continue with surviving accounts.
- Stop when the recent story is supported. If a recency source was checked and found no match, say `checked/no match` when that absence materially affects confidence.

### 4. Normalize, score, and interpret signals

- Normalize evidence into the fixed taxonomy in `references/signal-taxonomy.md`; do not invent new signal labels unless the user explicitly extends the workflow.
- For every signal preserve type, summary, source, recency, confidence, evidence, citation, and suggested action.
- Deduplicate several sources describing the same event. Corroboration raises confidence; weak, stale, contradictory, or unsupported evidence lowers confidence and often becomes an Evidence gap.
- Distinguish actionable account risk from hygiene-only context such as ownership gaps, missing routing fields, or ambiguous associations; surface hygiene only when it affects monitoring confidence or the suggested action.
- For Adhoc, order signals by importance to the account story: risk/opportunity first, then dependencies, then supporting context.
- For Monitor, rank fresh, high-confidence, action-relevant change. Prioritize Churn or retention risk and Expansion opportunity; down-rank stale or speculative signals and compress accounts with no material delta.
- Give each ranked account an attention score of High, Medium, or Low and a directional posture of Expansion ready, Expansion blocked, Retention risk, or Execution risk.

### 5. Separate evidence from interpretation

- Put clickable source links close to the claims they support. For CRM, use connector-provided record URLs; construct a URL from an id only when trusted connector metadata exposes the instance base URL. Use plain source labels when no stable link exists and do not expose naked record ids as the primary action path.
- Keep raw evidence and strategic interpretation visibly separate. Every recommended action must trace to a signal or evidence item.
- If CRM and manual account truth are both unavailable, state that the recency anchor is unavailable and do not imply the result is current.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Deepen one account or close the smallest material evidence gap.
- Draft a concise internal account-team update grounded in the signals.
- Hand the selected account to deal strategy or meeting prep when the evidence points to an active motion or upcoming conversation.
- Check whether a matching daily or weekly automation already reruns this `analyze-account-signals` skill for the same monitor scope; if none exists, offer to create one that reruns the skill and flags which accounts need attention, why it matters, and the next best sales action.
- Draft CRM-ready updates for review when missing or stale fields are affecting confidence.

Next steps to avoid:
- Creating tasks, posting updates, or writing CRM changes automatically.

### Automation Offer Guard

For `Monitor Summary` outputs, a recurring seller account watch is the preferred next step when the user has provided a reusable scope such as a watchlist, owner, territory, or portfolio and the summary would benefit from daily or weekly refresh. Frame the value in sales language: catching pipeline movement, expansion signals, retention risk, stalled next steps, stakeholder changes, upcoming customer meetings, and account-team blockers before they get missed.

The automation must be a scheduled rerun of this skill, not a separate custom digest. When creating or describing the automation, make the prompt call this skill directly and preserve the same normalized request shape the skill accepts where possible:

```text
Use the Sales `analyze-account-signals` skill in `Monitor Summary` mode.
Rerun it for the same seller account scope: [watchlist, owner, territory, portfolio, or CRM filter].
Return the standard Monitor Summary output.

mode: "monitor"
owner_id: "[owner id when used]"
owner_email: "[owner email when used]"
watchlist_accounts: [same watchlist when used]
time_window: "[same or agreed recency window, default 14d]"
focus_areas: [same focus areas such as expansion, churn, rollout blockers, stakeholder movement]
output_style: "inbox_summary"
```

For territory or portfolio scopes that are not expressible as `owner_id`, `owner_email`, or `watchlist_accounts`, keep the stable scope in the plain-language prompt text and let this skill resolve the account universe using its normal Monitor Summary guidance.

The recurring output should follow this skill's `Monitor Summary` format: ranked accounts requiring attention, material deltas, run metadata, and no-major-delta handling. Keep it read-only; it may recommend next sales actions, but must not create tasks, post digests, store monitoring state outside the automation, or write CRM updates unless the user separately asks and approves.

Before offering a recurring monitor, check whether the user already has a matching local automation installed. Inspect local automation records under `$CODEX_HOME/automations/*/automation.toml`, or `~/.codex/automations/*/automation.toml` when `CODEX_HOME` is unset, and match by name, prompt, skill name, mode, account set, owner, territory, portfolio, or other stable scope details. Treat active and paused matches as already installed.

- If a matching automation exists, do not suggest creating another one. Continue with the next most relevant non-automation follow-up.
- If no matching automation exists, end with one clear offer to check/create a daily or weekly rerun of `analyze-account-signals` for the same scope. Describe the recurring output as a short seller-ready digest of accounts needing attention, why each matters commercially, and the recommended next action. Do not create or update the automation until the user explicitly agrees.
- If the automation surface is unavailable, do not mention tool details; offer to help set up a recurring check when automations are available.

## Modes

- `Adhoc Account Brief` — one account, default brief output.
- `Monitor Summary` — bounded watchlist/owner/portfolio view, default inbox-style output.

## Output Format

### Adhoc Account Brief

```md
# Account Snapshot

- **Account:** [Linked account when available]
- **Time Window:** [Window]
- **Current Posture:** [1-2 grounded lines]

## Key Recent Signals

- **[Plain-English signal label]** — [What changed] · [Fresh/Recent/Stale] · [High/Medium/Low confidence] · [Source link/label]

## Strategic Interpretation

- [What the signals likely mean for land, expand, retention, or execution risk; label inference]

## Recommended Actions

1. [Action] — [Evidence or signal link] — [Expected outcome]

## Open Questions / Missing Evidence

- [Unknown or gap] — [smallest follow-up evidence that would reduce uncertainty]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

### Monitor Summary

```md
# Ranked Accounts Requiring Attention

| Account | What Changed | Why It Matters | Attention | Posture | Suggested Action | Confidence / Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| [Linked account] | [Delta] | [Impact] | [High/Medium/Low] | [Posture] | [Action] | [Link/label] |

## Material Deltas

| Date | Account | Signal | Status | Delta Summary | Impact | Next Step | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Date] | [Account] | [Label] | [New/Updated/Worsened/Resolved] | [Delta] | [Impact] | [Action] | [Confidence] |

## Run Metadata

- **Time Window:** [Window]
- **Data Freshness Cutoff:** [Cutoff or limitation]
- **Scope:** [Universe, checked count, ranked count]
- **Delta Since Last Run:** [Only when prior-run context exists]

## No Major Delta

[Include only when useful.]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

## Rules

- Do not fabricate accounts, owners, opportunities, metrics, signals, dates, links, or recommended actions.
- Do not use public web/news research, external enrichment, or task trackers unless the user explicitly extends the workflow and supplies a relevant source.
- Do not create tasks, posts, digests, CRM updates, or other writebacks in this workflow.
- Use plain-English display labels rather than raw taxonomy tokens in user-facing output.
- Rewrite unsupported claims as questions, risks, or evidence gaps rather than assertions.
- If a monitor run has no material delta, say so concisely instead of padding the ranking.

## Failure Handling

If account resolution fails, state what identifier is missing or ambiguous and ask for the smallest clarification. If optional sources fail, continue with the strongest grounded evidence and name material gaps. If Monitor scope cannot be safely reduced to 50 or fewer accounts, ask for a watchlist or narrower scope.
