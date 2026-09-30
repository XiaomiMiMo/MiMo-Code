# Signal taxonomy for analyze-account-signals

Normalize evidence into these signal types only. Do not invent ad hoc signal labels unless the skill is explicitly extended later.

## Signal types

### `momentum`
Use for:
- successful rollout motion
- confirmed usage growth
- strong stakeholder engagement
- recent progress against an agreed workstream

Default action style:
- reinforce momentum
- propose the next expansion or adoption step

### `expansion_opportunity`
Use for:
- new use-case demand
- broader stakeholder interest
- adjacent product fit
- evidence that the account is ready for a bigger deployment or new motion

Default action style:
- suggest a concrete land-or-expand move
- tie it to the active problem, team, or upcoming milestone

### `churn/risk`
Use for:
- stalled workstreams
- declining engagement
- unresolved blockers with customer impact
- explicit dissatisfaction, delay risk, or loss of momentum

Default action style:
- propose a risk-reduction intervention
- identify the owner or forum that should address it next

### `blocker/dependency`
Use for:
- technical blockers
- procurement/security dependencies
- internal approvals
- cross-functional dependencies holding up progress

Default action style:
- clarify dependency ownership
- define the next unblock step

### `stakeholder_movement`
Use for:
- new champions
- executive involvement
- stakeholder loss or turnover
- changes in ownership or buying committee shape

Default action style:
- recommend relationship mapping, revalidation, or executive alignment

### `upcoming_commitment_or_deadline`
Use for:
- scheduled workshops
- upcoming customer meetings
- delivery commitments
- target dates or deadlines that change near-term priority

Default action style:
- prepare for the milestone
- verify readiness and owners

### `evidence_gap`
Use for:
- conflicting source data
- unresolved ambiguity
- thin recent updates
- missing supporting evidence that materially lowers confidence

Default action style:
- name the missing input
- suggest the smallest next evidence-collection step

## Required fields per signal

Each signal must store:
- `signal_type`
- `summary`
- `source`
- `recency`
- `confidence`
- `evidence`
- `citation`
- `recommended_next_step`

## Confidence guidance

Use a simple three-level confidence scale:
- `high`: corroborated by a strong source or multiple agreeing sources
- `medium`: plausible and useful, but partially inferred or lightly corroborated
- `low`: weak, stale, or contradictory evidence; use mainly to frame uncertainty

Rules:
- recent ~~CRM activity or corroborated communication evidence can support `high` confidence on recent account-state changes
- multi-source corroboration raises confidence
- unsupported interpretation must not be labeled `high`
- conflicting evidence should lower confidence and usually produce an `evidence_gap` signal

## Recency guidance

Prefer these recency buckets:
- `fresh`: within the requested time window and clearly relevant now
- `recent`: slightly older but still important to current motion
- `stale`: older context that may matter but should not dominate prioritization

For `monitor` mode:
- prioritize `fresh` signals
- down-rank `stale` signals unless they represent unresolved material risk

## Ranking guidance for `monitor`

Rank accounts higher when:
- there is a fresh `churn/risk` or `expansion_opportunity` signal
- the account has more than one corroborating source
- the recommended next step is clear and near-term

Rank accounts lower when:
- the evidence is single-source and weak
- the signal is mostly historical context
- the account has no material delta during the time window

## Delta classification for `monitor`

When a monitor run includes a material-delta section, classify each delta as one of:
- `new`: newly observed signal in the selected time window
- `updated`: previously known signal with meaningful new detail
- `worsened`: risk, blocker, or negative posture became more severe
- `resolved`: previously active risk/blocker appears closed based on current evidence
- `unchanged`: still active but no meaningful movement (include only when necessary for context)

## User-facing label mapping for `monitor`

Use these display labels in user-facing monitor output instead of raw enum tokens:

- signal labels:
  - `momentum` -> `Momentum`
  - `expansion_opportunity` -> `Expansion opportunity`
  - `churn/risk` -> `Churn or retention risk`
  - `blocker/dependency` -> `Blocker or dependency`
  - `stakeholder_movement` -> `Stakeholder movement`
  - `upcoming_commitment_or_deadline` -> `Milestone or deadline`
  - `evidence_gap` -> `Evidence gap`
- status labels:
  - `new` -> `New this period`
  - `updated` -> `Updated this period`
  - `worsened` -> `Worsened this period`
  - `resolved` -> `Resolved this period`
  - `unchanged` -> `No change this period`
