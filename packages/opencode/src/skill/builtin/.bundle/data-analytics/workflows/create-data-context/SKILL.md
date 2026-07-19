---
name: create-data-context
description: "Create, update, inspect, or repair Data Analytics semantic layers. Use when the user asks to save data context or create a semantic layer that future Data Analytics work can inspect and cite."
---

# Create Data Context

This skill creates and maintains semantic-layer skills for Data Analytics. A semantic-layer skill is an explicit artifact the user can inspect and cite later. It captures how future analyses should interpret the data, for example which metric definition is canonical, which dashboard or table is the best source of truth, and what caveats should be checked before answering.

Data-task routing is owned by the Data Analytics `index` skill. If the user wants Data Analytics to do work with data now, route to `index`, whether the work starts from connected sources, uploaded files, pasted tables, sample data, or an existing semantic layer. Examples include answering a metric question, building a report, or checking a dataset.

Use this skill only when the user asks to save data context or create, update, inspect, or repair a semantic layer.

## Runtime Routing

Use the current runtime's classified `surface` and `mode` values, plus the capabilities exposed in the run, to choose intake and persistence. Build and validate the same canonical semantic-layer skill package before writing it to any destination.

For intake:

- Use structured intake when a supported form action is available.
- Use conversational intake for open-ended details and for runtimes without a supported form action.

Choose one persistence destination by default:

| Destination branch | Select this branch when | Action |
| --- | --- | --- |
| ChatGPT personal Skills | `surface = chatgpt_web` and the run exposes a product-backed personal Skills install surface, such as a native skill draft/upload/install action or an installable skill package preview. | Install the generated skill into the user's personal Skills library. Capture the installed skill link or Skills-library reference returned by the install surface and include it as a Markdown link in the chat response. Verify through the available Skills-library, list, or fresh-thread discovery surface when the runtime exposes one. |
| Local Codex | The user asks for local persistence, or `surface = codex_desktop`. | Write a filesystem skill to `$CODEX_HOME/skills/<area>-semantic-layer`; if `$CODEX_HOME` is unavailable and the local runtime clearly uses the default home location, use `~/.codex/skills/<area>-semantic-layer`. Validate the written skill and verify it is discoverable in a new local Codex context when possible. |
| Portable package | The current run has no supported persistent skill destination. | Return a portable skill package or source plan and clearly state that it has not been installed persistently, including the exact persistence blocker. |

For dual ChatGPT web and local Codex availability, install the same canonical package into both the ChatGPT Skills library and the local Codex user-skill directory.

For ordinary data work, return to the Data Analytics `index` workflow.

## Skill Configuration

### Audience And Language

Write for Data Analytics users, not plugin maintainers. Explain what context would improve the current or future analysis in practical terms. Avoid implementation terms such as raw state paths, connector ids, cache, runtime, metadata, or preflight unless the user asks for debugging details.

### Source Links

When referencing sources inline, prefer clickable Markdown links over plain labels whenever a useful URL exists. Use the source title, record name, channel/thread, or meeting/date as the link text. Use plain labels only when no useful link is available.

## Semantic Layer Setup

Use this flow when the user wants to create or maintain a semantic layer. If they are not ready to create the layer yet, use the same flow to produce a short source plan for what the semantic layer needs.

The output is a visible skill or plan. Build the semantic-layer skill when enough source-backed detail exists to make it useful. When the available detail is still thin, return a practical plan that explains what source to collect next and why.

## Creating Or Updating The Layer

Create one semantic layer per coherent product, business, metric, source, or reporting area unless the user explicitly asks for a broader shared layer. Infer the area from the provided context when it is clear; ask only when the answer changes the crawl, destination, or resulting skill.

Choose the destination from `Runtime Routing` using the supported persistence mechanism exposed in the current run. For local Codex creations, default to `$CODEX_HOME/skills/<area>-semantic-layer` unless the user chooses another destination. Ask before placing a generated semantic-layer skill inside a plugin.

Before crawling, build a data-source list that explains what was checked, what is missing, and which sources are lower-confidence. For direct creation or draft-file work, write it to `references/source-inventory.md`; for planning-only work, return it in chat.

Use source-backed evidence. Favor durable sources such as transformation code, tests, maintained metric docs, and verified dashboards over looser signals such as query history or team discussion. If sources disagree, keep the conflict visible instead of choosing silently.

Keep generated semantic-layer skills compact. Put detailed metric definitions, tables, query patterns, caveats, and evidence into linked references using `references/semantic-layer/skill-template.md`. Preserve provenance and avoid copying raw sensitive data, credentials, row-level examples, or long private messages into generated files.

After creating or updating a semantic-layer skill, read `references/semantic-layer/weekly-polling-automation.md` and always offer weekly refresh when the layer has a stable target path and usable `references/source-inventory.md`. Weekly refresh is optional: do not create it without explicit user approval unless the user directly asked for recurring refresh. If the offer cannot be made, state the missing prerequisite.

Return the created or updated path or installed skill link, source coverage, any user-relevant caveats or blockers, future-use guidance, iteration guidance, and the weekly refresh automation offer or prerequisite blocker so the user can cite the semantic layer directly in later prompts. Tell the user they can ask to refine definitions, add sources, update caveats, or adjust the semantic layer as their understanding changes. For ChatGPT personal Skills creations, include the installed skill link in the response.

Keep routine validation details in support artifacts unless a check failed, was unavailable, or changes how the user should rely on the semantic layer.

## Output Contract

For semantic-layer work, report what was created, updated, inspected, or repaired; source coverage; any user-relevant caveats or blockers; and the exact path or installed skill link the user can cite later. For create or update results, include the weekly refresh automation offer or the missing prerequisite that prevented the offer, and let the user know they can iterate on the semantic layer. Keep routine validation details in support artifacts. If the request is ordinary data work, say that it should be routed through `index`.
