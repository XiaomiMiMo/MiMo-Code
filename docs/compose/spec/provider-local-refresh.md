---
feature: provider-local-refresh
status: in-progress
updated: 2026-10-03
branch: codex/provider-local-refresh
commits:
---

# Provider Refresh Without Instance Disposal

## Report

## [S1] Problem and scope

Embedded clients need to apply model catalogs, provider settings, and credential
changes without destroying the directory instance that owns conversation state,
subscriptions, and pending interactions. Ordinary instance disposal currently
couples those unrelated lifetimes.

This change provides an engine API for local model refresh. It does not change
the Desktop configuration UI or automatically migrate CLI configuration actions
to that API. Existing conversation and explicit lifecycle operations must remain
compatible, including callers that never request a provider refresh.

The existing linked engine worktree is reused inside the already selected
Desktop worktree. The feature document uses the default Compose Next location.
The engine PR and its review material are in English; Desktop review and
publication are separate work.

## [S2] Admission and publication

`POST /global/provider/refresh` returns `{ "state": "applied" }` after a
successful refresh, or `{ "state": "pending" }` when an instance has an active
request, execution reservation, update, or unresolved cleanup. A busy response
does not queue a background refresh: the caller must retry after work finishes.
It must not cancel work or dispose an instance. The v2 JavaScript SDK exposes the
same operation as `client.global.refreshProviders()` without renaming the
existing provider client.

The refresh prepares candidates for the existing directory contexts while
holding an admission barrier. New requests wait, and synchronous execution
claims cannot enter that barrier. Ordinary disposal and reload must not race a
model publication. Request, execution, and teardown accounting remains owned
by Instance rather than inferred from UI activity.

All candidates must be prepared before publishing any replacement. A failed
preparation retains the old usable model views, releases admission, and allows
a later retry. Refresh does not emit instance-disposal events or replace Bus,
SessionRunState, permission, question, MCP, or skill state.

Effect HTTP API handlers retain an instance claim for their actual operation,
including asynchronous work, and release it on completion, failure, or
interruption. This must not make existing lifecycle handlers reject their own
otherwise valid requests.

## [S3] Configuration and provider state

The refreshed configuration surface is limited to `provider`,
`enabled_providers`, `disabled_providers`, `model`, `small_model`, `vision_model`,
and `model_groups`. Source precedence follows ordinary configuration loading.
The preparation path does not install dependencies, rewrite configuration
files, scan commands/agents/plugins, or publish unrelated configuration changes.
Global source invalidation allows subsequently created instances to read fresh
configuration without invalidating the current instances. An instance whose
Config has not been initialized remains cold until ordinary use initializes it.

Provider candidates use the refreshed model fields and already initialized
plugin configuration/authentication hooks. Configured plugin factories are not
reloaded as part of a model refresh. Plugin-contributed models must survive
refresh even if that instance has not read its Provider state yet. Refresh does
not initialize cold plugin state.

A committed Provider view has fresh SDK and LanguageModel caches. Existing
supported adapters can pick up new options and model definitions; this feature
does not promise hot replacement of arbitrary SDK packages or plugin code.
In-flight execution must not mix models, options, and SDKs from different views.

## [S4] Credentials and compatibility

Authentication retains its existing behavior, including OAuth token renewal.
A successful refresh builds the next Provider view from current configuration
and authentication sources. A pending or failed refresh leaves the previous
view in use; saving credentials alone does not mean refresh has succeeded.
Callers must check the result before presenting new settings as active.

Immediate invalidation of previously obtained SDK objects and credential
revocation enforcement are outside this API's scope. Callers that require an
immediate reset must use the existing explicit lifecycle operation. The refresh
endpoint uses the server's existing authorization boundary.

## [S5] MCP activity and static configuration

Server-initiated MCP sampling counts as active execution for its owning
instance. Refresh returns `pending` until it finishes. Callbacks from a closing or
disposed instance are rejected and must not claim a replacement instance.

MCP registration, connection configuration, and OAuth semantics are unchanged.
This feature adds no duplicate-name registration support or MCP configuration
hot reload. Ordinary MCP, skill, and plugin configuration changes require an
explicit restart; model refresh must not imply that those changes were applied.

## [S6] Boundaries and verification

There is no database/schema migration, per-session Instance conversion,
resource pool, idle eviction policy, or Desktop implementation in this PR.
Explicit disposal, shutdown, and isolated-worktree cleanup remain separate
lifecycle operations.

Verification covers real Instance/Config/Provider behavior; configuration and
provider regression tests; MCP sampling and existing lifecycle behavior;
request/cleanup admission; schema generation; typechecking; and the Node build.
External OAuth providers and third-party plugin side effects cannot be proven
by local fixtures. Review must distinguish tested mechanisms from those live
integration limits.

## Tasks

- [ ] T1: Verify admission and publication — acceptance: busy requests and executions defer refresh; update, request, reload, and disposal lifetimes do not race or deadlock; failed preparation does not partially publish. (covers: S1, S2)
- [ ] T2: Verify configuration and provider isolation — acceptance: refreshed model data is executable, caches adopt it coherently, static configuration stays unchanged, and initialized plugins retain their contributions before and after first Provider use. (covers: S3; depends: T1)
- [ ] T3: Verify authentication compatibility — acceptance: successful refresh adopts current provider credentials, failed refresh retains the prior view, and normal OAuth renewal works for clients that never use refresh. (covers: S4; depends: T2)
- [ ] T4: Verify MCP activity admission — acceptance: active sampling defers refresh, completion releases admission, and stale callbacks cannot claim a replacement instance. (covers: S5)
- [ ] T5: Verify and independently review the full engine change — acceptance: relevant tests, typecheck, Node build, schema checks, and v2 SDK transport checks pass or have demonstrated baseline limitations; the reviewer gives separate spec-compliance, correctness, and codebase-consistency conclusions with no unresolved critical finding. (covers: S1, S2, S3, S4, S5, S6; depends: T1, T2, T3, T4)
