---
feature: xiaomi-auth-provider-split
status: delivered
updated: 2026-10-28
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2739
---

# Xiaomi Credential Provider Split

## Report

**What was built** — Platform login credentials now land under separate providers in `auth.json`: the API key under `xiaomi`, token-plan keys under `xiaomi-token-plan-cn|ams|sgp` (matching the models.dev catalog). The two kinds may coexist. Endpoint → provider derivation lives in `xiaomi-family.ts`; `MimoAuthPlugin` returns the derived `result.provider`, and `ProviderAuth.callback` plus CLI `mimoLogin` share `saveCredential` (including same-cluster legacy-alias cleanup). Consumers recognize the `xiaomi-*` family: websearch routing and key lookup, the WebSearchTool gate, in-house ordering, large-model defaults, TUI logout, default-model selection (post-login pick and the credential switch in `fallback`), and voice credential fallback (token-plan clusters before the API key). Legacy single-key entries keep working; only a same-cluster re-login drops them.

**Verification** — Related scope (packages/cli): `bun test test/provider/xiaomi-family.test.ts test/provider/provider-auth-write.test.ts test/plugin/mimo.test.ts test/cli/plugin-auth-picker.test.ts test/cli/tui/voice.test.ts test/cli/tui/model.test.ts test/provider/transform.test.ts test/tool/websearch.test.ts test/tool/registry-toolset.test.ts test/auth` → 385 pass / 4 pre-existing skip / 0 fail. Root `bun run typecheck` (all workspaces) PASS. Full suite intentionally skipped (repo has pre-existing failures).

## [S1] Problem

Platform login (browser authorize / pasted code) returns `{sk, uid, url}`, where `url` is either the billing gateway (API key) or a token-plan cluster. Both kinds were written under the single `xiaomi` key in `auth.json`, distinguished only by `metadata.base_url`:

- `packages/cli/src/plugin/mimo.ts` returned `key + metadata` and never declared the target provider.
- `packages/cli/src/provider/auth.ts` `callback` wrote api/oauth results to `input.providerID` and discarded the result's `provider` redirect field (which `handlePluginAuth` in `cli/cmd/providers.ts` does honor).
- `mimoLogin()` in `cli/cmd/providers.ts` hardcoded `put("xiaomi", ...)`.

That contradicts the models.dev catalog, which registers API and the three token-plan clusters as four providers (`xiaomi` → `https://api.xiaomimimo.com/v1`; `xiaomi-token-plan-cn|ams|sgp` → `https://token-plan-*.xiaomimimo.com/v1`). Consequences: re-logins overwrote each other, token-plan credentials could not hit their catalog provider directly, and every consumer special-casing `providerID === "xiaomi"` (X-Mimo-Source header, websearch, TUI logout/whoami/default model) ignored `xiaomi-token-plan-*`.

## [S2] Design

### S2.1 Provider derivation (single source)

New `packages/cli/src/provider/xiaomi-family.ts`:

- Constants: `XIAOMI_API_PROVIDER_ID = "xiaomi"`; token-plan ids `xiaomi-token-plan-cn|ams|sgp` with their default endpoints (models.dev-aligned).
- `xiaomiProviderForEndpoint(url?: string): string`: classify by URL **hostname** — `api.xiaomimimo.com` → `xiaomi`; `token-plan-cn|ams|sgp.xiaomimimo.com` → matching cluster id; unparseable or unknown host → fall back to `xiaomi` (preserves prior behavior: credential under `xiaomi` with `metadata.base_url`, redirected by the plugin loader).
- `isXiaomiFamilyProvider(id?: string): boolean`: `id === "xiaomi" || id.startsWith("xiaomi-")`, mirroring the gateway-family rule already used in `provider/error.ts`.

### S2.2 Generic OAuth callback honors `result.provider`

`packages/cli/src/provider/auth.ts` `callback`: both api (`key`) and oauth (`refresh`) writes use `result.provider ?? input.providerID` as the store key, so plugins can direct credentials to different providers and the CLI and TUI/server login paths behave alike.

### S2.3 MimoAuthPlugin declares the target provider

Both success branches of the authorize callback (local server and pasted code) return `provider: xiaomiProviderForEndpoint(result.url)`. `metadata.uid` / `metadata.base_url` are still written; the encrypted payload is unchanged. The `X-Mimo-Source` gate in `chat.headers` uses `isXiaomiFamilyProvider(model.providerID)`.

### S2.4 CLI login and whoami

`mimoLogin()` stores under `result.provider ?? "xiaomi"`. Writes go through shared `saveCredential` (exported from `provider/auth.ts`, also used by `ProviderAuth.callback`): a token-plan write removes a legacy `xiaomi` entry (`type: "api"` whose `metadata.base_url` maps to that same cluster) so one credential cannot hang under two keys. `providers whoami` walks the four family keys and lists each signed-in entry.

### S2.5 Engine consumers

