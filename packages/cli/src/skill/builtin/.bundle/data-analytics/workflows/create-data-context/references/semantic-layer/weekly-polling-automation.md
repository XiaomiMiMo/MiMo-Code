# Weekly Polling Automation

Use this reference when the user wants the generated semantic-layer skill to stay current by polling the given sources every week.

## When To Offer

Offer weekly polling after semantic-layer creation or refresh when the generated skill has a stable target path and a usable `references/source-inventory.md`. Also offer it when the user asks to keep the semantic layer fresh, monitor sources, watch dashboards, or update the skill if definitions change.

Do not create an automation silently. Ask for approval unless the user already gave a direct instruction such as "set up weekly polling" or "keep this updated every week".

Present the offer as its own user-facing follow-up section or final question, not as a caveat, validation note, or buried automation-status sentence. Use a direct question, for example:

```text
Do you want me to set up weekly source polling for this semantic layer so changes in dashboards, docs, SQL, repos, or team communication are summarized?
```

If weekly polling cannot be offered yet, name the missing prerequisite and ask for the specific input that would unblock it. If polling was already created or updated, state that clearly with the automation name and cadence instead of asking again.

After creating or repairing the automation, read it back through the available automation inspection path before claiming readiness. If readback fails, report the concrete blocker and do not say weekly polling is active.

## Automation Tool

Use the Codex app automation tool, not raw automation directives. If the automation tool is not already available, use `tool_search` to find `automation_update`.

Choose the automation kind by the update model:

- Use a `cron` automation when the job should run as a detached weekly workspace job and can safely read the source inventory and update local skill files.
- Use a `heartbeat` automation attached to the current thread when the user wants weekly review in this conversation, wants to approve changes before writes, or the target files are not safely writable from a detached workspace job.

Prefer updating an existing matching automation over creating a duplicate. Name the automation after the generated semantic-layer skill, such as `<area> semantic layer refresh`.

## User-Facing Updates

Every weekly run must end with a concise user-facing run summary. For a `heartbeat`, post the summary in the attached thread. For a detached `cron`, make the summary the automation run output so the user can review what happened from the automation run history.

Use this summary shape:

- Status: `no change`, `updated`, `blocked`, or `conflicted`.
- Sources checked: list source names and any sources skipped.
- Changes found: summarize source-backed metric, table, query-pattern, caveat, or source-inventory changes.
- Files changed: list local file paths, or say `none`.
- Validation: report pass, fail, or not run.
- Needs review: list conflicts, permission gaps, connector gaps, or proposed changes that were not written.

For no-change runs, explicitly say that no source-backed changes were found and list the sources checked. Do not send a silent or empty update.

## Schedule Defaults

If the user asks for weekly polling but does not specify timing, propose a practical weekly cadence in the user's locale, such as Monday morning. Do not show raw RRULE strings to the user. When creating the automation, pass the schedule through the automation tool fields rather than embedding the schedule in the prompt.

## Prompt Requirements

The automation prompt must be self-contained. Include:

- target semantic-layer skill path;
- source inventory path;
- source precedence and evidence standard;
- update boundary for each source, or an instruction to read it from `source-inventory.md`;
- validation command or validator path when known;
- output expectations for no-change, changed, blocked, and conflicted runs.

Do not include schedule details in the prompt. The schedule belongs in the automation fields.

Use this prompt skeleton and fill in concrete paths and source names:

```text
Poll the source inventory for the <area> semantic-layer skill and update the skill only if source-backed changes are needed.

Target skill: <absolute-or-user-provided-skill-path>
Source inventory: <target-skill>/references/source-inventory.md

Read the source inventory first. For each automation-eligible source, use the listed connector or tool to check for relevant changes since the last checked date. Focus on metric definitions, canonical dashboards, table grain, join keys, freshness, owner notes, deprecations, query patterns, and caveats. Respect the update boundary listed for each source.

Apply this source precedence: transformation code, tests, and authoritative data documentation, including maintained docs, metric dictionaries, source-backed semantic-layer skills, and user-trusted canonical data skills; then verified dashboards; then table metadata and lineage; then query history; then team communication context; then other local skills as supporting context. Do not update from team-communication-only, query-history-only, or generic-local-skill-only evidence unless the source inventory says that is acceptable.

If changes are clear, source-backed, and within the allowed update boundary, update the semantic-layer references and evidence register. Keep raw sensitive data, credentials, long private messages, and row-level examples out of the files. Preserve unresolved conflicts as open questions instead of choosing silently.

After edits, validate the target skill if a validator is available. End every run with a user-facing run summary using this shape:

- Status: no change, updated, blocked, or conflicted.
- Sources checked: source names plus any skipped sources.
- Changes found: source-backed metric, table, query-pattern, caveat, or source-inventory changes.
- Files changed: local file paths, or none.
- Validation: pass, fail, or not run.
- Needs review: conflicts, permission gaps, connector gaps, or proposed changes that were not written.

If nothing material changed, say that no source-backed changes were found and list the sources checked. Do not produce a silent or empty update.
```

## Update Rules

- Update generated semantic-layer references only when a change is corroborated by an authoritative source or allowed by the source inventory's update boundary.
- Preserve user edits and manual notes. If a local manual note conflicts with a source update, report the conflict instead of overwriting it.
- Never change external dashboards, team communication channels, docs, repos, or source systems as part of the weekly polling automation.
- If a connector is missing, permission has expired, or a source cannot be read, record the gap in the run summary and leave the skill unchanged for that source.
- If the automation updates files, validate the standalone skill before reporting success.
