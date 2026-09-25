---
feature: host-error-registry
status: in-progress
updated: 2026-09-24
branch: feat/host-error-registry
commits:
---

# Host Error Registry

## Report

## [S1] Problem

Hosts need stable codes and explicit retry behavior for their own LLM API business failures, without teaching the engine product codes. Engine error names, broad HTTP statuses and message fingerprints cannot identify a particular host's API response safely.

## [S2] Design

### Trust and scope

The catalog is data only. The engine matches at the LLM API boundary using the providerID from the selected model's trusted call context. It never infers source from response JSON, URLs, message text or error metadata. Hosts must reserve their providerID and prevent BYOK overrides. No product provider IDs or business codes are built into the engine.

Only SDK API failures and structured provider error events are eligible. Tool errors, invalid output, aborts, programming errors and filesystem errors do not acquire host codes. Native transport failures without an API response remain on the engine's network path.

### Catalog v2

This replaces unpublished v1; no birth-identity compatibility layer is retained.

```ts
type RetryClass = "terminal" | "persistent" | "bounded"
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }
type HostResponseMatch =
  | { readonly kind: "field"; readonly path: string; readonly value: string | number | boolean | null }
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "empty" }
interface HostErrorRule {
  readonly match: {
    readonly providerID: string
    readonly statusCode?: number
    readonly response: HostResponseMatch
  }
  readonly code: string
  readonly retryClass: RetryClass
}
interface HostErrorCatalog {
  readonly protocolVersion: 2
  readonly rules: readonly HostErrorRule[]
}
```

Example (synthetic values):

```json
{
  "protocolVersion": 2,
  "rules": [
    {
      "match": {
        "providerID": "test-host",
        "response": { "kind": "field", "path": "/failure/reason", "value": "busy" }
      },
      "code": "host.example.busy",
      "retryClass": "persistent"
    },
    {
      "match": {
        "providerID": "test-host",
        "statusCode": 403,
        "response": { "kind": "json", "value": { "error": "Example restricted account", "code": 403 } }
      },
      "code": "host.example.restricted",
      "retryClass": "bounded"
    },
    {
      "match": { "providerID": "test-host", "statusCode": 401, "response": { "kind": "empty" } },
      "code": "host.example.unauthorized",
      "retryClass": "terminal"
    }
  ]
}
```

All conditions within a rule are AND; the first matching rule wins. Field paths are RFC 6901 JSON Pointers, not dotted paths or URI fragments. The empty pointer `""` selects the root; `/token` selects a member, `/` selects an empty key, and `~0`/`~1` decode to `~`/`/` without percent decoding. For example, `/items/0/a~1b` selects the `a/b` member of the first item. Arrays accept only canonical nonnegative indexes (`0` or a nonzero digit followed by digits); leading zeros, signs, `-`, `length` and out-of-range indexes do not resolve. Those tokens remain valid object member names. Traversal reads only own properties and never boxes scalars or reads prototypes.

Field values use strict typed equality for strings, numbers, booleans and null; missing paths and malformed/non-JSON bodies never match null. JSON selectors accept any JSON root, including arrays, scalars and null, and compare the complete structure: object key order is ignored, additional keys and array ordering remain significant, and no type coercion occurs. Empty matches only missing/whitespace response bodies and require a statusCode; JSON null is not empty. No substring or regex matching is supported. An exact restricted-account 403 rule does not change unrelated 403 handling.

The schema rejects invalid versions, unknown keys, invalid classes, empty codes/provider IDs and malformed selectors as a whole, including nonempty pointers without a leading slash and any tilde escape other than `~0` or `~1`. Rejected catalogs preserve the previous snapshot. The public loader also returns `{ ok: false, reason }` for validation or cloning exceptions without replacing that snapshot. Valid catalogs replace it atomically; an empty array disables new bindings. Snapshots are deeply frozen.

### Boundary and lifetime

`bindHostError(error, { providerID })` first matches only inside the actual provider `doStream()` invocation and its returned raw provider stream (error parts and stream-read failures). Host transport wrappers, plugin preparation, SDK tool repair and the surrounding attempt never create new bindings. The raw stream wrapper preserves backpressure and propagates cancellation upstream. Matches and misses are cached by raw object identity and trusted providerID.

