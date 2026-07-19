---
name: plan-deal-strategy
description: Use when the user wants strategy for one active deal, renewal, negotiation, buying process, or initial sales motion for an offer or product. Build a grounded deal map or practical sales plan with objections, sequencing, posture, and prioritized next actions. Use prepare-for-meeting instead for multi-account same-day customer call queues.
---

# Plan Deal Strategy


## Context-Gathering Intake

Whenever this skill asks for context, strongly prefer using the `answers-ask-user-input` skill and the `ask_user_input` tool over other tools such as `request_user_input`; otherwise ask directly in the conversation.

Turn active-deal evidence or clearly supplied offer context into a practical strategy for advancing a sale or shaping an initial sales motion. This skill owns the deal map, buying committee, negotiation posture, objections, sequencing, and action plan; it is not first-call prep, data-first prospecting, or a writeback workflow.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to `plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices`.

## Key Dependency Categories

These categories are particularly important for this workflow; use other sources only when they materially improve the strategy.

- [Blocking] ~~CRM for authoritative account and opportunity identity, stage, amount, close date, owner, contacts, and recent activity. It blocks the default active-deal strategy path unless sufficiently grounded deal truth is already in context.
- ~~Meeting Transcripts for stakeholder language, objections, commitments, decisions, procurement signals, and call continuity
- ~~Email for customer-facing progression, approvals, negotiation, legal/procurement exchange, and unanswered asks
- ~~Internal Messaging for internal blockers, owner alignment, escalation paths, and execution risk
- ~~Knowledge & Files for account plans, mutual action plans, implementation docs, risk logs, and strategy artifacts
- ~~Calendar for upcoming decision forums, executive meetings, procurement/legal milestones, and timing pressure
- ~~Sales Intelligence only when it sharpens a stakeholder or company hypothesis after the deal is anchored

Keep ~~CRM authoritative for CRM-owned deal truth. Supporting sources sharpen risks, stakeholders, timing, and actions; they do not invent or override stage, amount, owner, close date, or active-deal presence.

## Reference Loading

`SKILL.md` owns the normal deal-strategy flow and output package. Load references only when their extra detail matters:

- Use [references/request-schema.yaml](references/request-schema.yaml) for structured input, legacy aliases, mode enums, stage hints, time-window bounds, or seed-evidence normalization.
- Use [references/risk-rubric.md](references/risk-rubric.md) when risk type, severity, likelihood, confidence, prioritization, or mitigation fields are ambiguous.

## Workflow Guidance

### 1. Qualify and choose a mode

- Use this only when there is an active account, opportunity, renewal, buying process, or sufficiently detailed deal context after discovery.
- Seek enough evidence to identify the current deal motion and at least one blocker, stakeholder question, or next-action need. If the anchor is sufficient but evidence is thin, produce a low-confidence pack with explicit gaps rather than inventing detail.
- If the request is first-call prep with little prior evidence, route to `prepare-for-meeting` when a meeting anchor exists; otherwise ask for basic account context and provide lightweight manual prep.
- Default to `Full Strategy Pack`. If the user asks for only one artifact, use the matching partial mode and keep the investigation scoped to it.

### 2. Resolve the deal anchor

- Start with the user-named account, opportunity, renewal, initiative, link, or notes.
- Accept `sfdc_account_id` as a legacy alias for `crm_account_id`.
- When available, use ~~CRM first to identify the account and the opportunity that best matches the named product, solution, renewal, stakeholders, timing, and recent activity.
- If the user asks for deal strategy but did not supply an account, opportunity, renewal, initiative, link, or notes, use ~~CRM first to search, rank, and offer up to five concrete current-opportunity candidates via `ask_user_input()`. For a bare invocation such as “Plan the deal strategy for my most appropriate current opportunity,” do not assume a target; offer the connector-backed candidates and ask the user to choose before broad enrichment or drafting.
- Build a small alias set from the selected opportunity name, product or solution terms, activity titles, and user wording. Use it to validate related meetings, threads, and docs and reject same-account artifacts for a different deal motion.
- If multiple plausible deals remain, make at most three source reads to offer up to five concrete candidates via `ask_user_input()`, then ask the user to choose before broad enrichment. If exactly one inferred candidate remains, ask the user to confirm it via `ask_user_input()` before broad enrichment or drafting.
- If CRM is unavailable but user-provided evidence is sufficient, continue with a clear CRM gap. Do not treat same-account evidence for another opportunity as proof for the selected motion.

### 3. Gather evidence by lane

- Use the selected account and deal-motion aliases to find relevant recent evidence in ~~Meeting Transcripts, ~~Email, ~~Internal Messaging, ~~Knowledge & Files, and ~~Calendar.
- Prefer the narrowest relevant window; default to the last 90 days unless the user provides another window.
- Do not require transcript, thread, or document links up front; use the selected account and deal-motion aliases to discover relevant artifacts.
- Read enough to support the current motion, stakeholder posture, procurement risks, and next actions. If the first same-account artifact belongs to another deal motion, continue to the next targeted result when available; otherwise skip it, label the gap, or ask the user to choose.
- Record each lane as available, unavailable, empty, stale, conflicting, or user-provided-only. Stop once the core strategy is supported; do not chase indirect substitutes for unavailable source truth.

### 4. Build the strategy

