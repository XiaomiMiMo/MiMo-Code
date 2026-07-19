---
name: zoominfo
description: Use only when a focused Sales workflow has selected a present and connected ZoomInfo connector, or the user explicitly asks for ZoomInfo company search, contact search, enrichment, intent, similarity, recommendations, or research. Do not use when another enrichment source is selected.
---

# ZoomInfo User Guide

Use ZoomInfo for focused Sales Intelligence work after the parent Sales workflow selects it. Keep the parent workflow authoritative for the seller's task; this guide owns ZoomInfo-specific lookup, search, identity, enrichment, credit, and result-quality rules.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices.

## ZoomInfo Operation Ranking

1. Explicit user request, named company or person, domain, email, ZoomInfo ID, or stated constraint
2. The narrowest ZoomInfo lane needed by the active Sales workflow
3. Canonical company or contact identity resolved from strong identifiers
4. Search and shortlist before enrichment, research, similarity, or recommendations
5. The smallest credit-consuming step that materially improves the answer
6. A result that clearly separates qualified matches, near matches, and gaps

Do not silently relax hard filters, guess identities, or present ZoomInfo as CRM ground truth.

## Key Dependency Categories

These are particularly important for this workflow; use your best judgment to potentially include other data sources to improve quality.

- ~~Sales Intelligence, specifically a present and connected ZoomInfo connector, for ZoomInfo search, enrichment, intent, similarity, recommendations, and research
- ~~CRM for account ownership, customer status, opportunity facts, and forecast truth
- The parent Sales workflow for Calendar, Meeting Transcripts, Email, Internal Messaging, or Knowledge & Files context
- User-provided names, domains, emails, IDs, ICP constraints, and business context when connector access or identity is incomplete

If ZoomInfo is missing, unavailable, ambiguous, or limited by the exposed connector surface, state the limitation instead of substituting unsupported claims.

## Connector Boundary

ZoomInfo supports several distinct lanes. Choose the narrowest lane that fits the request.

- Discovery: `lookup`, `search_companies`, `search_contacts`, `search_intent`
- Structured enrichment: `enrich_companies`, `enrich_contacts`, `enrich_intent`
- Narrative research: `account_research`, `contact_research`
- Similarity and recommendation: `find_similar_companies`, `find_similar_contacts`, `get_recommended_contacts`
- Connector feedback only when the user asks for it: `submit_feedback`

Do not blur these lanes:

- Use `search_*` to discover candidates.
- Use `enrich_*` when the user wants stronger structured fields or a verified detail check.
- Use `account_research` or `contact_research` when the user wants a narrative brief, meeting prep, or broader situational readout.
- Use similarity or recommendation actions for "more like this", account expansion, or stakeholder discovery, not as a substitute for precise search filters.

Do not present ZoomInfo as CRM ground truth. If a research response includes relationship or engagement context, label it as connector-surfaced context unless it is independently grounded by ~~CRM or the surrounding workflow.

## Default Resolution Pattern

Run these steps in order.

1. Classify the target:
   - company set
   - contact set
   - one known company
   - one known person
   - buyer intent topic
   - lookalike or recommendation request
2. Normalize hard filters before searching:
   - geography
   - management level
   - department or job family
   - employee or revenue bands
   - industry or company type
   - technology filters
   - intent topics
3. Use `lookup` before search or intent flows whenever the connector expects standardized values.
4. Resolve canonical company or contact identity before enrichment, research, or recommendation actions that depend on IDs.
5. Verify that returned rows actually satisfy the user's hard constraints before summarizing them as matches.
6. State what was not found, weakly supported, or connector-limited instead of smoothing gaps away.

## Lookup Discipline

Use `lookup` to retrieve supported values instead of guessing connector-specific categories.

- Use it for `management-levels`, `metro-regions`, `industries`, `employee-count`, `departments`, `job-functions`, `company-types`, `revenue-ranges`, `tech-vendors`, `tech-products`, and `intent-topics` when those constraints matter.
- Use the standardized identifier returned by `lookup` where the downstream action expects an identifier, not a prettified display label.
- For technology-stack searches, resolve the vendor first, then resolve products for that exact vendor, then pass the returned product identifiers into search.
- For intent workflows, retrieve exact supported intent topics first. If the requested concept does not map cleanly to a supported topic, present the closest supported topic only when it is genuinely close; otherwise say the request is not precisely expressible through the current topic taxonomy.

Do not invent lookup values or silently swap in an adjacent category without saying so.

## Identifier Resolution

Resolve entities carefully before ID-dependent actions.

### Companies

- Prefer `companyId`, domain, website, or ticker over company name alone.
- If the user provides only a company name and the next step requires enrichment, research, or a target-company ID, first use `search_companies` to find the canonical company row when identity is not obvious.
- If multiple plausible companies remain, use domain, headquarters, industry, or the user's surrounding context to disambiguate. If ambiguity still matters, present the candidate set instead of picking one quietly.
- For company enrichment, prefer `companyId`, `domain`, or `companyWebsite` over vague name-only input when available.

### Contacts

- Prefer `personId`, business email, or an exact full-name-plus-company combination over a name alone.
- If the user asks for contact research, similar contacts, or another person-ID-dependent workflow from a name, first use `search_contacts` to resolve the target person.
- If the same name maps to multiple plausible people, keep the candidate list explicit and do not fabricate a single match.
- For contact enrichment, use the strongest supported identifier available; avoid broad name-only enrichment when a search pass can make the identity less ambiguous.

### Runtime Shape

