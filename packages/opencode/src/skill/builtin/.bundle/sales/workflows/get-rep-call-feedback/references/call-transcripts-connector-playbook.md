# ~~Meeting Transcripts playbook (rep benchmarking)

## Tools
Use the selected ~~Meeting Transcripts App's search and fetch functions:
- search with `query`, optional company/account filters, `date_range`, `limit`, and `score_threshold`
- fetch by connector-specific id from search results

## Critical limitation
Some call-transcript connectors do not reliably filter by attendee or rep email. Therefore:
- Put the rep's **email (or name)** directly inside `query`.
- Expect noisy results; **iterate**.

## Iterative search recipe
Run in loops until you have enough calls.

### A) Start broad
- `query: "<rep_email>"`
- `date_range: {start: <default_start>, end: <default_end>}`

Resolve `<default_start>` and `<default_end>` to absolute dates before the first search. Anchor relative windows on the current runtime date, not on static examples or connector defaults.

### B) Narrow by motion/topic
Try 3-6 of these, based on the user's ask:
- discovery, demo, renewal, pilot, onboarding
- pricing, procurement, security, legal, data, privacy
- objections: budget, competitor, build vs buy, risk

Example queries:
- `"alex@example.com" discovery`
- `"alex@example.com" pricing objection`

### C) If still sparse
- Decrease `score_threshold` stepwise: 0.7 -> 0.6 -> 0.5
- Simplify query: remove topics, keep only email
- Try name variants: `"Alex"`, `"Alex Example"`, `"alex"`

### D) Avoid unfair comparisons
- Prefer peer calls with similar motion (discovery vs discovery, renewals vs renewals)
- If the target is mostly early-stage discovery and peers are late-stage procurement, say so and either:
  1. adjust peer sampling, or
  2. scope feedback to what is comparable.

## Default date ranges
Unless user specifies:
- Target rep: last **1 month**
- Peers: last **2 months**

If the user specifies a date range, use that range for both target and peers unless they explicitly ask otherwise.

Date-window rules:
- Convert `last month`, `last 30 days`, `past 2 weeks`, `this quarter`, and similar windows to explicit start/end dates before calling the connector.
- Treat `last month` as a trailing 1-month window unless the user says `last calendar month`.
- Prefer calendar boundaries only for phrases such as `last calendar month`, `this quarter`, or `last quarter`.
- Include the absolute window used in final dataset coverage so the user can audit the sample.
