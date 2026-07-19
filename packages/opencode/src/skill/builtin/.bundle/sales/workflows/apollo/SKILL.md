---
name: apollo
description: Use only when a focused Sales workflow has selected a present and connected Apollo connector, or the user explicitly asks for Apollo prospecting, enrichment, Company Details, records, sequences, or outbound planning. Apply Apollo v2-specific behavior only after verifying app version 2.0.0 or later.
---

# Apollo User Guide

Use Apollo for focused Sales Intelligence work after the parent Sales workflow selects it. Keep the parent workflow authoritative for the seller's task; this guide owns Apollo-specific version, credit, identifier, mutation, and outbound safety rules.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices.

## Apollo Version Gate

This guide's v2-specific behavior applies only when Apollo app version >= 2.0.0 is verified from visible app metadata, platform context, or explicit v2-only surfaces.

- V2-only evidence includes exposed company-search or Company Details preview wrappers, bulk account or contact create-update, sequence create-update, schedule lookup, campaign or sequence approval, or standalone Apollo usage-stats credit tooling.
- Generic People Search, Contact Search, Organization Search, enrichment, email account lookup, single-record create-update, sequence search, add/remove sequence contacts, job postings, or analytics do not prove v2.
- If version is unknown, unavailable, or below 2.0.0, do not apply v2-only assumptions or call v2-only mutations, enrollment, activation, or v2-only credit-consuming flows. Generic enrichment can still proceed under the normal Apollo-credit approval rules; otherwise explain the limitation.

## Apollo Operation Ranking

1. Explicit user request, named company or person, domain, email, Apollo ID, sequence, or stated action
2. The narrowest read-only lane needed by the active Sales workflow
3. Strong identifier resolution and a compact candidate preview
4. Search and shortlist before credit-consuming enrichment or Company Details
5. A reviewed mutation or launch preview
6. An explicitly approved exact action followed by verification

Never turn a draft, search, clarification, or general approval into a mutation, enrollment, activation, or send.

## Key Dependency Categories

These are particularly important for this workflow; use your best judgment to potentially include other data sources to improve quality.

- ~~Sales Intelligence, specifically a present and connected Apollo connector, for Apollo prospecting, enrichment, Company Details, records, and sequence planning
- ~~CRM for customer status, opportunity facts, ownership, and forecast truth
- The parent Sales workflow for Email, Calendar, Meeting Transcripts, Internal Messaging, or Knowledge & Files context
- User-provided names, domains, emails, IDs, ICP constraints, sequence intent, and approval when connector context is incomplete

If Apollo is missing, unavailable, ambiguous, version-limited, or unsupported by the exposed surface, state the limitation.

## Connector Boundary

Choose the narrowest Apollo lane that fits the request. Use the live Apollo tool schema; do not invent replacement tools when a named action is unavailable.

- Identity and Apollo credit awareness: user profile and credit usage reads.
- Discovery: People Search, Contact Search, Organization Search, existing sequence search, and email account lookup.
- Company Details and enrichment: organization enrichment, bulk organization enrichment, people enrichment, bulk people enrichment, and organization job postings when exposed.
- Account/contact records: account create-update, contact create-update, and bulk account/contact create-update when exposed.
- Sequences and launch: sequence search, sequence create-update when exposed, schedule lookup when exposed, sender account lookup, sequence approval or activation when exposed, add contacts to sequence, and remove or stop contacts from sequences.
- Analytics: read-only Apollo sales analytics reports when relevant.

Do not present Apollo as CRM ground truth. Apollo can support prospecting, enrichment, contactability, account/contact record preparation, and outbound sequence work; CRM-owned customer status, opportunity facts, ownership, and forecast truth should still come from ~~CRM when available.

## Credit-Aware Behavior

Say "Apollo credit," not "API credit."

Before broad, open-ended, or credit-consuming Apollo work, make the scope and likely Apollo credit exposure visible and get explicit approval. Credit-consuming actions commonly include Company Search, Organization Search, Company Details or organization enrichment, people enrichment, bulk enrichment, job postings, and any other Apollo tool whose live description says it consumes credits.

Use free or lower-cost narrowing steps first when practical:

1. Search or resolve the working set.
2. Show a compact preview of the candidates, filters, and count.
3. Ask for approval before credit-consuming enrichment or Company Details.
4. Enrich only the selected or materially useful rows.

Do not add unnecessary friction for a small, clearly requested lookup when the live tool policy already permits it, but still mention Apollo credit use when the action consumes meaningful credits.

## Search And Resolution

### People And Contacts

- Use People Search for net-new prospects in Apollo's database. It should not be treated as returning raw email addresses or phone numbers unless the live tool response explicitly does so and the user has asked for contactability.
- Use Contact Search for contacts already added to the team's Apollo account.
- Combine title, seniority, company/domain, location, technology, company size, and revenue filters when they improve precision.
- If the user's persona phrase is ambiguous, state one concise assumption instead of stopping.
- For broad role families, prefer one well-scoped search with combined title variants when the schema supports it; split only when the first pass is sparse or off-target.
- Do not infer missing emails, phone numbers, LinkedIn profiles, or confidence scores.

### Companies

- Prefer domains, Apollo organization IDs, or exact company names plus location/industry when resolving companies.
- For company-only discovery, preview the filters and possible Apollo credit exposure before running a credit-consuming company search.
- Keep company-only results company-only: do not add people columns, contactability labels, or outreach actions unless the user separately asks for contacts.
- If name-only rows are ambiguous, leave them unresolved or ask for domains rather than guessing.

### Identifiers

Use Apollo-returned IDs internally when a downstream Apollo action requires them. Do not fabricate account IDs, contact IDs, organization IDs, person IDs, sequence IDs, sender account IDs, schedule IDs, preview keys, or confirmation flags.