- `tool/websearch/index.ts`: the MiMo gateway branch uses the family predicate; the key comes from `model.providerID` (no more hardcoded `auth.get("xiaomi")`); the endpoint stays `model.api.url`.
- `tool/registry.ts`: WebSearchTool availability uses the family predicate.
- `provider/provider.ts` `inHouse` ordering and `provider/transform.ts` `usesLargeModelDefaults`: `mimo` or the xiaomi family.
- `provider/error.ts` already works per `xiaomi-*` and is unchanged.

### S2.6 TUI consumers

- Logout (`app.tsx`): `removeXiaomiFamilyCredentials` clears all four family keys.
- Login success (`dialog-mimo-login.tsx` `onLoginSuccess`): `familyDefaultModel` (exported from `util/model.ts`) picks the post-login default from the first family provider holding credentials (`key` or `options.apiKey`) and models, preferring `mimo-v2.6-pro`, and records it as recent. Full selection chain: `initial` consumes argument → recent → configured; `fallback` switches to the keyed family member (`familyDefaultModel`, token-plan cluster → xiaomi API), else the catalog-listed xiaomi pro model, else the first provider default.
- Voice (`tui/util/voice.ts`): `resolveCredentials` falls back along `xiaomi-token-plan-cn → ams → sgp → xiaomi` to the first family provider with a key when the configured one has none (same order as the desktop voice fallback); the default baseURL map covers all four endpoints.

### S2.7 Compatibility

Legacy entries (CLI form: `xiaomi` key + token-plan `metadata.base_url`) remain readable and usable via the plugin loader's baseURL redirect and the desktop's consumers (its voice case TP-R7-07 explicitly supports the form). No proactive migration; only the same-cluster re-login cleanup from S2.4.

## [S3] Out of Scope

- The desktop app's own `auth.json` write path; its consumers already accept both layouts.
- The platform's encrypted payload contract (`{sk, uid, url}`) — unchanged.
- Plugin auth hooks/loaders for `xiaomi-token-plan-*` (catalog `api.url` already provides the endpoint).
- `provider-priority.ts` login-list ordering and bulk migration of historical entries.

## Tasks

- [x] T1: Add `xiaomi-family.ts` derivation and family predicate — acceptance: unit tests cover all four endpoints, unknown-URL fallback to `xiaomi`, and family predicate true/false samples (covers: S2.1)
- [x] T2: `provider/auth.ts` callback stores under `result.provider` — acceptance: tests prove api and oauth results honor the redirect and the default remains `input.providerID` (covers: S2.2)
- [x] T3: `plugin/mimo.ts` returns the derived provider and gates `chat.headers` by family — acceptance: tests prove token-plan callbacks return the cluster provider and `X-Mimo-Source` applies to `xiaomi-token-plan-*` (covers: S2.3)
- [x] T4: `mimoLogin` split writes + same-cluster legacy cleanup + family whoami — acceptance: tests prove token-plan logins write `xiaomi-token-plan-*`, the stale `xiaomi` alias is cleared, API logins write `xiaomi`, and both kinds coexist (covers: S2.4)
- [x] T5: Engine consumers recognize the family (websearch/registry/inHouse/transform) — acceptance: tests prove `xiaomi-token-plan-cn` models use MiMo websearch with their own provider key and expose WebSearchTool (covers: S2.5)
- [x] T6: TUI consumers (family logout, login default model, voice fallback) — acceptance: tests prove logout removes all four family keys and voice falls back to a keyed family member when the configured cluster has none (covers: S2.6)

## Journey log

- Two drivers persist plugin credentials (CLI `mimoLogin` / server `ProviderAuth.callback`). The policy must live in one place: the first cut kept two copies of the legacy-alias cleanup, review flagged drift risk on the untested path, and both now share `saveCredential`.
- The legacy single-key CLI form must keep working: the desktop voice suite (TP-R7-07) explicitly covers it. The split only changes where new writes land; only a same-cluster re-login drops the stale key.
- The `xiaomi-*` prefix predicate (behavior gates) and the four-id credential list (store slots) are deliberately different sets: `xiaomi-mimo-*` BYOK clones need gateway behavior but hold credentials in `mimocode.json`, so logout/whoami/cleanup only touch the four models.dev ids.
- Default-model chain: `initial` consumes argument → recent → configured; `fallback` switches to the family member holding credentials (token-plan cluster → xiaomi API), then the catalog-listed xiaomi pro as the no-credential default, then the first provider default. The old "(login required)" wording was the real defect — the xiaomi pro default is always catalog-listed; the switch is credential-driven, not login-gated.
- Review items rejected with reasons: empty-string `provider` fallback (`??` matches `handlePluginAuth`; not a real payload shape); the plugin's local-server callback branch is untested (port not exposed to tests; both branches share one derivation expression); the "success with neither key nor refresh keeps the alias" edge is unreachable by type and untested.
