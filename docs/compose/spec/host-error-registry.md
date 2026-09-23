---
feature: host-error-registry
status: in-progress
updated: 2026-09-22
branch: feat/host-error-registry
commits: 
---

# Host Error Registry

## Report

## [S1] Problem

Embedders and host applications need their own stable error identities and retry classification on engine failures, without patching the engine for every new code.

Today the engine classifies failures only through internal heuristics (`NamedError` names, HTTP status, message fingerprints in `session/retry.ts`). Hosts that surface errors in their own UI must re-classify raw engine strings on their side. That duplicates retry semantics, drifts from `budgetFor`, and forces an engine source change whenever the host taxonomy grows.

We need a **generic injection point**: the host supplies a declarative catalog that binds **structured engine birth identities** to **host codes** and **retry classes**; the engine loads it, attaches codes before the first retry decision, and drives retry from the injected class — without knowing any particular host product.

## [S2] Design

### Boundary

- Engine owns a **closed** `RetryClass` set, all retry / `budgetFor` policy, and **terminal invariants** (see below).
- Hosts own **open** `code` strings and display copy. The engine never interprets code text and never carries product copy.
- Injection is **data only** (JSON-serializable catalog). No host functions, free-form message regex matchers, or plugins execute inside the engine for classification.
- White-box path: resolution runs from **structured birth identity** (`NamedError` name, `APIError.statusCode`, etc.), not from reverse-engineering display strings. Upstream black-box strings stay on existing heuristics when no rule matches.

### Closed retry classes

Aligned with existing `RetryKind` / `budgetFor` so injected classes plug into the same coordinator. v1 has **no** `defer` class (deferred/local-resource wait is out of scope).

| `RetryClass` | `RetryDecision.kind` | Budget via `budgetFor` |
|--------------|----------------------|-------------------------|
| `terminal` | `terminal` | none (schedule completes) |
| `network` | `network` | `config.network` |
| `rate_limit` | `rate_limit` | `config.rateLimit` |
| `server` | `server` | `config.server` |
| `stream` | `stream` | then `budgetFor` uses **actual** `phase`/`scope` (not blindly `config.stream`) |
| `unknown` | `unknown` | then `budgetFor` phase/scope as today |

- Budget **numbers** remain engine-owned. Mapping a class never invents host-supplied limits.
- `budgetFor` still applies `scope` overrides first (e.g. `max-candidate` / `max-judge`), then phase. Class mapping must fill `RetryDecision.{kind,phase,scope,message,statusCode,retryAfterMs}` completely so Retry-After / status are not dropped on the host-rule path.

### Catalog contract (normative JSON map)

```json
{
  "protocolVersion": 1,
  "rules": {
    "NamedError:InvalidOutputError": {
      "code": "host.example.empty_output",
      "retryClass": "terminal"
    },
    "APIError:429": {
      "code": "host.example.rate_limited",
      "retryClass": "rate_limit"
    }
  }
}
```

- `rules` is a **JSON object map**: key = **birth identity**, value = `{ code, retryClass }`.
- **Birth identity** grammar (closed):
  - `APIError:<statusCode>` — e.g. `APIError:429` (numeric status only)
  - `NamedError:<ErrorName>` — e.g. `NamedError:InvalidOutputError` (includes `NamedError:APIError` when no status)
  - `ErrorName:<ErrorName>` — instance `error.name` when not a `NamedError`
- **Identity resolution is a fixed first-match order** (no multi-rule merge). Computed once at **normalization entry** from the **original** error (pre-rewrite):
  1. `APIError` instance **and** `statusCode` is a finite number → `APIError:<statusCode>`
  2. else `NamedError` instance (or `name` equals a `NamedError.create` name) → `NamedError:<name>` (so `APIError` without status is `NamedError:APIError`)
  3. else non-empty `error.name` → `ErrorName:<name>`
  4. else no identity (legacy heuristics only)
- Prefer **original** error identity over any identity computed after `fromError` re-wrapping. If only a normalized object remains, use rule 1–3 on that object and document `origin: "normalized"` in logs only (not on the wire).
- Duplicate keys are impossible in one JSON object. Same `code` may appear on multiple rules (display reuse).
- `code`: non-empty string, opaque to the engine.
- `retryClass`: must be one of the closed set above.

**Document validation (all-or-nothing):**

