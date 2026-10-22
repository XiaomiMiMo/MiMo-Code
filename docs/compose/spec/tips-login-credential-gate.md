---
feature: tips-login-credential-gate
status: delivered
updated: 2026-02-14
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2678
---

# Tips /login Credential Gate

## Report

**What was built** — Home tips force the `/login` tip only when no computed provider carries known credentials. Credential-bearing means `key`, `source === "env"`, or a non-empty `options.apiKey`. This covers env keys, `mimocode.jsonc` API keys, and auth-store API keys through one rule. Bare list membership does not count (mimo is always listed). Keyless local-only providers still recommend `/login`.

**Verification** — From `packages/cli`: `bun test test/cli/cmd/tui/tips-view.test.ts` → 11 pass / 0 fail. From worktree root: `bun run typecheck` PASS.

## [S1] Problem

Home tips forced the `/login` tip whenever `provider_next.authenticated` was empty. That field is auth-store only (`auth.json` / `/login`). Users who already had API keys in env or `mimocode.jsonc` still saw “run /login”.

## [S2] Design

Show the forced `/login` tip only when **no computed provider carries known credentials**; otherwise use the normal weighted tip rotation.

A provider is credential-bearing iff any of:

- `key` is truthy — single-env keys and auth-store API keys
- `source === "env"` — env-resolved credentials (including multi-env, which omits `key`)
- `options.apiKey` is a non-empty string — config and auth-store keys

Rules:

- Gate solely on these credential fields of `sync.data.provider`. Do not use auth-store presence, config-`provider` presence, or “list is non-empty”.
- mimo is always in the computed provider list and is not a credential; bare membership must not suppress the tip.
- Keyless local-only `provider` blocks still recommend `/login` (accepted gap).
- Do not change provider load/write path.

API: `hasUsableCredentials(providers) => boolean`; `pickDisplayKey({ hasCredentials, rotationKey })` returns `tui.tips.login` when `hasCredentials` is false.

## [S3] Out of Scope

- Config-`provider`-presence or auth-store-presence as independent gates.
- Model dialog’s always-on `tui.dialog.model.login_hint`.
- Changing `provider_next.authenticated` semantics or redaction.
- Plugin auth loaders that leave no `key`/`options.apiKey` (e.g. Copilot `apiKey: ""`).
- Non-TUI / CLI “not logged in” messages.

## Tasks
- [x] T1: `hasUsableCredentials` + `pickDisplayKey` gate — acceptance: true iff any provider has `key`, `source==="env"`, or non-empty `options.apiKey`; false for bare list membership and empty `apiKey` (covers: S2)
- [x] T2: Wire tips from computed provider credentials only — acceptance: force `/login` exactly when `hasUsableCredentials` is false (covers: S2; depends: T1)
- [x] T3: Regression tests — acceptance: `bun test packages/cli/test/cli/cmd/tui/tips-view.test.ts` covers no-credentials and each credential field (covers: S2; depends: T1)
