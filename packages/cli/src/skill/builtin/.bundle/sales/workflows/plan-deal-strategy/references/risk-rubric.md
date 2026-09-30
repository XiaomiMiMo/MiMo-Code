# Risk Rubric

Use this rubric for procurement and commercial execution risks.

## Risk Types

- `procurement_process`
- `legal_terms`
- `security_review`
- `privacy_or_data_governance`
- `budget_or_funding`
- `executive_alignment`
- `stakeholder_coverage`
- `timeline_dependency`
- `technical_dependency`
- `other`

## Severity

- `high`: likely to block signature or force a material close-date slip.
- `medium`: can delay momentum or require escalation but not clearly deal-blocking yet.
- `low`: manageable friction with a clear owner and active mitigation.

## Likelihood

- `high`: explicit signal in at least one strong source with no counter-signal.
- `medium`: plausible signal with partial evidence or conflicting context.
- `low`: weak or stale signal; include only if it still matters to execution.

## Confidence

- `high`: corroborated by multiple sources or direct explicit statement from a primary source.
- `medium`: single-source but credible, or partially inferred from clear context.
- `low`: weak, stale, or conflicting evidence.

## Precision Guardrails

- Do not present exact calendar dates unless the date is directly evidenced.
- For low-confidence or sparse-evidence situations, prefer relative timing (`this week`, `next week`, `this month`) or `TBD`.
- Do not present customer-side owners as confirmed unless explicitly supported.
- When customer-side ownership is inferred, label as `Suggested owner`.

## Prioritization

Prioritize next actions by:

1. high severity + high likelihood risks
2. medium severity risks with near-term deadlines
3. stakeholder ownership gaps that prevent unblocking work
4. all remaining risks

## Required risk row fields

Each risk row must include:

- `risk_id`
- `risk_summary`
- `risk_type`
- `severity`
- `likelihood`
- `confidence`
- `owner`
- `mitigation`
- `target_date`
- `source`
