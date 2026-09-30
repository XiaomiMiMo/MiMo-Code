---
name: prioritize-accounts
description: "Use when the user asks which existing accounts to work now, which leads are hottest in a grounded list or pipeline, how to rank a territory, book, pipeline, ICP list, or account list, where to focus this week, or what rep-ready next actions to take. Prioritize accounts using current evidence, suppress or account for in-flight motion, and identify reachable contacts when supported. Use enrichment instead for net-new company discovery or missing-data completion."
---

# Prioritize Accounts

Prepare a sales person with a small, evidence-grounded account action view: which accounts deserve attention now, why they rose, who to engage, and what safe next step to take.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices.

## Account Ranking

Use this priority order when the account set, ranking basis, or motion is ambiguous.

1. Explicit user request, named account list, owner scope, territory, ranking basis, or stated preference
2. CRM-backed open pipeline or user-provided CRM-equivalent account truth
3. Accounts with a source-grounded why-now signal, clear net_new or expansion branch, and reachable primary contact
4. Accounts with meaningful deal value, timing, momentum, risk, or actionability
5. Accounts without active motion, duplicate outreach risk, ownership ambiguity, or another hard suppressor
6. Accounts that fit the rep's stated capacity window

Default broad requests to open pipeline deals, deal value / ACV adjusted by timing, momentum, risk, and actionability, with a mixed motion goal. Do not create the candidate universe from enrichment, public context, calendar, or messages alone.

## Key Dependency Categories

It is **critical** to use **all** of these categories if you can, if any relevant plugins or connectors are available, to ensure high quality responses. If the user declines, or connectors aren't available, state that limitation in your final answer. You can also use other relevant connectors as needed.

- [Blocking] ~~CRM for account truth, ownership, customer status, opportunities, stage, amount, forecast posture, contacts, and recent activity. It blocks unless an authoritative account universe and account truth are already grounded in context.
- ~~Calendar for active-motion suppression and timing
- ~~Meeting Transcripts for objections, buying process, and stakeholder continuity
- ~~Email for recent engagement and promised next steps
- ~~Internal Messaging for duplicate motion, blockers, and owners
- ~~Knowledge & Files for ICP guidance, target lists, territory rules, account plans, sales plays, and suppression conventions
- ~~Sales Intelligence for fit, contactability, tech stack, funding, hiring, and source-grounded why-now context after CRM anchors the set

## Overall Rules

- Always cite sources using hyperlinks when useful links are available.
- Sources must list every material dependency category, its status, and whether it affected the recommendation.
- Keep the account as the primary unit of work and prefer fewer executable rows over a noisy list.
- Put each account in exactly one of Suggested Focus, Monitor, or Suppress Or Block. When an account has both actionable work and a suppressor such as duplicate-outreach risk, keep it in Suggested Focus and describe the constrained action there; use Suppress Or Block only when no rep action should be taken now.
- CRM owns the account universe and account truth. Other sources can enrich, suppress, or re-rank after the universe is anchored.
- Calendar, meeting notes, messages, documents, and Sales Intelligence may change timing, suppression, contact choice, confidence, or why-now context after CRM anchors the account set; they must not create or overwrite the account universe.
- Never fabricate contacts, urgency, opportunity posture, why-now signals, ownership, or account facts.
- Do not execute outreach, create records, update CRM, or send messages in this workflow unless the user explicitly requests the separate approved action.
- Use references/suppression-and-fallbacks.md when a row may be suppressed, blocked, monitored, or recovered through a fallback lane.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Take the next logical action for one selected account, such as drafting a message, preparing an internal ask, or unblocking a dependency.
- Draft CRM-ready updates for review to address missing, stale, or contradictory fields that affected the ranking.
- Research one selected account more deeply when the next action depends on missing context.
- Refine the ranking, suppression rules, or motion goal using the user's guidance.
- Check whether a matching weekly automation already reruns this `prioritize-accounts` skill for the same account set; if none exists, offer to create one that gives the seller a weekly account worklist with why-now context and safe next actions.

Next steps to avoid:
- Blanket outreach, bulk CRM writes, or taking action across the whole ranked list without explicit user direction.

### Automation Offer Guard

For substantive ranking outputs, a weekly account-priority brief is the preferred automation offer when the user has a reusable account set, owner scope, territory, pipeline view, target list, or named watchlist. Frame the value in sales language: deciding where to spend the week, which accounts moved into focus, which should be monitored or suppressed, and what next action is safe to take without creating duplicate outreach or CRM churn.

The automation must be a scheduled rerun of this skill, not a separate custom digest. When creating or describing the automation, make the prompt call this skill directly and preserve the same account scope and ranking intent:

```text
Use the Sales `prioritize-accounts` skill.
Rerun it weekly for the same seller account set: [owner scope, territory, pipeline view, target list, or watchlist].
Return the standard Account Action View when source links are available; otherwise return the Chat Fallback output.

account_set: "[same resolved account set]"
ranking_basis: "[same ranking basis or motion goal]"
motion_goal: "[net_new, expansion, mixed, or user-specified]"
suppression_rules: "[same known suppression rules when relevant]"
```

The recurring output should follow this skill's account-priority contract: Suggested Focus, Monitor, Suppress Or Block, Evidence Gaps, and Source & Run Details. Keep it read-only; it may recommend account actions, messages to draft, or CRM corrections for review, but must not execute outreach, create records, update CRM, or send messages unless the user separately asks and approves.

