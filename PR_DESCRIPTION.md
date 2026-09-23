## Summary
- Generic Host Error Registry: embedders inject a declarative `code → RetryClass` catalog (JSON map, no host functions / message regex).
- Birth identity (`APIError:<status>` / `NamedError:<name>` / `ErrorName:<name>`) stamped at normalization; fields live under `data.hostCode` / `data.hostRetryClass` and round-trip `toObject`/`fromError`.
- `decide()` enforces terminal invariants first, then host class only (missing class → terminal), then legacy heuristics. `RetryDecision.hostCode` feeds retry status.
- Bootstrap: `loadHostErrorCatalog` / `loadHostErrorCatalogFile` / `HOST_ERROR_CATALOG` env.

## Test plan
- `bun test test/error/host-registry.test.ts test/session/retry.test.ts` — 14 + 82 pass