- Pass connector-returned identifiers in the runtime-compatible primitive shape the action accepts.
- When the connector surfaces a numeric ZoomInfo identifier and the destination action requires a numeric identifier at runtime, preserve it as numeric rather than rewriting it into prose or guessing a new value.
- If an action rejects an apparently valid identifier shape, retry only once with the directly corresponding connector-returned primitive when the target is unambiguous. If that still fails, report a connector contract mismatch and continue only with lower-risk available evidence.

## Search Discipline

### Company Search

- Translate the user's ICP into explicit filters before searching.
- Prefer structured filters for geography, headcount, revenue, company type, funding, growth, and tech usage when the connector supports them.
- If the user asks for "US companies", "California companies", or another hard geography requirement, verify that each surfaced result matches the requested region before calling it a qualified match.
- If search returns close but imperfect rows, separate `Matches` from `Near Matches` rather than hiding the distinction.
- Do not claim exhaustive market coverage from a bounded result page.

### Contact Search

- Use management level, department, function, company, and title filters together when that improves precision.
- For role-family requests such as "VP, Director, or Head of RevOps", start with the narrowest structured interpretation that is likely to work.
- If a single broad title query returns sparse, clearly incomplete, or off-target results, split the role family into a small number of targeted searches, merge duplicates, and summarize the deduped shortlist.
- Prefer directly returned business fields. Do not infer private email addresses, personal phones, or missing professional profiles.

### Intent Search

- Always resolve exact intent topics with `lookup` before `search_intent` or `enrich_intent`.
- Keep topic meaning visible in the answer so the user can see what was actually searched.
- If returned intent topics are materially narrower, broader, or adjacent to the user's concept, say so.
- If the topic lookup or search path cannot support the requested concept faithfully, report that limitation instead of overstating the result.

## Enrichment And Research Sequencing

Use cheap narrowing steps before expensive or less precise actions when practical.

- Use search first when the entity itself is unclear.
- Use structured enrichment when the user wants firmographic fields, contactability fields, or batch-ready tabular output.
- Use narrative research when the user wants a briefing, situational awareness, or prepare-for-meeting style synthesis.
- For top-N discovery requests, do not enrich every raw candidate by default. Narrow first, then enrich only the shortlisted set that materially improves the answer.
- When a similarity or recommendation workflow returns sparse person or company detail, add a targeted enrichment pass only when the user asked for actionable detail or when the surrounding workflow needs it.

## Similarity And Recommendation Flows

### Similar Companies

- Use `find_similar_companies` when the user asks for competitor-like, lookalike, or adjacent-account discovery.
- If the reference company is ambiguous, resolve it before the similarity call.
- If the user wants a usable market list rather than raw similarity results, enrich the final shortlist just enough to supply requested basics such as website, location, employee range, or a concise description.

### Similar Contacts

- Resolve `referencePersonId` with `search_contacts` when the user gives a name.
- Resolve `targetCompanyId` with `search_companies` when the user wants lookalike contacts inside a specific account.
- Explain recommendations using returned metadata rather than making up a similarity rationale.

### Recommended Contacts

- Resolve the target company first.
- Choose the recommendation use case that matches the user intent:
  - `PROSPECTING`
  - `DEAL_ACCELERATION`
  - `RENEWAL_AND_GROWTH`
- Explain what the use case means in the final readout when it affects interpretation.
- Treat recommendation scores as ranking signals, not response probabilities or guaranteed success.

## Credit-Aware Behavior

Prefer free or lower-cost discovery steps before credit-consuming enrichment or AI research when the workflow permits it.

- Use `lookup`, `search_companies`, `search_contacts`, and `search_intent` to narrow scope first when appropriate.
- Use `enrich_companies`, `enrich_contacts`, `enrich_intent`, `account_research`, and `contact_research` when the user has asked for the stronger result those actions provide.
- For broad batch requests, make the action scope visible in the answer and avoid unnecessary enrichment of obviously weak candidates.

Do not add friction for a small, clearly requested enrichment task. Do be explicit when the connector result may have consumed meaningful credits or when a narrower rerun would be materially cheaper.

## Failure Handling

- If the connector returns no results, say `no clear ZoomInfo match returned` rather than inventing one.
- If results violate a hard filter, exclude them from the qualified set and mention the mismatch.
- If a required lookup value is unavailable, say which constraint could not be represented cleanly.
- If a research response is thin or generic, preserve the useful parts but label coverage as limited.
- If a recommendation or similarity call yields weak actionability, say what extra enrichment or user context would be needed.
- If the connector behavior appears inconsistent with its own action contract, describe the inconsistency plainly in the answer when it affects completeness or confidence.

## Output Rules

- Prefer compact tables for candidate lists, enrichment outputs, similar-company lists, and contact recommendations.
- Prefer clickable connector-returned links when available; never construct guessed links from opaque IDs.
- Separate:
  - `Qualified matches`
  - `Near matches` when useful
  - `Gaps / connector limitations`
- Keep sourced facts separate from `Inference:`.
- Do not guess emails, phone numbers, exact intent, or confidence levels not surfaced by the connector.
- When the answer depends on connector-reported fields or recommendation metadata, say so directly.
- If the user's request asked for a ranked list, rank by explicit connector signal or stated criteria, not by invisible model preference.

#### Output Format

    # [ZoomInfo Search / Enrichment / Research]

    ## Qualified Matches

    | Company / Person | Key Match Evidence | Useful Detail | Source |
    | --- | --- | --- | --- |
    | [Result] | [Hard filters satisfied] | [Returned field] | [Link or connector source] |

    ## Near Matches

    - [Result + exact mismatch, when useful]

    ## Gaps / Connector Limitations

    - [Missing field, unsupported filter, bounded coverage, ambiguity, or credit-aware next step]

    ---

    {Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

    {Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
