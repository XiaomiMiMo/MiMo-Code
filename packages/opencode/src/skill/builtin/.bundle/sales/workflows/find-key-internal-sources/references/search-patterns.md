# Search Patterns

## Purpose
Use these patterns to produce high-quality queries across ~~Internal Messaging and ~~Knowledge & Files when the focused workflow needs fan-out. These are optional expansion patterns, not a requirement to exhaust every variant before answering.

## Query Construction

1. Extract anchor terms:
- Main noun phrase from request
- Product/team names
- System names, codenames, abbreviations

2. Expand with task-shape terms inferred from request wording:
- troubleshooting: error, incident, broken, outage, mitigation, postmortem
- planning/decision: RFC, proposal, tradeoff, approve, review
- onboarding/how-to: getting started, setup, runbook, playbook, owner
- policy/process: guideline, compliance, requirement, standard
- seller routing: field guide, GTM, enablement, FAQ, specialist, support channel, escalation, source of truth

3. Expand with synonym/alias terms:
- API/app/service abbreviations
- Legacy names and current names
- External term and internal shorthand pairings

4. For compound topics, split the query into facets:
- Product/account surface: the product, package, launch, account, workflow, or customer-facing surface named by the user.
- Control/process surface: the policy, security, retention, implementation, pricing, approval, exception, or support concept named by the user.
- Route surface: field guide, GTM/support channel, specialist team, owner, FAQ, playbook, launch hub, or source-of-truth page.

Keep all three facets active until ranking. A strong hit for one facet should not end the search before the other facets have at least one plausible candidate or a recorded gap.

## Fan-Out Template

Run only the variants needed for the selected answer route and current confidence. In `quick` mode, start with the smallest useful set and stop before broad fan-out when the core answer is supported.

1. Exact: `"<topic_or_task>"`

2. Synonym: `"<topic_or_task_synonym_1>"`, then `"<topic_or_task_synonym_2>"` as a separate search when the connector does not support boolean syntax reliably.

3. Contextual: `"<topic_or_task>" "<team_or_product>" "<task_shape_term>"`

4. Route: `"<team_or_product>" "field guide"`, `"<team_or_product>" "GTM"`, `"<team_or_product>" "specialist"`, `"<control_or_process>" "source of truth"`, and `"<control_or_process>" "escalation"` when those facets exist.

If the source supports semantic search, keep queries short and topical. If the source is lexical-heavy, include explicit aliases and abbreviations. After the bounded generic pass, apply org-specific expansions from user-provided context or connector-visible source truth using the rules in `company-context.md` only when those expansions are likely to change the recommended route.

## Source-Specific Notes

- ~~Internal Messaging:
  - Search both channel names/descriptions and messages.
  - Default to public channels only; include private channels only on explicit user request.
  - Prefer server-side visibility filters when available; otherwise post-filter by channel visibility metadata.
  - Exclude direct messages and group DMs unless user explicitly asks for them.
  - Prefer thread-level hits with multiple knowledgeable participants.
  - Inspect channel topics/purposes when channel search results are candidate ownership routes.
  - Prefer direct thread/message links as evidence for expert recommendations when available.
  - Follow connector-visible links from strong threads to docs, field guides, FAQs, or source-of-truth pages before ranking.
  - Capture recurring handles as expert candidates only when their ~~Internal Messaging account is active (not deactivated).
  - Require recent participation signals (default: within the last `90 days`) before elevating a person as an expert.

- ~~Knowledge & Files:
  - Prioritize title + heading matches, then body-only matches.
  - Prefer docs with clear owners and recent edits.
  - Search for central routing artifacts, including field guides, launch hubs, GTM pages, FAQs, playbooks, source-of-truth hubs, and support/escalation sections.
  - Fetch top candidate docs when snippets indicate they contain support channels, specialist routes, owner lists, customer-facing wording, or linked references.

- ~~Knowledge & Files wiki/page sources:
  - Prefer pages linked from central hubs/wikis and pages with active updates.
  - Use parent/child relationships to find canonical pages, not one-off notes.

## Stopping Rule

Stop fan-out when any of these is true:

- The selected answer route has a supported candidate that is good enough to return.
- Top results stabilize across 2+ query variants and additional variants add low-confidence duplicates.
- For compound topics, each active facet has a plausible high-confidence candidate or a clearly recorded gap.
- Quick-mode retrieval reaches roughly three to five minutes of active searching, two slow connector calls, or one timeout/rate-limit on a non-required enrichment source.

Then rank and return concise recommendations. If the quick-mode budget stopped the search before the answer is strong, return a checkpoint with what was searched, the best partial answer, the limiting gap, and one recommended next step: clarify/give a steer, continue deeper, or act on the current best route.