At the trusted doStream boundary, enable the SDK's existing includeRawChunks option. Some compatible adapters emit a raw frame followed immediately by an error part containing only the message string. Retain at most one raw error frame; restore structure only when the immediately following part is an error with the same string message. Both `{error: {...}}` and `{type: "error", error: {...}}` are supported. Matching uses the original complete raw JSON, not the normalization envelope. Intervening parts, normal raw frames, completion, cancellation and read errors clear the pending frame. Normal raw chunks never trigger catalog matching and internally requested raw parts are consumed before reaching the SDK fullStream/UI; an explicitly requested raw stream retains its requested visibility. No fetch or SSE parser is added.

Outside that boundary, `inheritHostError` follows only the SDK RetryError last-error chain to an existing binding, including cached misses, without consulting the catalog. Earlier retry-history entries cannot donate a binding to an unbound last error. Normalization also performs this inheritance before unwrapping content; the same failure retains its binding across catalog reloads. SDK-flattened stream errors use their retained original data frame for structured matching. A structured `type: "error"` protocol frame may carry arbitrary JSON payload fields; recognition does not require particular business field names. An outer `type: "error"` frame is authoritative even when its data member resembles another error frame; only flattened wrappers fall back to data.

Generic normalization and retry decisions do not match catalogs. They only propagate/read existing bindings. `NamedError` has no global enrichment hook. Direct construction does not stamp. Live request, processor and max-mode retry paths use `fromLiveError`: API host fields require an existing binding for the trusted providerID, and an absent binding or cached miss clears supplied stamps. Plugin preparation and whole-attempt failures cannot promote a plain APIError-shaped object or a constructed APIError into a host error. No catalog matching occurs at these outer boundaries. Live non-API errors always discard supplied host fields as well, preventing local output, abort or unknown errors from carrying a forged host identity to events.

`fromError` retains its trusted restoration/idempotence contract: schema/JSON/SQLite/event round-trips preserve API host fields without consulting the current catalog. Restoring serialized fields does not grant a live binding. Only an already-bound source transfers its binding to a normalized APIError, allowing repeated live normalization and SDK last-error wrapping to preserve the same decision across catalog reloads; a JSON clone is not live provenance. Real abort/context/load-key normalization remains native and does not gain a new host code.

Native retry facts follow only an SDK RetryError's lastError (or final array entry when lastError is absent) and actual cause links. Earlier attempts are not causes of the final failure. Normalization stores effective cause facts in metadata.causeChain, including a single remaining fact after removing an SDK retry wrapper; when the full diagnostic summary differs, it is retained separately as metadata.retryHistory. Retry classification never reads retryHistory, so an earlier timeout cannot turn a final TypeError into persistent recovery, nor can an earlier HTTP404 stop recovery of a final HTTP503. If normalization would otherwise lose a bare error's safety-terminal identity, its current operative summary is retained as causeChain even without a cause wrapper. Already-terminal normalized output is left unchanged so repeated restoration remains idempotent.

### Behavior precedence

1. User cancellation, actual context overflow, missing API keys and other true engine safety failures stop retry. Stream error code and type are checked independently for context overflow: a numeric business code cannot hide a context_length_exceeded/context_window_exceeded type. This applies to raw and SDK-flattened frames, with or without a catalog, and normalizes to an unstamped ContextOverflowError. Unsafe tool-side-effect replay remains forbidden.
2. Explicit matched host behavior controls API errors. Terminal business failures cannot become network retries because their body/message mentions IO or because HTTP status is 5xx. Precisely matched host bounded errors can override broad HTTP400/403 heuristics.
3. Unmatched native network/timeout errors retain mandatory persistent recovery (including HTTP408/504 legacy handling).
4. Otherwise existing HTTP, quota and non-network heuristics apply. An unmatched HTTP401 is terminal even when a gateway labels its response `upstream_error`: repeating an unchanged unauthorized model request cannot restore credentials. Native stream_read_error/upstream_error and rate-limit signals retain their precedence over the broad HTTP400/403/422 fallback; ordinary client failures without those signals remain terminal.

The stored host class is behavioral, independent from the diagnostic RetryKind. RetryDecision carries hostCode and hostRetryClass; retry status/events continue carrying hostCode. Terminal decisions emit no retry event. Malformed persisted stamps with hostCode but no valid class fail closed as terminal; class without code is ignored.

### Budgets

max-candidate/max-judge retain their own isolation budgets. For normal request/live-step:

