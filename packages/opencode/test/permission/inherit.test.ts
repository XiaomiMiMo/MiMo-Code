import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { forwardRef } from "../../src/permission/permission-forward-ref"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

beforeEach(() => {
  forwardRef.parentGrants.clear()
  forwardRef.clearGrantsForParent("ses_parent")
})

const bus = Bus.layer
const env = Layer.mergeAll(Permission.layer.pipe(Layer.provide(bus)), bus, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

// A background subagent's ask that would otherwise fail closed (interactive:false).
function childAsk(patterns: string[], extra?: Partial<Parameters<Permission.Interface["ask"]>[0]>) {
  return {
    permission: "edit" as never,
    patterns,
    always: ["*"],
    metadata: {},
    sessionID: "ses_child" as never,
    ruleset: [],
    tool: { messageID: "msg_test" as never, callID: "call_test" },
    interactive: false as boolean,
    inherit: { parentSessionID: "ses_parent" },
    ...extra,
  }
}

describe("Permission.ask parent-grant inheritance", () => {
  it.live(
    "ordinary background subagent auto-allowed for a dir the parent granted",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        // Parent already holds an "always"-approved grant for /granted/dir.
        forwardRef.setParentGrants("ses_parent", {
          ruleset: [],
          approved: [{ permission: "edit", pattern: "/granted/dir/*", action: "allow" }],
        })
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        const result = yield* perm.ask(childAsk(["/granted/dir/file.ts"])).pipe(Effect.exit)
        unsub()
        // Auto-allowed: succeeds, no human ask published, nothing left pending.
        expect(result._tag).toBe("Success")
        expect(asked).toBe(0)
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "ordinary background subagent still fails closed for an ungranted dir",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        forwardRef.setParentGrants("ses_parent", {
          ruleset: [],
          approved: [{ permission: "edit", pattern: "/granted/dir/*", action: "allow" }],
        })
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        const result = yield* perm.ask(childAsk(["/foreign/dir/file.ts"])).pipe(Effect.exit)
        unsub()
        // Not granted by the parent → fail closed (deny), no hang, no ask event.
        expect(result._tag).toBe("Failure")
        expect(asked).toBe(0)
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "no parent snapshot at all -> fails closed (never hangs)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const result = yield* perm.ask(childAsk(["/granted/dir/file.ts"])).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "inherit does NOT override an explicit parent deny",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        forwardRef.setParentGrants("ses_parent", {
          ruleset: [
            { permission: "edit", pattern: "/granted/*", action: "allow" },
            { permission: "edit", pattern: "/granted/secret/*", action: "deny" },
          ],
          approved: [],
        })
        const result = yield* perm.ask(childAsk(["/granted/secret/x.ts"])).pipe(Effect.exit)
        // Parent's own deny wins over its broader allow → child fails closed.
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "inherit does NOT let an approved allow escape a ruleset deny (deny-precedence)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        // The core regression: the parent's config ruleset DENIES edit **, but a
        // separately-approved (persisted "always") allow exists for /x. The
        // parent itself evaluates the ruleset ALONE first, so /x is denied for
        // the parent. The child must inherit that same denial — the approved
        // allow must NOT be able to out-rank the ruleset deny (which a flattened
        // [...ruleset, ...approved] + findLast snapshot would wrongly permit).
        forwardRef.setParentGrants("ses_parent", {
          ruleset: [{ permission: "edit", pattern: "**", action: "deny" }],
          approved: [{ permission: "edit", pattern: "/x/*", action: "allow" }],
        })
        const result = yield* perm.ask(childAsk(["/x/file.ts"])).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )
})

// An EXPLICIT `session grant-approval <child|all>` must reach a background
// SUBAGENT too. decideAskRouting routes such a child to `inherit` (never to
// `forward`), so before this the DB-backed grant was consulted nowhere on the
// subagent's path: `grant-approval` silently did nothing and the child's
// external_directory ask failed closed. Unlike the in-memory parentGrants
// snapshot, this grant survives a restart and a separate-process child, so it
// cannot lapse mid-task.
describe("Permission.ask explicit grant-approval reaches a background subagent", () => {
  it.live(
    "grant-approval for this child auto-approves with NO parent snapshot at all",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        forwardRef.setGrant("ses_parent", "ses_child")
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        // No setParentGrants: this is exactly the "snapshot missing / lapsed"
        // case (separate-process child, or a parent that never asked).
        const result = yield* perm
          .ask(childAsk(["/Users/me/projects/app/*"], { permission: "external_directory" as never }))
          .pipe(Effect.exit)
        unsub()
        expect(result._tag).toBe("Success")
        expect(asked).toBe(0)
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "an 'all' grant covers any child of that parent",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        forwardRef.setGrant("ses_parent", "*")
        const result = yield* perm
          .ask(childAsk(["/anywhere/x.ts"], { sessionID: "ses_other_child" as never }))
          .pipe(Effect.exit)
        expect(result._tag).toBe("Success")
      }),
    ),
  )

  it.live(
    "WITHOUT a grant and without a snapshot the subagent still fails closed",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const result = yield* perm.ask(childAsk(["/ungranted/x.ts"])).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "a grant for a DIFFERENT child does not leak to this one",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        forwardRef.setGrant("ses_parent", "ses_someone_else")
        const result = yield* perm.ask(childAsk(["/ungranted/x.ts"])).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "forced-ask (bash_delete) is NOT auto-approved by a grant",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        forwardRef.setGrant("ses_parent", "*")
        const result = yield* perm
          .ask(childAsk(["rm -rf /"], { permission: "bash_delete" as never }))
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )
})
