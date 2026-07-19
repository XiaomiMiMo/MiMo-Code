# Organization Context Guidance

Use this file only as generic guidance for applying organization-specific terminology after the generic search workflow is already working.

This generalized version intentionally ships without company-specific product names, channel patterns, URLs, process names, source priorities, or boost rules. Do not add those facts to this bundled file. Use user-provided context or connector-visible source truth.

## How To Apply

1. Run the generic workflow first.
2. Apply user-provided or connector-visible terminology, aliases, and team names as query expansions.
3. Apply any local boost rules only after base scoring.
4. Cap total company-context boost per candidate at `+0.25`.

## Good Grounded Inputs

- product or team names
- known abbreviations or legacy names
- canonical wiki or docs hubs
- internal language for recurring processes

## Guardrails

- Do not let local boosts overpower base relevance.
- Do not use this file to hardcode one company's ownership model into the generic skill.
- Keep future company-specific additions outside the plugin package, in user-provided context or source systems.