- Build a concise deal map: initiative, target outcome, motion/timeline, active workstreams, recent account or service context that materially changes deal execution when evidenced, blockers, and dependencies.
- Build the buying committee from evidenced people and roles. Use roles `economic_buyer`, `decision_maker`, `champion`, `influencer`, `blocker`, `procurement`, `legal`, `security`, or `unknown`; stance `supportive`, `neutral`, `skeptical`, `blocking`, or `unknown`; and influence `high`, `medium`, `low`, or `unknown`. Label inferred role, stance, or influence with `Inference:`.
- Build procurement risks with severity, likelihood, confidence, owner or suggested owner, mitigation, timing, and source. Load `references/risk-rubric.md` when classification or prioritization is ambiguous.
- Produce 5-7 high-signal actions by default. Each action needs an owner or suggested owner, due date or `TBD`, expected outcome, linked risk/stakeholder, and source.

### 5. Separate evidence from inference

- Cite useful source links inline when available; use plain source labels only when no stable link exists.
- Do not link meeting join URLs, generic room URLs, or opaque connector ids as evidence.
- If evidence conflicts, lower confidence and add an evidence gap instead of forcing a conclusion.
- Use exact dates and confirmed customer-side owners only when directly evidenced. Otherwise use relative timing, `TBD`, or `Suggested owner:`; avoid exact-day due dates when confidence is low or evidence is sparse.
- Use public or user-provided market context only when it sharpens a company or stakeholder hypothesis after the deal is anchored. Treat it as supporting context, never a hard dependency or override for account/deal truth.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Turn the prioritized actions into a mutual action plan or execution tracker.
- Prepare the next customer, partner, or internal meeting around the highest-risk decision.
- Draft stakeholder-specific email or Slack language for review.
- Draft CRM-ready opportunity updates for review.
- Deepen one blocker, stakeholder, or procurement risk where evidence is still thin.

Next steps to avoid:
- Sending messages, updating CRM, or creating downstream artifacts without a separate explicit request.

## Modes

- `Full Strategy Pack` — default; return every section below.
- `Deal Map Only` — return Deal Snapshot, Deal Map, Evidence Gaps, and Inference Notes.
- `Buying Committee Only` — return Deal Snapshot, Buying Committee Map, Evidence Gaps, and Inference Notes.
- `Procurement Risk Only` — return Deal Snapshot, Procurement Risk Register, Evidence Gaps, and Inference Notes.
- `Next Actions Only` — return Deal Snapshot, Prioritized Next Actions, Evidence Gaps, and Inference Notes.

## Output Format

For a full strategy pack, return sections in this exact order.

```md
# Deal Strategy: [Account / Opportunity]

## Deal Snapshot

- **Account:** [Name + source]
- **Opportunity:** [Name or Unknown]
- **Stage:** [CRM-backed value or Unknown]
- **Close Date:** [Evidenced date or Unknown]
- **Time Window:** [Window]
- **Run Mode:** [Mode]
- **Coverage Summary:** [Available, unavailable, empty, stale, or user-provided-only lanes]

## Deal Map

- **Initiative:** [Business initiative]
- **Target Outcome:** [Customer/business outcome]
- **Current Motion:** [Stage, timeline posture, and deal movement]
- **Active Workstreams:** [3-6 grounded bullets]
- **Top Blockers or Dependencies:** [Up to 5 grounded bullets]

## Buying Committee Map

| Stakeholder | Title | Org | Role | Stance | Influence | Last Signal | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Name] | [Title] | [Org] | [Role] | [Stance] | [Influence] | [Signal] | [High/Medium/Low] | [Link/label] |

## Procurement Risk Register

| Risk ID | Risk Summary | Risk Type | Severity | Likelihood | Owner or Suggested Owner | Mitigation | Target Date | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | [Risk] | [Type] | [High/Medium/Low] | [High/Medium/Low] | [Owner] | [Step] | [Date/TBD] | [High/Medium/Low] | [Link/label] |

## Prioritized Next Actions

1. **Action:** [Concrete action]
   - **Owner or Suggested Owner:** [Owner]
   - **Due:** [Date, relative timing, or TBD]
   - **Linked Risk IDs:** [IDs or None]
   - **Linked Stakeholders:** [Names or None]
   - **Expected Outcome:** [Outcome]
   - **Source:** [Link/label]

## Evidence Gaps

- **Gap:** [Material missing/conflicting evidence]
  - **Impact:** [How confidence or execution is affected]
  - **Smallest Next Collection Step:** [Most efficient way to close it]

## Inference Notes

- Inference: [Claim inferred rather than directly stated, with basis]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

## Rules

- Do not fabricate stakeholders, approvals, blockers, owners, commitments, amounts, stages, close dates, or exact dates.
- Keep facts and inference separate; omit empty inference notes rather than padding them.
- Prefer fewer strong actions over broad advice, and prioritize the risks most likely to block signature or slip timing.
- Use human-readable Title Case labels in normal output; use machine-readable keys only when the user asks for JSON or YAML.
- Keep this workflow read-only. Do not update CRM, send messages, post recaps, or create downstream artifacts unless the user explicitly asks in a later step.
- If evidence is sparse but the deal anchor is sufficient, produce a low-confidence pack with explicit gaps rather than stopping.

## Failure Handling

If no credible active-deal anchor exists, state the blocker, offer concrete candidates when available, and ask for the smallest missing input. If optional lanes are unavailable, continue with the strongest grounded evidence and make the resulting confidence limits visible.
