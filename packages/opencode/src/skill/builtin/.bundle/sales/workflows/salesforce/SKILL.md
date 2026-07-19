---
name: salesforce
description: Use when a focused Sales workflow needs Salesforce-backed CRM reads, links, drafts, notes, account plans, Agentforce assignments, or explicitly requested Salesforce connector/query guidance. Do not use for generic CRM app construction or when another CRM is authoritative.
---

# Salesforce User Guide

Prepare a sales person with trustworthy Salesforce context or a safely reviewed Salesforce action, while keeping the surrounding Sales workflow authoritative for the business task.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices.

## Salesforce Operation Ranking

Use this priority order when the requested Salesforce job or record is ambiguous.

1. Explicit user request, named record, Salesforce id, account, opportunity, contact, lead, or stated action
2. Read-only context that helps the active Sales workflow make a decision
3. Exact record or high-confidence candidate resolved from the user's words and business context
4. The smallest field set, activity history, account plan, event, or transcript context that answers the request
5. A reviewed draft of proposed Salesforce changes
6. An explicitly approved, supported Salesforce write followed by verification

Do not silently pick among plausible records, broaden a read into a write, or treat clarification answers as write approval.

## Key Dependency Categories

These are particularly important for this workflow; use your best judgment to potentially include other data sources to improve quality.

- ~~CRM, specifically the exposed Agentforce Sales/Salesforce connector, for Salesforce-backed reads, record links, account plans, transcript summaries, Agentforce Lead Nurturing assignments, and approved writes
- The parent Sales workflow for Calendar, Scheduling, Meeting Transcripts, Email, Internal Messaging, Knowledge & Files, or Sales Intelligence context that Salesforce does not own
- User-provided record ids, names, exports, field values, and business context when connector access is unavailable or a record needs disambiguation

Avoid unsupported claims. If Salesforce is missing, unavailable, stale, ambiguous, or limited by the exposed connector surface, state the limitation.

## Workflow Guidance

Adhere strictly to these workflow steps. These override the default workflow in the index skill.

- 1. Clarify and Gather Context
    - Resolve the Salesforce task, target record, requested detail, and whether the user wants a read, draft, or approved write.
    - For an ambiguous record, do the smallest exact or bounded candidate lookup, then ask the user to choose before using the record for a summary or write.
- 2. First draft
    - Prefer read-only discovery and the smallest correct record read or query. Use labels in user-facing output and include clickable record links when a trusted URL is available.
    - For proposed changes, render a reviewed field-level draft with assumptions, source gaps, and the exact approval still needed.
- 3. Approved action and verification
    - Write only when the user explicitly asks for the write or approves the reviewed draft/update.
    - Confirm the target record and supported fields before writing, send only intended changes, inspect the response, and verify with a narrow read when the response does not prove the outcome.

## Overall Rules

- Always cite sources using hyperlinks when useful links are available.
- Keep the parent workflow authoritative for the sales task; this guide owns Salesforce-specific lookup, query, links, account-plan actions, assignment, and write safety.
- Prefer discovery over guessing. Use exact ids or names first, then bounded candidates, then user choice when ambiguity remains.
- Do not imply support for connector surfaces that are not exposed.
- Do not delete, upsert by external id, call arbitrary automation, or execute a write without explicit approval.

## Connector Boundary

Use only the Agentforce Sales surfaces that are actually exposed:

- Metadata and identity: describe_global, describe_sobject, get_user_info
- Record lookup and reads: get_record_id_by_name, get_record_details, get_activity_history
- Querying: soql_query only
- Sales-specific reads: query_calendar_events, get_account_plan, query_agent_type, summarize_conversation_transcript
- Writes and mutating workflows: create_record, update_record, create_account_plan, assign_target_to_sdr

Do not imply support for SOSL, global text search, query continuation, Bulk API, Composite API, Data 360, Tableau Analytics, Prompt Builder, Flow invocation, arbitrary invocable actions, generic Apex REST, delete, or upsert-by-external-id. For unsupported cross-object keyword search, large exports, high-volume writes, delete/upsert, or analytics requests, state the missing surface and ask for a narrower object, field, exact identifier, or another approved tool.

## Salesforce Query And Write Rules

### Discovery And Reads

