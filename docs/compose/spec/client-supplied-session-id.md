---
feature: client-supplied-session-id
status: delivered
updated: 2026-10-28
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2738
---

# Client-Supplied Session ID

## Report

**What was built** — `POST /session` accepts an optional caller-supplied `id`.
The id must be `ses_` plus 26 base62 characters, the shape the engine itself
emits (v1 and v2). A supplied id is persisted verbatim; a duplicate is rejected
with an error naming it. Omitting the field generates an id exactly as before.
The SDK types expose the field and the generated OpenAPI publishes the pattern.

**Verification** (at 9404cccc) — `bun run typecheck` PASS (all workspaces);
`bun test test/session/client-supplied-id.test.ts` PASS 4/4; `bun test
test/session/` PASS 1417, 0 fail, 13 skip, 1 todo; `bun test test/server/` PASS
249, 0 fail; `bun run lint` on the touched files PASS 0 errors (7 pre-existing
warnings); `git diff --check` clean; OpenAPI generation publishes
`^ses_[0-9A-Za-z]{26}$` for `requestBody.id`.

## [S1] Problem

An embedding host that shows a conversation before the engine has created its
session cannot use the engine's session id as the conversation's identity. MiMo
Desktop therefore invents a local id (`c<timestamp>-<sequence>`), renders the
first turn under it, and only learns the engine id (`ses_...`) once
`POST /session` returns. It then rewrites every key that held the local id
(`convo.engineSid`, message map, composer drafts, run routing) during the
reconcile that follows the turn.

That identity swap is structurally visible. Message row ids embed the
conversation id, so every row remounts; inline editing state, focus, selection
and expanded state live in component-local state and are lost. Desktop reports
this as a full-page flash at the end of a new conversation's first turn.

The root cause is not the rewrite; it is that the engine assigns an identity the
host must adopt after the fact. Session creation already accepts a caller-supplied
id internally — `Session.createNext` takes `id?: SessionID` and `createNext`
resolves it through `SessionID.descending(input.id)` — but no caller passes it,
and the public `CreateInput` does not expose it. The capability exists one layer
below the surface that needs it.

## [S2] Design

### S2.1 Public create accepts an optional id

`Session.CreateInput` gains an optional `id`, bounded to the documented shape
(`ses_` plus 26 base62 characters — see S2.2). `Session.create` forwards it to
`createNext`. `SessionShare.create` already forwards the whole `CreateInput`, so
no change is needed there.

An id supplied through the HTTP `POST /session` body reaches the persisted row
unchanged. An omitted id keeps today's behavior exactly: the engine generates one.

The field is opt-in and additive. Every existing caller — CLI, TUI, ACP, spawn,
fork, import — continues to omit it and is unaffected.

### S2.2 Id shape is shared, generation is duplicated by contract

The host generates the id, so both sides must agree on its shape. The rule is
the one `Identifier.descending("session")` already produces:

```text
ses_ + 16 lowercase hex characters + 10 base62 characters   (26 characters after the prefix)
```

Session ids deliberately omit the v2 sort marker (`g` / `-`) that other
identifiers carry — see the existing comment in `Identifier.create` — because
session ids are copied into resume commands and session lists order by
`time_updated`, not by id. That is why the session payload spends its 26
characters on 16 hex plus 10 base62 rather than a marker plus 16 hex plus 9
base62. A host-generated id must match that same shape, and must not carry the
marker.

Generation stays duplicated rather than shared. The engine keeps `Identifier`;
the host keeps its own generator. Both are pinned by tests against the same
documented shape, so a drift in either side fails a test rather than producing
ids the other side rejects.

`SessionID` itself still validates only the `ses` prefix: ids already in storage
predate this shape (v1 is 12 hex plus 14 base62, also 26 base62 characters), and
internal callers are trusted. The one entry point that takes an id from outside —
`CreateInput.id` — is bounded to the documented shape instead. Prefix-only
validation there is not safe: the id names the session's memory directory
(`memory/sessions/<id>/`), so a caller-chosen `ses_../../../tmp/x` would climb out
of it. Bounding the payload to 26 base62 characters rejects nothing the engine
emits and closes that path.

### S2.3 Duplicate ids are rejected, not silently resolved

`Session.Event.Created` projects through a bare `db.insert`. A supplied id that
already exists would otherwise surface as a raw primary-key constraint failure
from inside the sync projection.

`createNext` therefore checks for an existing row before it builds `Info`, and
fails with an explicit error naming the id. The check runs for supplied ids
only; the generated path cannot collide and pays no extra query.

Failing loudly is the chosen contract because a duplicate supplied id means the
host has a bug in its generator or its deduplication. Returning the existing
session would hide that bug behind a successful response and hand the host a
session it does not own.

### S2.4 Boundary of this change

This change makes the identity available up front. It does not remove the swap
for conversations that already carry a local id, and it does not change
Desktop's reconcile behavior. Those are host-side consequences, tracked
separately.

## [S3] Out of Scope

- Any Desktop-side change: conversation store, reconcile, message row identity,
  or the deferred navigation boundary.
- Removing the existing local-id mechanism, or migrating conversations that
  already carry one.
- Hardening the path helpers themselves, or ids that arrive through other
  channels (sync restore): this change bounds the new host-facing create only.
- Validating the timestamp component of a supplied id. Length and charset are
  bounded by `CreateInput`; the payload beyond that stays opaque.
- Changing how session lists order, or making ordering depend on the id.
- Exposing a dedicated id-allocation endpoint.
- Fork, spawn, import and workspace-restore paths; they keep generating ids
  engine-side.

## Tasks

- [x] T1: `Session.CreateInput` accepts an optional `id` and `create` forwards it to `createNext` — acceptance: `POST /session` with a well-formed `ses_` id persists a session under exactly that id; omitting it still generates one (covers: S2.1)
- [x] T2: A supplied id that already exists fails with an explicit error naming the id, before any row is written — acceptance: creating twice with the same supplied id yields one session and a named error on the second call (covers: S2.3)
- [x] T3: Shape agreement is pinned by tests on the engine side — acceptance: an engine-generated session id and the documented shape agree; a supplied id outside the documented shape (wrong prefix, wrong length, path separators) is rejected (covers: S2.2)
- [x] T4: Regenerate the SDK types so `CreateInput` exposes `id` — acceptance: the generated `types.gen.ts` carries the optional field and `bun run typecheck` stays green (covers: S2.1)
- [x] T5: Document the host-facing contract — acceptance: the shape, the duplicate contract and the omitted-id fallback are stated where an embedding host will look (covers: S2.1, S2.2, S2.3)

## Journey log

- Review caught that a prefix-only `CreateInput.id` reaches `memory/sessions/<id>/`
  as a path segment. The create boundary now enforces the engine's own shape
  (26 base62 characters) instead of accepting any `ses`-prefixed string; the
  generic `SessionID` schema and the path helpers are unchanged.
- The bound first sat in a `refine` on the piped `SessionID` schema, which the
  OpenAPI generator ignores — the published pattern stayed permissive. It is now
  a regex on the input side of the pipe, so the machine-readable contract and
  the runtime check agree.
