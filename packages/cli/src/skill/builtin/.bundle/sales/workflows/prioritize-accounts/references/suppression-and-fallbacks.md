# Suppression And Fallbacks

Apply these rules before returning `Work Now`.

## Hard suppressors

Suppress the account when there is strong evidence that the proposed rep action would duplicate or conflict with motion already in progress, such as:

- an active open opportunity with already-owned seller, SE, or internal-team motion that makes the proposed action duplicative
- a recent or upcoming external meeting already in motion
- clearly active seller, SE, or internal team motion that would make new outreach duplicative

Place these rows in `Suppress Or Block` with `Status=suppressed`.

## Blocking conditions

Block the account when the workflow cannot establish:

- a credible `net_new` or `expansion` branch
- a usable primary contact
- a defensible why-now signal

Place these rows in `Suppress Or Block` with `Status=blocked`.

## Monitoring conditions

Move the account to `Monitor` when:

- fit looks good but timing is weak
- the account should be revisited after a known trigger
- evidence is promising but not yet sufficient for rep action

## Fallback order

Use this order when multiple lanes are available:

1. `crm`
2. user-provided account or contact context
3. `document_store` account context
4. `calendar`
5. `meeting_notes`
6. `external_messaging`
7. `internal_messaging`
8. public research or user-provided market intelligence
9. user-provided enrichment exports

Do not use a lower-confidence lane to overwrite stronger `crm` or user-provided truth.

## Quality rules

- Prefer no row over a fabricated row.
- Prefer `partial` or `blocked` over implied certainty.
- Respect the rep's capacity window even if more accounts could be listed.
