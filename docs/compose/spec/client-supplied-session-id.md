---
feature: client-supplied-session-id
status: designed
updated: 2026-02-20
source: feat/session-id-from-client
---

# Client-Supplied Session ID

## Report

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

`Session.CreateInput` gains `id: SessionID.zod.optional()`. `Session.create`
forwards it to `createNext`. `SessionShare.create` already forwards the whole
`CreateInput`, so no change is needed there.

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

`SessionID.descending(given)` validates only the `ses` prefix. That is
intentional and unchanged: the engine does not need to police the payload, and a
stricter validator would reject ids that already exist in the wild.

### S2.3 Duplicate ids are rejected, not silently resolved

`Session.Event.Created` projects through a bare `db.insert`. A supplied id that
already exists would otherwise surface as a primary-key constraint failure from
inside the sync projection, after the `created` event has already been
announced.

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
- Validating the full id payload (length, charset, timestamp component) on the
  engine side.
- Changing how session lists order, or making ordering depend on the id.
- Exposing a dedicated id-allocation endpoint.
- Fork, spawn, import and workspace-restore paths; they keep generating ids
  engine-side.

## Tasks

- [ ] T1: `Session.CreateInput` accepts an optional `id` and `create` forwards it to `createNext` — acceptance: `POST /session` with a well-formed `ses_` id persists a session under exactly that id; omitting it still generates one (covers: S2.1)
- [ ] T2: A supplied id that already exists fails with an explicit error naming the id, before any row is written — acceptance: creating twice with the same supplied id yields one session and a named error on the second call (covers: S2.3)
- [ ] T3: Shape agreement is pinned by tests on the engine side — acceptance: an engine-generated session id and the documented shape agree; a supplied id with the wrong prefix is rejected (covers: S2.2)
- [ ] T4: Regenerate the SDK types so `CreateInput` exposes `id` — acceptance: the generated `types.gen.ts` carries the optional field and `bun run typecheck` stays green (covers: S2.1)
- [ ] T5: Document the host-facing contract — acceptance: the shape, the duplicate contract and the omitted-id fallback are stated where an embedding host will look (covers: S2.1, S2.2, S2.3)

## Journey log