| Condition | Load result | In effect |
|-----------|-------------|-----------|
| Schema / `protocolVersion` wrong | **reject whole doc** | keep **previous** immutable snapshot (or empty if none) |
| Any rule has invalid `retryClass` / empty `code` / bad identity key | **reject whole doc** | same as above |
| Valid doc | **atomic replace** | new snapshot visible to **new** resolutions only |
| Empty `rules: {}` | valid | no host bindings; engine heuristics only |

No partial apply. No “invalid class → terminal” on a single entry of an otherwise bad document (that mixed mode is forbidden). An **accepted** rule always carries a valid class; there is no per-entry fallback to `terminal` after load.

### Stamp / resolution timing (birth, not emit-after-retry)

1. At **error construction / normalization entry**, resolve birth identity → rule from the **current immutable catalog snapshot**.
2. If a rule matches, stamp `{ hostCode, hostRetryClass }` on the error **once**. In-flight errors **keep** their birth classification across later catalog reloads (no re-lookup on every retry).
3. If no rule matches: no `hostCode`; `decide()` uses **legacy heuristics** (black-box path).
4. If `hostCode` is present, `decide()` **must not** fall through to message heuristics for that failure (coded errors are deterministic).

### Terminal invariants (cannot be overridden to retryable)

Host rules may only **narrow** retry (e.g. mark something `terminal`). Host rules **must not** make these retryable — engine ignores a rule that would, and keeps the invariant:

- User / engine abort (`MessageAbortedError`, abort causes)
- Auth / provider auth terminal (`ProviderAuthError`, 401/403 class already terminal in `decide()`)
- Context overflow (`ContextOverflowError`)
- Explicit engine terminal constructors (`terminal()` in `decide()` today: 402/501/505, usage-limit, etc.)

If a rule sets `retryClass: "network"` (etc.) on one of the above, load **succeeds** but stamping records `retryClass: "terminal"` (clamp), with a one-line warn log. Never flip abort/auth/overflow to retryable.

### Error payload (additive envelope)

Do **not** replace `NamedError.toObject() = { name, data }`. Add optional fields **inside `data`** (and mirror on `APIError.data`) so existing consumers keep working:

```ts
// inside NamedError / APIError data (zod optional)
hostCode?: string
hostRetryClass?: RetryClass
```

- Constructors accept optional `hostCode` / `hostRetryClass`.
- Normalization (`fromError` / `message-v2` error conversion) **round-trips** these fields when present; must not drop them when rebuilding `APIError` / `Unknown`.
- Persistence and `session.error` events carry `data` as today → host fields survive for free if they live under `data`.
- Legacy required fields unchanged (`APIError.data.message`, `isRetryable`, etc.). `isRetryable` remains; host class is additive for `decide()` precedence.

**Malformed stamp handling (deterministic):**

| `data` | `decide()` behavior |
|--------|---------------------|
| no `hostCode` | legacy heuristics |
| `hostCode` + valid `hostRetryClass` | host class only (after invariants) |
| `hostCode` + **missing / invalid** `hostRetryClass` | **`terminal`** (warn once per code); **never** fall through to heuristics |
| `hostRetryClass` without `hostCode` | ignore class; treat as no stamp |

**`decide()` precedence (coded errors):**

1. Abort / auth / context-overflow / explicit terminal invariants (hard).
2. If `data.hostCode` present → build `RetryDecision` from `hostRetryClass` only (invalid/missing class → `terminal` per table) (+ status / Retry-After metadata from the same error).
3. Else existing heuristics.

### SDK surface (one cohesive module)

`packages/opencode/src/error/host-registry.ts` (export via package entry as needed):

```ts
export type RetryClass = "terminal" | "network" | "rate_limit" | "server" | "stream" | "unknown"

export type BirthIdentity = `APIError:${number}` | `NamedError:${string}` | `ErrorName:${string}`

export interface HostErrorRule { code: string; retryClass: RetryClass }
export interface HostErrorCatalog {
  protocolVersion: 1
  rules: Record<BirthIdentity, HostErrorRule>
}

/** Validate + atomic replace. On reject, previous snapshot kept. */
export function loadHostErrorCatalog(doc: unknown): { ok: true } | { ok: false; reason: string }

/** Load from absolute JSON path (child-process bootstrap). Same validate/replace rules. */
export function loadHostErrorCatalogFile(path: string): { ok: true } | { ok: false; reason: string }

/** Current snapshot (immutable). */
export function hostErrorCatalog(): HostErrorCatalog

/** Birth identity string from an error (pure). */
export function birthIdentity(error: unknown): BirthIdentity | null

/** Resolve + stamp once at construction/normalization. */
export function stampHostError<T extends object>(error: T, target?: { name?: string; statusCode?: number }): T

export function hostRetryClass(error: unknown): RetryClass | null
```

