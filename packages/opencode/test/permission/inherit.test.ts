import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
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
  forwardRef.clearParentGrants("ses_parent")
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
  for (const granted of [true, false]) {
    it.live(
      `[TP-R20-03] interactive subagent ${granted ? "inherits a matching grant without asking" : "asks and resumes when inheritance misses"}`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          forwardRef.setParentGrants("ses_parent", {
            ruleset: [],
            approved: [{ permission: "edit", pattern: "/granted/dir/*", action: "allow" }],
          })
          let asked = 0
          const askedEvent = yield* Deferred.make<void>()
          const events = yield* Bus.Service
          const unsub = yield* events.subscribeCallback(Permission.Event.Asked, () => {
            asked += 1
            Effect.runSync(Deferred.succeed(askedEvent, undefined))
          })
          yield* Effect.addFinalizer(() => Effect.sync(unsub))
          const fiber = yield* perm.ask(childAsk(
            [granted ? "/granted/dir/file.ts" : "/foreign/dir/file.ts"],
            { interactive: true },
          )).pipe(Effect.forkScoped)
          if (!granted) {
            yield* Deferred.await(askedEvent)
            const [pending] = yield* perm.list()
            expect(asked).toBe(1)
            yield* perm.reply({ requestID: pending.id, reply: "once" })
          }
          expect((yield* Fiber.await(fiber))._tag).toBe("Success")
          expect(asked).toBe(granted ? 0 : 1)
          expect(yield* perm.list()).toHaveLength(0)
        }),
      ),
    )
  }

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
    "same-session actor subagent inherits parent always-grant",
    provideTmpdirInstance(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          // Parent asks and the user replies always — writes instance approved and
          // refreshes the parent-grant snapshot under the shared session id.
          const fiber = yield* perm
            .ask({
              permission: "bash" as never,
              patterns: ["git status"],
              always: ["git status"],
              metadata: {},
              sessionID: "ses_main" as never,
              ruleset: [],
              tool: { messageID: "msg_p" as never, callID: "call_p" },
            })
            .pipe(Effect.forkScoped)
          while ((yield* perm.list()).length === 0) {
            yield* Effect.promise(() => Bun.sleep(10))
          }
          const [pending] = yield* perm.list()
          yield* perm.reply({ requestID: pending.id, reply: "always" })
          yield* Fiber.await(fiber)

          // Same-session subagent: decideAskRouting inherits under the shared
          // session id. Still non-interactive; the always-grant auto-allows.
          const result = yield* perm
            .ask({
              permission: "bash" as never,
              patterns: ["git status"],
              always: ["*"],
              metadata: {},
              sessionID: "ses_main" as never,
              ruleset: [],
              tool: { messageID: "msg_c" as never, callID: "call_c" },
              interactive: false,
              inherit: { parentSessionID: "ses_main" },
            })
            .pipe(Effect.exit)
          expect(result._tag).toBe("Success")
        }),
      ),
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

/**
 * Background subagent ask shape after decideAskRouting:
 * interactive:false, inherit: { parentSessionID: current session } when the
 * actor row is a background subagent with a session id.
 */
function subagentAsk(extra?: Partial<Parameters<Permission.Interface["ask"]>[0]>) {
  return {
    permission: "bash" as never,
    patterns: ["wc -l /tmp/foo"],
    always: ["*"],
    metadata: {},
    sessionID: "ses_main" as never,
    ruleset: [],
    tool: { messageID: "msg_a" as never, callID: "call_a" },
    interactive: false as boolean,
    inherit: { parentSessionID: "ses_main" },
    ...extra,
  }
}

describe("skip-all inheritance for background subagents", () => {
  it.live(
    "skipAll=true + production inherit shape → auto-allow, no human ask",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setSkipAll(true)
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        // Production routing always attaches inherit. skip-all must still win
        // even when the parent snapshot has no matching allow.
        const result = yield* perm.ask(subagentAsk()).pipe(Effect.exit)
        unsub()
        expect(result._tag).toBe("Success")
        expect(asked).toBe(0)
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "skipAll=false + inherit, parent grant does not cover the pattern → fail-closed",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        expect(yield* perm.skipAll()).toBe(false)
        // Distinct parent session so the child's own setParentGrants write under
        // ses_main cannot clobber the grant we are testing against.
        forwardRef.setParentGrants("ses_parent", {
          ruleset: [],
          approved: [{ permission: "bash", pattern: "git status", action: "allow" }],
        })
        const result = yield* perm
          .ask(
            subagentAsk({
              inherit: { parentSessionID: "ses_parent" },
            }),
          )
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(String(result.cause)).toContain("PermissionDeniedError")
        }
      }),
    ),
  )

  it.live(
    "skipAll=false + inherit to session with empty snapshot → still fail-closed",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        // No prior always-grant under ses_main. The child's own ask() publishes
        // an empty snapshot first, then inherit finds nothing to allow.
        const result = yield* perm.ask(subagentAsk()).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "full access does not appear in inherit snapshot: ruleset stays ask",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        // Simulate full-access mode: skip-all on, parent ruleset still ask.
        yield* perm.setSkipAll(true)
        // Parent ask publishes grants; skip-all auto-allows before approved is written.
        yield* perm
          .ask({
            permission: "bash" as never,
            patterns: ["wc -l /tmp/foo"],
            always: ["*"],
            metadata: {},
            sessionID: "ses_main" as never,
            ruleset: [],
            tool: { messageID: "msg_p" as never, callID: "call_p" },
          })
          .pipe(Effect.exit)
        // Child with inherit only (skip-all OFF) must NOT be saved by inherit,
        // because full access never wrote an allow into the parent snapshot.
        yield* perm.setSkipAll(false)
        const child = yield* perm.ask(subagentAsk()).pipe(Effect.exit)
        expect(child._tag).toBe("Failure")
      }),
    ),
  )
})