- Host persistent forces `mode: persistent`, no maxRetries, and maxElapsedMs=0. Neither global/provider configuration nor caller budgets may downgrade this. Exponential backoff, delay caps, Retry-After and jitter remain effective.
- Host bounded uses the phase request/stream budget, never the default-persistent server/rateLimit budget. Force bounded mode; missing/nonfinite count and nonpositive/nonfinite deadline fall back to existing phase defaults: request 4 retries / 30 seconds, stream 5 retries / 10 minutes. Explicit finite configured limits remain valid.
- Native network forces persistent, without attempts/deadlines, as before.
- The schedule enforces these semantics even when supplied a custom budget callback. Persistent retries remain cancellable and respect replay safety. Silent-overload limits cannot cap host persistent recovery.

### Persisted event ownership

Effect InstanceRef is authoritative over ambient instance ALS when both exist. `InstanceState.bind` captures that Fiber context first, falling back to ALS only when the Fiber has no instance reference; callbacks outside either context remain unchanged. This is the same precedence used by `InstanceState.context`.

Database transaction callbacks and deferred post-commit effects must restore the captured owner before invoking synchronous instance consumers. Persisting a message or part under conflicting ALS must publish both its project Bus event and GlobalBus ordinary/sync envelopes to the Fiber owner's directory and project, never to the ambient instance. The database write succeeding alone is not sufficient verification. This fixes the callback bridge without changing SyncEvent payloads, retry behavior, or host matching boundaries.

### Bootstrap and API

Keep `loadHostErrorCatalog`, `loadHostErrorCatalogFile`, `hostErrorCatalog`, and `HOST_ERROR_CATALOG`. Load before accepting traffic in CLI/shared-server paths; initialization runs once and cannot overwrite later explicit reloads. No new HTTP control plane is introduced.

## [S3] Out of Scope

Product codes, UI copy, source inference, BYOK ownership enforcement, regex/plugin matching, default budget number changes, and multi-host catalog merging.

## Tasks

- [x] Specify the v2 schema, boundary and behavior contract.
- [x] Replace birth identity matching with API-bound response matching and remove global constructor stamping.
- [x] Wire all provider error events/thrown failures and preserve normalized API bindings.
- [x] Enforce behavior budgets with safety precedence and native network recovery.
- [x] Verify malformed input, provider isolation, exact-body matching, reload stability, non-API exclusion, persisted envelopes, bounded exhaustion, terminal no-retry, cancellation and recovery beyond one virtual hour.
- [x] Run package typecheck and focused/expanded regression suites; document results.
- [x] Reproduce persisted message event cross-directory routing under conflicting ALS/Fiber contexts, align callback binding precedence, and verify database persistence plus owner/wrong-owner/GlobalBus delivery.

## Delivery verification

