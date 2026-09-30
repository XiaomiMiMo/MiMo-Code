# Source Intake

Use this reference to gather enough information to build a source-backed semantic-layer skill without turning intake into a long questionnaire.

## Minimum Viable Intake

Proceed when the user gives enough useful context or sources to organize a layer, such as:

- a target product, feature, business area, metric, dashboard, report, table, question, or team;
- at least one starting source, such as a table namespace, verified dashboard, raw SQL query, data doc, code repository, notebook, team communication channel, or existing local skill;
- permission to read the supplied sources, when permission is not already implied by the user's request and available connectors.

Do not require the user to name the product or business area up front. Infer the likely organizing area from the supplied context, split unrelated areas when needed, and ask a concise follow-up only when the missing answer changes the crawl or destination materially. Good first follow-ups are: "Should I split these into separate semantic layers?", "Which source should I treat as canonical if these disagree?", or "Where should the generated skill live?"

## Multiple Areas

Create separate semantic-layer skills for separate product or business areas by default. If the user asks for multiple areas, collect a target area and source inventory for each one, then run the crawl and synthesis separately so each output stays compact and triggerable. Use a shared/common semantic layer only when multiple areas depend on the same substantial set of canonical metrics, tables, joins, or caveats.

## Starting Point Menu

Ask for any starting points the user has and explain why each kind can help. Tailor the menu to source lanes they have not already supplied instead of repeating known inputs. Do not imply that all inputs are required.

Infer useful source families from the user's question even when they do not name connectors. For metric-heavy requests, expect structured data plus metric docs, dashboards, or reviewed SQL. For definition or business-context requests, expect docs and team communication. For freshness, lineage, or grain questions, expect table metadata, transformation code, or owner notes. Use connected apps that can satisfy those source families, but do not treat ambient app availability as user approval to create a layer.

Use or adapt this intake prompt:

```text
Set Up Data Context

Data Analytics gets better at its work when it understands the metric definitions, tables, filters, and source-of-truth context your team already uses.

Send anything you would point a new analyst to. I'll organize what you send into reusable guidance for future analysis.

Good starting points:
1. What this should help with, like a product or business area.
2. The source of truth for definitions or logic, like transformation code or repos, metric docs, a trusted data skill, reviewed SQL, dashboards, or recurring reports.
3. Data tables or catalogs you frequently use.
4. Places where data definitions, caveats, or changes are discussed, like team channels or threads.

Use structured intake when available, but do not include an explicit `Skip for now` option because the native form already has a skip action. Include a `Starting points` freeform field for the user to paste context, links, table names, dashboard names, repo paths, channels, or notes. Do not include `Add starting points` as a selection option when starting points are collected through the freeform field; the user can skip through the structured intake skip action or the fallback `skip for now` path. If the structured response action is skipped or canceled, or if it returns an empty answer list or empty submission, record the semantic-layer setup as skipped or deferred and proceed to the hero-prompt step instead of asking for starting points again.
```

If the user supplies only a broad area name and no starting points or useful context, ask for one or more starting points from this menu before crawling. If they already supplied starting points or useful context, organize those inputs, ask once for any missing high-value lane only when it would materially improve coverage, then proceed from the available inventory. If they cannot provide any starting points, offer a draft-only semantic-layer skill skeleton and label it as ungrounded.

## High-Value Inputs

Request these inputs when available, and record unknowns explicitly when they are not available:

| Input | What To Ask For | Why It Matters |
| --- | --- | --- |
| Scope | Product, metric, dashboard, report, audience, or business question | Sets skill scope and trigger language |
| Canonical guidance | Transformation code, data docs, metric dictionaries, trusted data skills, or source-backed semantic layers | Supplies authoritative metric, table, grain, and exclusion rules |
| Existing analysis | Verified dashboards, reviewed SQL, notebooks, reports, or recurring analyses | Shows how definitions are used in practice |
| Data entry points | Tables, schemas, catalogs, namespaces, warehouses, or workspaces | Provides table metadata, lineage, grain, joins, freshness, and query history |
| Team context | Channels, threads, owner notes, or announcement windows | Captures corrections, deprecations, and known gotchas |
| Destination and boundaries | Target skill location, source permissions, sensitivity limits, freshness needs, and automation preference | Keeps creation, crawling, and future updates within the user's intent |

## Source Coverage Levels

Use these labels in final output:

- `Limited`: one useful source was crawled, but important lanes are missing.
- `Directional`: two or more lanes agree on core tables or metrics, but gaps remain.
- `Strong`: authoritative docs or transformation code plus dashboard or table evidence support the key facts.
- `Conflicted`: important definitions disagree and need user or owner resolution.
- `Blocked`: required connector, permission, source, or destination is unavailable.

## Intake Defaults

- Prefer direct links, table names, repo paths, and channel names over broad descriptions.
- Treat verified dashboards and transformation code as higher-value starting points than team communication discussion.
- Use recent query history and team communication discussion as observed behavior, not as canonical definitions by default.
- If the user says "build what you can", produce a partial skill and name the missing source lanes.
- After a direct creation or refresh with a usable source inventory, offer weekly polling as an optional follow-up instead of assuming the user wants a recurring automation.
- If the user asks only for a source audit, stop before creating files and return a crawl plan plus coverage assessment.