describe("[TP-R20-07] Permission.reply reject source isolation", () => {
  it.live(
    "reject does not cascade to a different tool.messageID source",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const askA = yield* perm
          .ask({
            permission: "bash" as never,
            patterns: ["sudo ls"],
            always: ["*"],
            metadata: {},
            sessionID: "ses_main" as never,
            ruleset: [],
            tool: { messageID: "msg_a" as never, callID: "c_a" },
          })
          .pipe(Effect.forkScoped)
        const askB = yield* perm
          .ask({
            permission: "bash" as never,
            patterns: ["sudo ls"],
            always: ["*"],
            metadata: {},
            sessionID: "ses_main" as never,
            ruleset: [],
            tool: { messageID: "msg_b" as never, callID: "c_b" },
          })
          .pipe(Effect.forkScoped)
        while ((yield* perm.list()).length < 2) {
          yield* Effect.promise(() => Bun.sleep(10))
        }
        const pending = yield* perm.list()
        const a = pending.find((x) => x.tool?.callID === "c_a")!
        yield* perm.reply({ requestID: a.id, reply: "reject" })
        // R20: reject A 不得连坐 B — B 仍留在 pending
        const left = yield* perm.list()
        expect(left.length).toBe(1)
        expect(left[0]!.tool?.callID).toBe("c_b")
        yield* Fiber.interrupt(askA).pipe(Effect.ignore)
        yield* Fiber.interrupt(askB).pipe(Effect.ignore)
      }),
    ),
  )

  it.live(
    "reject cascades only within the same tool.messageID",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const askA = yield* perm
          .ask({
            permission: "bash" as never, patterns: ["sudo ls"], always: ["*"], metadata: {},
            sessionID: "ses_main" as never, ruleset: [],
            tool: { messageID: "msg_a" as never, callID: "c_a" },
          })
          .pipe(Effect.forkScoped)
        const askA2 = yield* perm
          .ask({
            permission: "bash" as never, patterns: ["sudo ls"], always: ["*"], metadata: {},
            sessionID: "ses_main" as never, ruleset: [],
            tool: { messageID: "msg_a" as never, callID: "c_a2" },
          })
          .pipe(Effect.forkScoped)
        while ((yield* perm.list()).length < 2) yield* Effect.promise(() => Bun.sleep(10))
        const pending = yield* perm.list()
        const a = pending.find((x) => x.tool?.callID === "c_a")!
        yield* perm.reply({ requestID: a.id, reply: "reject" })
        expect((yield* perm.list()).length).toBe(0)
        yield* Fiber.interrupt(askA).pipe(Effect.ignore)
        yield* Fiber.interrupt(askA2).pipe(Effect.ignore)
      }),
    ),
  )

  it.live(
    "reject does not cascade when either side lacks tool.messageID",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const askNamed = yield* perm
          .ask({
            permission: "bash" as never, patterns: ["sudo ls"], always: ["*"], metadata: {},
            sessionID: "ses_main" as never, ruleset: [],
            tool: { messageID: "msg_a" as never, callID: "c_a" },
          })
          .pipe(Effect.forkScoped)
        const askAnon = yield* perm
          .ask({
            permission: "bash" as never, patterns: ["sudo ls"], always: ["*"], metadata: {},
            sessionID: "ses_main" as never, ruleset: [],
          })
          .pipe(Effect.forkScoped)
        while ((yield* perm.list()).length < 2) yield* Effect.promise(() => Bun.sleep(10))
        const pending = yield* perm.list()
        const a = pending.find((x) => x.tool?.callID === "c_a")!
        yield* perm.reply({ requestID: a.id, reply: "reject" })
        const left = yield* perm.list()
        expect(left.length).toBe(1)
        expect(left[0]!.tool?.callID ?? "no-tool").toBe("no-tool")
        yield* Fiber.interrupt(askNamed).pipe(Effect.ignore)
        yield* Fiber.interrupt(askAnon).pipe(Effect.ignore)
      }),
    ),
  )
})