Before offering the weekly account-priority brief, check whether the user already has a matching local automation installed. Inspect local automation records under `$CODEX_HOME/automations/*/automation.toml`, or `~/.codex/automations/*/automation.toml` when `CODEX_HOME` is unset, and match by name, prompt, skill name, cadence, account set, owner, territory, pipeline view, ranking basis, motion goal, or other stable scope details. Treat active and paused matches as already installed.

- If a matching automation exists, do not suggest creating another one. Continue with the next most relevant non-automation follow-up.
- If no matching automation exists, end with one clear offer to check/create a weekly rerun of `prioritize-accounts` for the same scope. Describe the recurring output as a seller-ready weekly worklist of accounts to focus, accounts to monitor, accounts to suppress, why each matters, and the recommended next move. Do not create or update the automation until the user explicitly agrees.
- If the automation surface is unavailable, do not mention tool details; offer to help set up a recurring account-priority brief when automations are available.

## Modes

### 1. Account Action View

- This is the required default mode whenever stable connected-source or source-of-truth links are available.
- Do not choose Chat Fallback merely because the candidate set is small, the result can fit in chat, or some links need to be constructed from a trusted connector-returned org or instance base URL.
- Use for substantive ranking runs when CRM, another searchable connected source, or stable source-of-truth links can open useful row context.
- Build Work now, Watch, Paused, Evidence Gaps, and Source & Run Details. Map Suggested Focus to Work now, Monitor to Watch, and Suppress Or Block to Paused so the pane and any chat readout stay semantically identical.
- Use the bundled template exactly:

  `assets/account-priority-pane.template.html`

- The template is standalone UTF-8 HTML with inline CSS and browser JavaScript only. It has no external assets, no script imports, no npm dependencies, no Node dependency, and no helper scripts.
- Do not inline, rewrite, restyle, summarize, or recompose the template. The only allowed HTML mutation is replacing its exact data placeholder with the escaped payload described below.

#### View Generation Rules

- Generate the view whenever stable connected-source or source-of-truth links are available. A pasted unlinked list stays in chat unless the user explicitly asks for an offline view.
- Generate one local file in an OS-appropriate temporary directory:
  - macOS/Linux: `${TMPDIR:-/tmp}/prioritize-accounts/index.html`
  - Windows: `%TEMP%\prioritize-accounts\index.html`
- Build the account action package using Work now, Watch, Paused, Evidence Gaps, and Source & Run Details.
- Serialize the three account groups under `workNow`, `watch`, and `paused` respectively.
- Give every account row the seller-facing fields required by the payload schema: `rank`, `account`, `motion`, `stage`, `value`, `whyItMatters`, `nextAction`, `owner`, `dueDate`, `confidence`, and `status`. Include `accountUrl`, `primaryContact`, and `evidence` when grounded and available.
- Keep row copy compact enough to scan: `whyItMatters` should explain the timing, value, momentum, or risk in one or two short sentences, and `nextAction` should name one immediate safe action, watch trigger, or unblocking step.
- Never invent display fields. Use `Value unavailable`, `Unassigned`, or `No date set` when the connected source does not provide value, owner, or due-date truth.
- Serialize the same package as JSON that conforms exactly to `references/template-payload.schema.json`. Treat the schema's required root keys and account-row fields as the canonical payload contract.
- Escape the JSON for safe embedding in a script tag by replacing every `<` with `\u003c`.
- Replace the exact template placeholder `__PRIORITIZE_ACCOUNTS_DATA_JSON__` with the escaped JSON.
- Write the resulting HTML as UTF-8 to the local output path.
- Sanity check that the generated file contains no unresolved placeholder.
- Return the actual clickable view link first in the final response, then a short summary and proposed next step. Do not hardcode macOS-only `/private/tmp` in Windows-facing output. URL-encode spaces if emitting a `file://` URL.
- If local file links do not open in the client, start a tiny local HTTP server yourself only when necessary and return the localhost URL.
- Do not mention templates, JSON, placeholders, local files, or HTML mechanics in ordinary user-facing copy.

### 2. Chat Fallback

- Use when no useful source search/linking is available, local view creation is impossible, the user asks for plain text, or a parent flow requires chat-only output.
- State why the account action view was skipped when the missing source/link condition caused the fallback.

#### Output Format

```md
# Prioritize Accounts

## Suggested Focus

| Account | Why Now | Primary Contact | Secondary Contact | Opp Recommendation | Suggested Next Step | Sequence Angle | Confidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Account + source link] | [Grounded timing reason] | [Name + role] | [Name + role or None] | [Practical recommendation] | [Immediate rep action] | [Compact outreach hook] | [High/Medium/Low] | [ready_now/partial] |

## Monitor

| Account | Reason To Monitor | Trigger To Revisit | Status |
| --- | --- | --- | --- |

## Suppress Or Block

| Account | Suppressor Or Blocker | Evidence | Status |
| --- | --- | --- | --- |

## Sources

- [Sources that were included in the analysis]
- [Sources that were not included, why, and potential next steps to resolve]

## Source & Run Details

- **Account set:** [Resolved set]
- **Ranking basis:** [Visible rule]
- **Source of truth:** [CRM or CRM-equivalent source]
- **Motion goal:** [net_new / expansion / mixed]
- **Sources checked:** [Sources]
- **Assumptions:** [Assumption-based only when applicable]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```