### Retry-status propagation (banner path)

`session.status{type:"retry"}` and `RetryDecision` must carry host identity when the decision was host-driven (or class-only terminal was recorded):

```ts
// RetryDecision additive optional fields
hostCode?: string
// retry status payload additive optional fields (same names)
hostCode?: string
```

- When `decide()` uses a stamped host class, copy `data.hostCode` onto `RetryDecision` and the published retry status.
- When legacy heuristics run, omit `hostCode` (hosts may still fingerprint for display).
- Acceptance: retry status for a host-stamped rate_limit/network/server failure includes `hostCode`; terminal host codes do not emit retry status.

Bootstrap (concrete, v1):

| Embed mode | Delivery | Barrier |
|------------|----------|---------|
| In-process embed | `loadHostErrorCatalog(parsedJson)` | must return **before** first prompt/session submit |
| Child / spawned engine | host writes JSON to an absolute path and sets `HOST_ERROR_CATALOG` env **or** calls `loadHostErrorCatalogFile(path)` on the runtime bootstrap API | engine finishes load (ok or logged fail) **before** accepting session traffic |

No HTTP control-plane API in v1. No env-based function eval. Load **failure** never replaces a good snapshot with empty; empty is only the initial state.

### Error behavior summary

| Situation | Behavior |
|-----------|----------|
| Malformed catalog doc | reject; keep previous/empty |
| Reload success | atomic snapshot swap; in-flight stamps unchanged |
| Birth identity hit | stamp `hostCode` + class (clamped if invariant) |
| Birth identity miss | legacy heuristics |
| Stamped error | no heuristic fall-through |
| Host class vs abort/auth/overflow | invariant wins (`terminal`) |

### Testing boundaries

- Pure unit: catalog validate/reject/replace (no partial apply); birth identity **order** (APIError:status vs NamedError:APIError vs ErrorName); stamp once + stable across reload; decide() host path vs heuristics; invariant clamp; malformed stamp → terminal; `fromError` round-trip of `data.hostCode` / `hostRetryClass`.
- `budgetFor` matrix: each `RetryClass` → decision kind + phase/scope keeps status/retryAfter.
- Retry status includes `hostCode` iff host-driven decision.
- No UI or product-copy tests in this package.

## [S3] Out of Scope

- Product display copy, i18n, or any host UI wording.
- Host function / plugin / free-form message-regex injection.
- `defer` / condition-gated local-resource waits (no v1 class; engine `RetryKind` unchanged in v1).
- Changing default `budgetFor` budget numbers or `RetryKind` set.
- Automatic mapping of every historical `NamedError` name to host codes (hosts list the identities they care about).
- Multi-catalog merge across independent hosts (single replace-all snapshot).
- Separate HTTP bootstrap API (v1 is in-process `loadHostErrorCatalog`).

## Tasks

- [ ] T1: Add `error/host-registry.ts` with `RetryClass`, `BirthIdentity`, catalog schema, `loadHostErrorCatalog` (all-or-nothing + atomic snapshot), `birthIdentity`, `stampHostError`, `hostRetryClass` — acceptance: malformed/invalid-class docs rejected and previous snapshot kept; valid empty rules accepted; unit tests green (covers: S2)
- [ ] T2: Add optional `data.hostCode` / `data.hostRetryClass` on structured errors and round-trip through constructors + `fromError` / normalization — acceptance: `toObject()` still `{name,data}`; host fields survive serialize/rebuild (covers: S2; depends: T1)
- [ ] T3: Stamp at construction/normalization entry from catalog; in-flight classification stable across reload — acceptance: identity hit stamps once; miss → no hostCode; reload does not restamp live errors (covers: S2; depends: T2)
- [ ] T4: `decide()`: terminal invariants first; if `hostCode` present use host class only and preserve status/Retry-After; clamp invariant violations to `terminal`; else legacy heuristics — acceptance: matrix unit tests for classes × invariants × metadata (covers: S2; depends: T3)
- [ ] T5: Propagate `hostCode` on `RetryDecision` + retry status payload when host-driven — acceptance: retry event carries `hostCode`; heuristics path omits it (covers: S2; depends: T4)
- [ ] T6: Package unit tests + typecheck from `packages/opencode` — acceptance: `bun typecheck` and registry/retry tests pass (covers: S2; depends: T5)