Do not expose internal IDs in ordinary seller-facing output unless the user is explicitly debugging an Apollo integration, validating connector behavior, or preparing an admin handoff that needs exact identifiers.

## Enrichment And Company Details

Use Company Details language for Apollo organization enrichment when it produces firmographic context such as employees, industry, location, description, funding, revenue, corporate phone, or related company facts.

For People to Company Details:

1. Convert the seller's ICP into focused people filters.
2. Run the appropriate people or contact search.
3. Show the people table first.
4. Offer Company Details as the next step.
5. Preview the selected company domains or organizations and Apollo credit exposure.
6. Ask for explicit approval.
7. After approval, run Company Details and show the combined table.

For people enrichment:

- Prefer the strongest available identifiers: Apollo person ID, business email, LinkedIn URL, domain plus name, or company plus name.
- Bulk people enrichment should stay within the live tool's batch size and should be limited to the rows the user needs.
- Keep `reveal_personal_emails` false by default. Use any personal-email or phone reveal option only when the user explicitly asks, the live tool policy supports it, and the action is lawful and appropriate for legitimate B2B work.

## Mutations

Account/contact create-update tools are mutation-risk tools. Use them only after a reviewed preview and explicit confirmation.

Before account/contact creates:

- Normalize the proposed records.
- Show key fields and the intended action.
- Warn that Apollo may create duplicates when dedupe is not supported or not enabled.
- Use dedupe options when the live tool supports them unless the user explicitly asks not to.

Before account/contact updates:

- Require verified existing Apollo account/contact IDs from prior tool results or clear user-provided IDs.
- Show a field-level before/after diff.
- Send only intended changed fields.
- Never use create/update tools for search, preview, analysis, or draft-only requests.

If bulk account/contact tools are exposed, apply the same preview, duplicate-risk, ID, and confirmation gates to the full batch. Do not split a risky batch into multiple mutations to bypass review.

## Sequences And Launch

Separate drafting, creation/update, enrollment, activation, and sending. Never bundle launch-risk actions together.

Ordinary seller-safe sequence work may include:

- Searching existing sequences by name or audience.
- Reviewing or drafting sequence content in chat.
- Looking up sender accounts for planning.
- Inspecting schedules when a read-only schedule lookup is exposed.

Mutation or launch-risk sequence work requires explicit approval after a preview or diff:

- Sequence creation or update, when exposed, requires a reviewed payload. Default new sequences to inactive when the live schema supports an active flag.
- Sequence update requires a verified existing sequence ID, current state, a clear diff, and explicit confirmation.
- Sequence approval, activation, or campaign approval is critical launch risk and requires a separate explicit confirmation. Never activate by default.
- Adding contacts to a sequence can send real emails. First search and disambiguate the sequence, retrieve valid sender email accounts, show the sender, sequence name, number of contacts, and active/paused enrollment status, then wait for explicit confirmation before enrolling.
- Removing or stopping contacts from sequences requires verified contact IDs, verified sequence IDs, the mode, and confirmation. For stop actions, capture the stop reason when the live schema requires or benefits from it.

Do not enroll contacts, activate sequences, approve campaigns, or start sending unless the user has approved that exact reviewed action and the live Apollo surface supports it.

## Safety Rules

- No raw personal email or phone reveal by default.
- No Apollo credit-consuming Company Search, Organization Search, Company Details, people enrichment, organization enrichment, bulk enrichment, or job-posting lookup without making Apollo credit exposure visible and getting approval when the action is broad, batch, Company Details, or otherwise material.
- No account/contact mutation without preview and explicit approval.
- No sequence creation, update, activation, approval, enrollment, removal, stopping, or sending without the relevant reviewed workflow gate.
- No generic "high Buying Intent" claims unless Apollo returns a supported intent or signal field that matches the user's requested concept.
- No production-readiness claims from local, mock, prototype, or simulation evidence.
- Preserve safe partial work when a request is blocked: show the search, preview, draft, diff, or planning step that can be done safely.

## Output Rules

Use seller language:

- Say "Company Details," not "account context."
- Say "Apollo credit," not "API credit."
- Say "sequence draft," "inactive sequence," "reviewed diff," "enrollment confirmation," or "activation confirmation" precisely.

Prefer compact tables:

- People Search: First, Last, Title, Company, Domain, Location, Email Availability, Phone Availability.
- People plus Company Details: First, Last, Title, Company, Domain, Employees, Industry, Location, Description, Email Availability, Phone Availability.
- Company Search or company-only: Company, Domain, Employees, Industry, Location, Description.
- Existing sequences: Name, Active, Archived, Steps, Max Emails Per Day.
- Sender accounts: Sender Account, Active, Verified, Warmup.
- Batch preview: Record, Key Fields, Risk, Action.
- Batch update diff: ID Source, Record, Field, Current, Proposed.

Prefer clickable connector-returned links when available; never construct guessed links from opaque IDs.
Keep sourced facts separate from `Inference:`. If a requested row or field is not returned, say so instead of filling it in.

Avoid raw tool names in seller-facing prose unless the user is explicitly discussing connector validation, evals, implementation, or admin troubleshooting.

#### Output Format

    # [Apollo Search / Company Details / Sequence Plan]

    ## Results

    | Company / Person / Sequence | Key Evidence | Useful Detail | Status |
    | --- | --- | --- | --- |
    | [Result] | [Returned signal] | [Returned field] | [Qualified, Near, Draft, or Needs approval] |

    ## Before Any Action

    - [Credit exposure, ambiguity, reviewed diff, sender/enrollment gate, or exact approval needed]

    ## Gaps / Limitations

    - [Missing field, version gate, connector surface, or source limitation]

    ---

    {Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

    {Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
