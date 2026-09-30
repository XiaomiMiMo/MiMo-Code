---
name: find-key-internal-sources
description: "Use when a seller needs to find the best internal experts, owners, approvers, documents, channels, source-of-truth materials, or escalation routes for a customer question, product topic, competitive objection, implementation issue, account task, or other sales-support need. Route questions such as 'who knows about this?', 'what should I read?', 'where is the source of truth?', and 'which internal channel or document should I use?' here."
---

# Find Key Internal Sources

Find the smallest reliable internal route that helps a seller get an answer or unblock work: the right people, maintained docs, public channels, decision forums, and escalation paths. The default output is a quick, evidence-backed routing map plus a draft-ready first ask. This workflow is read-only and never posts, assigns, or updates systems.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices.

## Key Dependency Categories

Use only the categories needed for the selected route; do not fan out across every source by default.

- ~~Knowledge & Files for maintained source-of-truth pages, owner metadata, wikis, field guides, playbooks, FAQs, runbooks, launch docs, and decision records
- ~~Internal Messaging for public channels, channel topics, threads, active contributors, escalation routes, support channels, and decision forums
- ~~CRM for customer or account identity, ownership, opportunity context, and CRM-visible blockers that clarify an account-specific question

Prefer canonical ownership and source-of-truth material over chat mentions. ~~CRM can resolve account truth, but it does not by itself prove who owns the internal answer.

## Reference Loading

`SKILL.md` owns the normal route selection, bounded search, ranking, and output map. Load references only when their extra detail matters:

- Use [references/search-patterns.md](references/search-patterns.md) when query fan-out, compound facets, source-specific search, or stopping rules need more detail.
- Use [references/company-context.md](references/company-context.md) only after the generic pass, when user-provided or connector-visible terminology is likely to change the route.

## Terms

- **Source-of-truth page:** the maintained doc, wiki, tracker, or page that should be treated as the most authoritative answer source.
- **DRI:** directly responsible individual, the person accountable for a topic, decision, or follow-through.
- **SME:** subject matter expert, someone with practical depth on the topic even if they are not the accountable owner.
- **Decision forum:** the recurring meeting, channel, doc, or group where tradeoffs and approvals are handled.

## Workflow Guidance

### 1. Resolve the topic and route

- Require a concrete topic_or_task: customer question, product topic, objection, implementation issue, account blocker, initiative, or source-of-truth gap.
- Infer it from the active thread or provided Sales output when clear. If still ambiguous, make a bounded candidate pass of at most three source reads, then ask one friendly question with up to five concrete candidates.
- Treat ambiguous company-like names as possible account anchors. Use a bounded ~~CRM lookup when available before relying on internal docs or messages for account-specific routing.
- Default to quick. Use deep only when requested or when a high-stakes question clearly needs broader corroboration.

Choose the smallest answer route that satisfies the request:

- owner_route — who owns, approves, knows, or should be contacted
- doc_route — what to read, which page is maintained, or what wording is approved
- channel_route — where to ask, discuss, escalate, or get support
- full_map — experts, docs, and channels together when the request actually needs all three

### 2. Search canonical sources first

- For owner_route, start with maintained ownership, directory, routing, or source-of-truth pages; use messages to confirm current practice or fill gaps.
- For doc_route, start with maintained docs, title/heading matches, linked hubs, owner fields, and recency; fetch only the strongest candidate before ranking.
- For channel_route, start with public channel names, topics, purposes, and documented escalation routes; inspect recent public threads only when they change confidence.
- Use ~~CRM first for account identity and deal context when the route is customer-specific, then use ~~Knowledge & Files or ~~Internal Messaging for internal ownership.
- In quick, make one canonical source attempt, one narrow fallback when the first pass is empty, thin, or misleading, and at most one fetch or thread read per top candidate.
- Broaden only when the first pass is weak, the topic spans distinct surfaces, or the user asked for deep. Stop when a supported route is good enough, results stabilize, or additional searching produces low-confidence duplicates.

### 3. Build useful search facets