- Salesforce is required for Salesforce-backed reads, links, account plans, assignments, transcript summaries, and writes. If it cannot be used, label the answer as not Salesforce-backed.
- Use get_user_info for my, me, or current-owner requests. Use describe_global for uncertain objects and describe_sobject before non-obvious queries or writes.
- Confirm API names, labels, data type, filterability, createability, updateability, nullability, picklists, references, relationship names, and record types only when they affect the task.
- Do not guess relationship names. Treat broad wildcard matches as candidates, use business context to disambiguate, and ask before a summary or write if one targeted filter will not resolve the record.
- Use get_record_id_by_name when a name must become an id, get_record_details for presentation-ready layout context, get_activity_history for activity summaries, query_calendar_events for Salesforce Events, and get_account_plan for account strategy context.
- Resolve a specific VoiceCall or VideoCall id before summarize_conversation_transcript. If the call is unknown, query VoiceCall and VideoCall separately, then ask which call to summarize.

### Query Guardrails

- For non-trivial SOQL, identify the target object, needed fields, filters, sort or limit, display-versus-analysis purpose, and selectivity risk.
- Use the simplest correct query with only needed fields, include Id when rows may be linked or reused, add a reasonable LIMIT, and filter only on fields Salesforce reports as filterable.
- Do not send aggregate or grouped SOQL, including COUNT, SUM, GROUP BY, or aggregate aliases. Retrieve a bounded id-bearing set and summarize locally, or state that exact aggregate coverage is unavailable.
- Do not filter on long text, rich text, Task.Description, history OldValue/NewValue, IsPriorityRecord, or other readable-but-unfilterable fields. Bound by parent, date, owner, status, or another filterable field and post-filter locally when bounded.
- Use INCLUDES or EXCLUDES only for multipicklists. Scope FieldDefinition queries to a known entity, keep each OR disjunction scoped to one field, and split cross-field discovery before merging locally.
- Prefer standard Account, Opportunity, Contact, Task, and Event fields before optional or custom fields. After two focused schema or query-shape failures for the same fact, fall back to safer standard fields, exact reads, a narrower request, or a clear evidence gap.
- Distinguish explicit reauthentication errors from runtime readiness failures.

### Writes And Links

- For update_record, send only changed fields. For create_record, send only intended fields and include record type fields only when they affect defaults, picklists, or createability.
- Do not probe writes to discover validation rules. If Salesforce returns FIELD_CUSTOM_VALIDATION_EXCEPTION, surface the exact message and ask for the missing or corrected business value.
- Use create_account_plan instead of generic record creation for account plans. Resolve AccountId and gather or derive Name, challenge, competitive, relationship, strategy, StartDate, and Status first; report unsupported AccountPlan errors plainly.
- Before assign_target_to_sdr, call query_agent_type, present available agents, and get the user's selection. The target must be a Contact or Lead id.
- Inspect every write response and verify with returned fields, get_record_details, or a narrow soql_query when the response does not prove the outcome.
- Prefer a connector-returned record URL. If a trusted org or instance base URL is available, construct the Lightning record URL; otherwise show the object label and id instead of inventing a link.

## Modes

### 1. Salesforce Read

- Use when the user or a parent Sales workflow needs account, opportunity, contact, lead, activity, event, account-plan, or transcript context.
- Resolve the target first, retrieve only the fields and history that affect the sales decision, and call out gaps or ambiguity.

#### Output Format

```md
# [Record Or Salesforce Context]

## Summary

- [Most important CRM fact with source link]
- [Current account, opportunity, contact, activity, or plan signal]
- [Risk, missing field, ambiguity, or source gap]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

### 2. Salesforce Update Draft

- Use when the user asks to prepare a CRM update, note, field change, or create action but has not yet approved the write.
- Keep proposed values separate from current values and identify the target record, assumptions, and required approval.

#### Output Format

```md
# Proposed Salesforce Update

**Target:** [Record name, type, and trusted link or id]

| Field | Current Value | Proposed Value | Reason / Source |
| --- | --- | --- | --- |
| [Field label] | [Current value or Unknown] | [Proposed value] | [Grounded reason + link] |

## Before I Write

- [Missing business input, validation risk, or approval needed]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

### 3. Approved Salesforce Write

- Use only after the user explicitly asks for the supported write or approves the reviewed draft.
- Verify the result before reporting completion when the write response is not conclusive.

#### Output Format

```md
# Salesforce Updated

**Record:** [Record name, type, and trusted link or id]

- **Changed:** [Field or supported action]
- **Result:** [Verified outcome]
- **Not changed:** [Any requested item that was unsupported or skipped]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

### 4. Account Plan, SDR Assignment, Or Transcript

- Use when the user explicitly asks for an account plan, Agentforce Lead Nurturing assignment, Salesforce event, or voice/video transcript summary.
- Resolve the required record or call id first. For an SDR assignment, show available agents and get the user's selection before assigning.

#### Output Format

```md
# [Account Plan / SDR Assignment / Transcript Summary]

## Target

- [Resolved account, contact, lead, event, or call + trusted link]

## Result

- [Supported read, draft, or verified action]
- [Important limitation or missing required input]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```