- Focused registry/retry/max-mode-input suite after boundary review: 120 pass, 0 fail (867 assertions).
- Provider/LLM/max-mode/prompt/compaction regression suite after compatible-adapter review: 140 pass, 0 fail (490 assertions). The two max-mode-input cases overlap; 258 distinct tests passed across both runs.
- Effect TestClock drives both request and stream host-persistent schedules through 70 failures and 71 virtual minutes to successful recovery despite bounded caller budgets and silent-overload predicates. The empty-catalog native network path also recovers after 70 failures. User interruption during a wait prevents further requests even after advancing two hours.
- Exact restricted-account HTTP403 exhausts request/stream count budgets despite a persistent custom budget. Host persistent retains max-candidate/max-judge isolation and cannot cross unsafe replay boundaries. Synthetic terminal business responses with HTTP400/408/500/503/504 and network-looking messages never retry.
- Real local HTTP/SDK integration preserves host codes on errors after output. The test first exposed SDK-flattened errors containing the original frame in data; matching now uses that structured frame. The existing HTTP408/429/503 recovery test still verifies correct-directory delivery, zero wrong-directory events and matching GlobalBus.directory.
- Boundary review reproduced a plugin preparation APICallError incorrectly acquiring a host code, then fixed it by moving first binding from whole-attempt/fullStream to actual doStream/raw provider stream. A real tool-repair callback throwing the same API-shaped error remains native; HTTP and post-output SSE bindings plus provider cancellation still pass. SDK RetryError inherits only an already-bound last error, preserving reload identity and provider isolation.
- Safety review reproduced a numeric business code masking context_length_exceeded in a stream error type. Independent code/type checks now keep raw/SDK-flattened frames and JSON round-trips terminal and unstamped, with and without a catalog.
- Real @ai-sdk/openai-compatible post-output SSE tests first reproduced loss of structured error fields into a string. Six red-to-green cases cover terminal/persistent/context behavior with and without top-level type. Persistent retries the actual request to recovery despite a zero-retry caller budget; terminal/context stop after one request. Complete-JSON and field selectors both work; raw chunks never appear in returned fullStream events and schema/JSON normalization retains the result.
- Production-routing follow-up: four regression cases failed on the old ALS-first binding. The real Session service test confirmed message/part rows persisted while the owner received neither event, the wrong instance received both, and all four ordinary/sync GlobalBus envelopes carried the wrong directory and project. Fiber-first binding makes the same test pass; additional cases cover deferred async callbacks, database use/transaction commit effects, Fiber-only, ALS-only and context-free binding.
- Post-routing regression run: 216 pass, 0 fail (1161 assertions) across instance-state, run-service, database, storage, sync, three Bus suites, registry, retry and two LLM suites. Package `bun typecheck` and `git diff --check` pass.
- Generic selector follow-up first reproduced 18 failures against the old path schema (6 tests still passed). Final registry/retry/LLM/LLM-retry/provider-error/message-v2 suites: 230 pass, 0 fail (2315 assertions), including 31 registry tests. Coverage includes root scalars/arrays/null, escaped and empty keys, canonical array indexes, own-property traversal, strict types, whole-catalog rejection, retained snapshots and arbitrary structured error payloads through bind/fromError.
- Complete-JSON matching also preserves literal prototype-named keys. A separate red test exposed record-schema stripping of `__proto__` and rejection of an own `constructor`; strict JSON validation plus a detached clone now preserves those keys without reading inherited members during pointer resolution. Package `bun typecheck` and `git diff --check` pass.
- Malformed RetryError follow-up reproduced failures in both API response extraction and binding inheritance when lastError was absent and errors was missing or non-array. Both paths now guard the history with Array.isArray, matching message-v2 normalization; valid lastError remains preferred and a genuine array still falls back to its final entry. Two new path-specific regressions cover missing/null/scalar/object/array-like history without borrowing a forged binding. Registry plus message-v2: 76 pass, 0 fail (1496 assertions); the final six-suite run above also passes. Package `bun typecheck` and `git diff --check` pass.
- Review follow-up reproduced two failures before correction: nested error-shaped data displaced an outer raw error frame, and direct catalog loading leaked validation/clone exceptions. Field and complete-JSON regressions now preserve the outer frame; Proxy/DataCloneError and throwing-getter inputs return rejection while retaining the previous snapshot and rule behavior. Registry-only verification: 31 pass, 0 fail (786 assertions); final expanded verification is the six-suite result above.
- Native retry/source-trust follow-up added eight regressions, first failing in a seven-case run plus a separate non-API field-exclusion case. Real SDK HTTP408→TypeError history now stays bounded; earlier 404/401/network attempts cannot classify the final 503, while a final error's actual network cause survives JSON. Empty/unmatched catalogs retain HTTP400 stream/rate-limit recovery. Real chat.params plugins throwing either a plain APIError-shaped object or a constructed APIError with forged bounded stamps now stop after one attempt, not two. Strict live normalization rejects forged API and non-API fields but preserves existing bindings across reloads and repeated normalization; trusted schema/JSON restoration retains fields without acquiring a live binding. Final six-suite verification: 238 pass, 0 fail (2401 assertions); processor/max-mode verification: 30 pass, 2 existing skips, 0 fail. Package typecheck and git diff --check pass.
- Independent review reproduced loss of a single final safety fact after removing the SDK retry wrapper. Cause-bearing inputs now retain every nonempty operative summary, including one entry. A real generateText HTTP408→SubscriptionUsageLimitError regression verifies terminal decisions before normalization, after live normalization and after JSON restoration; equivalent FreeUsageLimitError/ProviderAuthError/ContextOverflowError cases and the earlier-history→503 controls pass. The new test failed before the one-line preservation fix. Registry/message-v2/retry verification: 185 pass, 0 fail (2250 assertions); package typecheck and git diff --check pass.
- Final review follow-up first reproduced two boundary failures: malformed output-length name-only objects bypassed schema validation and crashed strict live normalization, and bare safety-named Errors lost terminality without a cause wrapper. Removed the redundant output-length direct-return branch; valid instances and serialized forms still pass the existing schema path. Safety facts are supplemented only when normalization loses terminality, preserving raw/live/JSON decisions and repeated restoration without growing metadata. Final six-suite verification: 242 pass, 0 fail (2475 assertions); package typecheck and git diff --check pass.