- Start with exact topic terms, then add aliases, abbreviations, legacy/current names, product/team names, and task-shape terms such as owner, approval, policy, runbook, playbook, FAQ, support, or escalation.
- For a compound question, keep separate tracks for the product/account surface and the control/process surface. Do not let a strong policy hit replace product routing, or a launch page replace approval ownership.
- Use [references/search-patterns.md](references/search-patterns.md) when query fan-out, source-specific search, or stopping rules need more detail.
- Use company-specific terminology only when it comes from the user or connector-visible source truth. Do not invent internal names, channel patterns, URLs, or ownership conventions.
- Apply organization-specific expansions only after generic candidate retrieval, keep base scoring primary, and cap the total context-based boost per candidate at `+0.25`.

### 4. Pull, score, and rank candidates

Normalize candidates by type, title or name, URL, source, evidence, ownership signal, and freshness. Deduplicate near-identical entries.

Rank by:

1. direct relevance to the requested answer route
2. authority and maintenance signal
3. freshness
4. cross-source confirmation
5. practical usefulness for the seller's next action

- Prefer direct evidence links over profile-only or mention-only matches.
- Prefer maintained source-of-truth pages, field guides, FAQs, and playbooks over one-off notes.
- Prefer channels whose topic, purpose, linked guide, or recent threads show an ownership path over channels that merely mention the topic.
- For people inferred mainly from ~~Internal Messaging, require a recent ownership or expertise signal, defaulting to the last 90 days; omit or down-rank stale candidates.
- Exclude deactivated or inactive users. Default to public channels only; include private channels, group DMs, direct messages, or externally shared channels only when the user explicitly asks and access is appropriate.
- Keep distinct routes when a topic spans product/GTM guidance and policy, security, implementation, pricing, or approval ownership.

### 5. Render the routing map

- Return only the depth the request needs. For a single route, keep the other required sections compact with Not searched in quick pass or No high-confidence candidate found.
- Explain each candidate's answer-path type: DRI, approver, SME, maintainer, accountable team, decision forum, launch owner, escalation channel, support channel, or feedback channel.
- Include a one-line rationale, direct link when available, evidence signal, and freshness or confidence when it affects trust.
- If the user's wording conflates two surfaces, add a short framing note explaining the split and continue with both routes unless the distinction changes which sources are safe to use.
- Recommended First Ask must be a concrete draft the seller can send to the best owner or public channel. Draft it in chat; do not post it.
- Coverage Gaps must name unavailable or weak categories, the effect on confidence, and the smallest useful next step.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Draft the first ask to the recommended owner, expert, or public channel.
- Open and synthesize the strongest source-of-truth document for the seller's question.
- Prepare a concise escalation note when the supported route requires escalation.
- Create a reusable routing note with the verified people, docs, channels, and caveats.
- Find the smallest missing source that would resolve an ownership or approval gap.

Next steps to avoid:
- Posting, assigning, escalating, or updating ownership automatically.

## Modes

- quick — default; up to three candidates each for experts, docs, and channels, with bounded retrieval
- deep — five to eight candidates each when evidence quality supports them
- owner_route, doc_route, channel_route, full_map — answer-shape routes; combine with quick or deep

## Output Format

```md
# Internal Routing Map: [Topic]

[Optional framing note when the topic spans distinct ownership surfaces.]

## Experts
- **[Name / team]** — [DRI / approver / SME / other type]; [why this route]. [Evidence link] · [confidence/freshness]

## Docs
- **[Doc]** — [source-of-truth / field guide / FAQ / other type]; [why it matters]. [Link] · [confidence/freshness]

## Channels
- **[#channel]** — [support / escalation / decision forum / other type]; [why ask here]. [Link] · [confidence/freshness]

## Recommended First Ask
> [Draft-ready question or handoff, addressed to the best owner or public channel.]

## Coverage Gaps
- [Missing or weak source, confidence impact, and smallest useful next step]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

## Example Prompts

- `Find the key internal sources for a customer question.`
- `Find who owns the Enterprise SSO rollout path for ExampleCorp.`
- `Find the docs and channels for answering a customer's security review question.`
- `Route this implementation blocker to the right internal people and source of truth.`

## Rules

- Do not fabricate owners, experts, channels, documents, source-of-truth paths, links, or ownership certainty.
- Keep facts and inference separate; label uncertain ownership Likely or Possible.
- Keep the routing-map phase read-only. Do not post, send, assign, or update anything.
- Prefer fewer high-confidence routes over long noisy lists.
- Always cite sources with hyperlinks when useful links are available; say (no useful link available) when the absence matters.
