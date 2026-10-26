---
feature: opencode-go-session-header
status: delivered
updated: 2026-10-12
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2655
---

# OpenCode Go Session Header

## Report

**What was built** — OpenCode Go inference through `session/llm.ts` `stream()` now sends `x-opencode-session: <sessionID>` (same stable per-conversation id as `x-session-affinity`), including ephemeral title/summary. Non-Go providers are untouched. Target detection is `providerID` starting with `opencode-go` **or** `Provider.effectiveBaseURL` containing `opencode.ai/zen/go`; `effectiveBaseURL` is the single source of request-URL precedence (`provider.options.baseURL` ?? `model.api.url`) and `resolveSDK` reuses it.

**Verification** — `bun test` session/llm* (llm, llm-retry, llm-system-prompt, llm-request-prefix) → 50 pass / 2 skip / 0 fail. `bun run typecheck` → PASS. Removing the header or dropping `providerOptions` from detection fails the new tests. Review 1 found CRITICAL (provider-level `options.baseURL` missed) → fixed by `effectiveBaseURL` + `getProvider().options`. Review 2: all ACs met, no CRITICAL.

**Journey log** —
1. First draft sent the header on every provider; user required Go-only so non-Go stays byte-identical.
2. Field-list detection (`model.api.url` / `model.options` / `provider.options`) was brittle — replaced by `effectiveBaseURL` matching `resolveSDK` precedence.
3. Ephemeral title still has a real `sessionID`; OpenCode Go 400s title/summary without the header, so the header is not gated on `!ephemeral` (unlike affinity).
4. Non-`stream()` inference paths (`predict`, `goal`, `agent.generate`, `llm-server`, `mcp/sampling`) are intentionally unwired — operator configuration if pointed at Go.
5. Integration tests key off `providerID="opencode-go"`; they do not prove `item.options` is threaded (unit matrix covers the helper contract).

## [S1] Problem

OpenCode Go (the subscription behind `https://opencode.ai/zen/go/v1`) has hard-rejected every inference request that lacks a stable per-conversation `x-opencode-session` header since 2026-09-05 (HTTP 400 `MissingSessionID`). MiMoCode is a fork of OpenCode and is listed on https://opencode.ai/docs/go/ as a known problematic client because of XiaomiMiMo/MiMo-Code#2317.

User-visible impact:

- Every `opencode-go/*` model call through CLI and MiMo Desktop fails with `Request is missing x-opencode-session and cannot be routed efficiently`.
- Title generation / summary / compaction also fail, so the failure is not limited to the main chat turn.
- Users have been working around this with `chat.headers` hooks / plugins that re-send `input.sessionID` under the second header name.

Code today (`packages/cli/src/session/llm.ts`) already computes the correct value and sends it as `x-session-affinity` on non-ephemeral calls. The same value is never sent as `x-opencode-session`. User-Agent is already product-specific (`mimocode/<version>`), which matches the Go docs requirement.

Prior PRs (#2327 closed, #2494 open-but-conflicting) target the retired `packages/opencode/` tree and only cover non-ephemeral calls. Community reports (Letta's fix, title-gen failures) show ephemeral/auxiliary requests must also carry the header.

## [S2] Design

### Header contract (OpenCode Go only)

Only requests that target **OpenCode Go** gain the extra header. Every other provider's outbound headers stay byte-identical to today.

`isOpenCodeGoTarget(model, providerOptions?)` is true when either:

1. `model.providerID` starts with `opencode-go` (covers `opencode-go`, `opencode-go-chat`), or
2. `effectiveBaseURL(model, providerOptions)` contains `opencode.ai/zen/go`.

`effectiveBaseURL` lives in `provider/provider.ts` and is the **same precedence `resolveSDK` uses** to pick the request URL: non-empty `provider.options.baseURL` wins, else `model.api.url`. Do not list more config fields in the Go helper — if URL resolution changes, fix `effectiveBaseURL`. (`options.endpoint` is already folded into `options.baseURL` at config load.)

On matching requests from `session/llm.ts` `stream()` that have a `sessionID`:

- Send `x-opencode-session: <sessionID>` — **including** `ephemeral: true` calls (title / summary / compaction).
- Keep `x-session-affinity` and `x-parent-session-id` gated on `!input.ephemeral` exactly as today (all providers).
- Do **not** invent a new identifier. Reuse the existing stable per-conversation `sessionID`.
- Do **not** send the header when `sessionID` is empty/absent.
- `User-Agent: mimocode/<version>` stays unchanged.

### Scope of the header

**Not** sent on non-Go providers. OpenCode Zen (`opencode` without a `zen/go` URL) is out of scope.

**Call sites:** `session/llm.ts` `stream()` only (covers main chat + ephemeral title via `prompt.ts`). Other AI SDK surfaces (`predict`, `goal.evaluate`, `agent.generate`, `llm-server`, `mcp/sampling`) are intentionally not wired — if those are pointed at Go without a session header, that is operator configuration, not this fix.

### Transport coverage

The header is set in the single `stream()` headers object for matching models, so it applies to every AI SDK path that `stream()` uses (OpenAI-compatible `/chat/completions`, Anthropic `/messages`, Responses).

### Explicit non-goals

- Restoring `x-opencode-client` / `x-opencode-project` (optional in the Go docs).
- Provider-ID filtering of "opencode" (#114) or Responses-only model errors (#2030).
- Changing how `sessionID` is generated.
- Adding the header to non-Go providers.
- Covering every non-`stream()` inference call site in the repo.

## [S3] Out of Scope

- Docs rebranding of leftover OpenCode names.
- Windows hooks loader path bug (`pathToFileURL`).
- OpenCode Go model catalog / pricing / auth UI.

## Tasks

- [x] T1: Send `x-opencode-session` on OpenCode Go requests only (including ephemeral) — acceptance: unit test for `isOpenCodeGoTarget`; integration shows Go non-ephemeral carries `x-opencode-session` == sessionID next to `x-session-affinity`; Go ephemeral carries `x-opencode-session` and omits `x-session-affinity`; non-Go carries neither change (`x-opencode-session` null, affinity unchanged). (covers: S2)
- [x] T2: Regression test + typecheck/lint — acceptance: new tests fail if the header is removed or scoped wrong; `bun run typecheck` and targeted `bun test` for `session/llm*` pass. (covers: S2; depends: T1)
