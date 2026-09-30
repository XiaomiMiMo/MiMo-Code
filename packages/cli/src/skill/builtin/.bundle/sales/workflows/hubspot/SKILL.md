---
name: hubspot
description: Use only when a focused Sales workflow has selected a connected HubSpot CRM, or the user explicitly asks for HubSpot guidance, reads, drafts, notes, or reviewed record changes. Do not use when another CRM is authoritative.
---

# HubSpot User Guide

Prepare trustworthy HubSpot-backed context or a safely reviewed HubSpot action while keeping the surrounding Sales workflow authoritative for the business task.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices.

## HubSpot Operation Ranking

Use this priority order when the requested HubSpot job or record is ambiguous.

1. Explicit user request, named record, HubSpot ID, company, deal, contact, ticket, or stated action
2. Read-only CRM context needed by the active Sales workflow
3. Exact record or a high-confidence candidate resolved from the user's words and business context
4. The smallest property set, associations, activity context, or page of results that answers the request
5. A reviewed draft of proposed HubSpot changes
6. An explicitly approved, supported HubSpot write followed by verification

Do not silently pick among plausible records, broaden a read into a write, or treat clarification as write approval.

## Key Dependency Categories

These are particularly important for this workflow; use your best judgment to potentially include other data sources to improve quality.

- ~~CRM, specifically the exposed HubSpot connector, for HubSpot-backed identity, records, properties, associations, links, and approved writes
- The parent Sales workflow for Calendar, Meeting Transcripts, Email, Internal Messaging, Knowledge & Files, or Sales Intelligence context that HubSpot does not own
- User-provided record IDs, names, exports, property values, and business context when connector access is unavailable or a record needs disambiguation

If HubSpot is missing, unavailable, stale, ambiguous, or limited by the exposed connector surface, say so and label the answer as not HubSpot-backed.

## Workflow Guidance

These HubSpot-specific steps override the default workflow in the index skill.

- 1. Resolve access and target
    - Use get_user_details first to confirm the connected portal and exposed object read/write availability.
    - Resolve whether the user wants a read, a draft, or an approved write; identify object type, owner or team, pipeline, timeframe, stage, and exact record when those affect the answer.
    - For an ambiguous record, do the smallest bounded candidate lookup and ask the user to choose before using it for a summary or write.
- 2. Discover properties and records
    - Use search_properties with at most five focused keywords when fields are uncertain; use get_properties to confirm enum values and writable properties.
    - Use search_crm_objects for search, counts, filters, pagination, and associations. Use get_crm_objects for known IDs. Do not use deprecated search or fetch.
    - Retrieve only the properties and associations that affect the sales decision. State filters, totals, page or sample limits, and whether analysis is sampled.
- 3. Draft, approve, and verify
    - For proposed changes, show an exact field-level draft before calling manage_crm_objects.
    - Write only after the user explicitly approves the exact reviewed change or batch. Batch at most 10 objects and confirm associations separately.
    - A reviewed-batch approval applies only to that exact batch; never offer a blanket confirmation bypass.
    - Inspect the write response and verify with a narrow read when the response does not prove the outcome.

## HubSpot Rules

- Prefer exact IDs, domains, emails, and full names plus company over vague name-only matching.
- Before querying or writing with a property or enum, confirm property labels, internal names, enum values, and writeability; do not guess them.
- Keep HubSpot as CRM truth for HubSpot-owned account, contact, deal, ticket, owner, pipeline, and activity facts. Do not let enrichment or web context overwrite CRM truth.
- Include clickable connector-returned or trusted HubSpot record URLs with UTM parameters when available.
- Do not write inferred data, overwrite user-entered context without clear consent, or mutate an association without explicit approval.
- Do not imply support for objects, properties, pagination behavior, bulk sizes, or writes that the live connector does not expose.

## Connector Boundary

Use only the HubSpot surfaces that are actually exposed:

- Identity and access: get_user_details
- Property discovery: search_properties, get_properties
- Record search and reads: search_crm_objects, get_crm_objects
- Reviewed writes: manage_crm_objects

For unsupported broad exports, delete, merge, dedupe, arbitrary automation, or unexposed object operations, state the missing surface and offer a narrower read, a draft, or another approved source.

## Modes

### 1. HubSpot Read

- Use for company, deal, contact, ticket, owner, activity, property, or association context.
- Resolve the target, retrieve only decision-relevant fields, and call out ambiguity or gaps.

#### Output Format

    # [HubSpot Record Or Context]

    ## Summary

    - [Most important CRM fact with trusted link]
    - [Current deal, company, contact, activity, or association signal]
    - [Risk, missing property, ambiguity, or source gap]

    ---

    {Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

    {Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}

### 2. HubSpot Update Draft

- Use when the user asks to prepare a note, property change, association, create, or update but has not approved the write.
- Keep current and proposed values separate and identify the exact target.

#### Output Format

    # Proposed HubSpot Update

    **Target:** [Record name, type, and trusted link or ID]

    | Property / Association | Current Value | Proposed Value | Reason / Source |
    | --- | --- | --- | --- |
    | [Label] | [Current or Unknown] | [Proposed] | [Grounded reason + link] |

    ## Before I Write

    - [Missing input, association confirmation, validation risk, or approval needed]

    ---

    {Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

    {Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}

### 3. Approved HubSpot Write

- Use only after explicit approval for the exact reviewed object or batch.
- Verify before reporting completion when the write response is inconclusive.

#### Output Format

    # HubSpot Updated

    **Record:** [Name, type, and trusted link or ID]

    - **Changed:** [Property or association]
    - **Result:** [Verified outcome]
    - **Not changed:** [Unsupported or skipped item]

    ---

    {Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

    {Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
