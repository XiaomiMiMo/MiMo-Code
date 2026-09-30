import { afterEach, describe, expect } from "bun:test"
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

const bus = Bus.layer
const env = Layer.mergeAll(Permission.layer.pipe(Layer.provide(bus)), bus, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

function buildRequest(extra?: Partial<Parameters<Permission.Interface["ask"]>[0]>) {
  return {
    permission: "edit" as never,
    patterns: ["/some/never-allowed-path"],
    always: ["*"],
    metadata: {},
    sessionID: "ses_test" as never,
    ruleset: [],
    tool: { messageID: "msg_test" as never, callID: "call_test" },
    ...extra,
  }
}

describe("Permission skip-all runtime toggle", () => {
  it.live(
    "defaults to off",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        expect(yield* perm.skipAll()).toBe(false)
      }),
    ),
  )

  it.live(
    "auto-allows an ask that would otherwise block",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setSkipAll(true)
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        const result = yield* perm.ask(buildRequest()).pipe(Effect.exit)
        unsub()
        expect(result._tag).toBe("Success")
        expect(asked).toBe(0)
        expect((yield* perm.list()).length).toBe(0)
      }),
    ),
  )

  it.live(
    "explicit deny rules still win over skip-all",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setSkipAll(true)
        const result = yield* perm
          .ask(buildRequest({ ruleset: [{ permission: "edit", pattern: "*", action: "deny" }] }))
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "forced-ask permissions (bash_delete) still block under skip-all",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        // Isolate skip-all from a process started in dangerous mode, which now
        // seeds the separate delete exemption by design.
        yield* perm.setAutoApproveDelete(false)
        yield* perm.setSkipAll(true)
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        // interactive:false so the forced ask fails fast instead of blocking the test.
        const result = yield* perm
          .ask(buildRequest({ permission: "bash_delete" as never, interactive: false }))
          .pipe(Effect.exit)
        unsub()
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "enabling skip-all flushes pending non-forced asks",
    provideTmpdirInstance(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          // Run a blocking ask in the background, wait for it to register.
          const fiber = yield* perm.ask(buildRequest()).pipe(Effect.forkScoped)
          while ((yield* perm.list()).length === 0) {
            yield* Effect.promise(() => Bun.sleep(10))
          }

          yield* perm.setSkipAll(true)
          const result = yield* Fiber.await(fiber)
          expect(result._tag).toBe("Success")
          expect((yield* perm.list()).length).toBe(0)
        }),
      ),
    ),
  )

  it.live(
    "disabling skip-all restores blocking behavior",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        yield* perm.setSkipAll(true)
        yield* perm.setSkipAll(false)
        // interactive:false fails fast when it reaches the ask path — proving
        // the request was NOT auto-allowed.
        const result = yield* perm.ask(buildRequest({ interactive: false })).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }),
    ),
  )
})

describe("[TP-R20-04] computer permission isolation", () => {
  for (const scenario of [
    "default",
    "accept-edits",
    "wildcard-allow",
    "computer-allow",
    "delete-exemption",
    "skip-all",
    "full-access",
    "inherit-approved",
    "inherit-ruleset",
  ]) {
    it.live(
      `${scenario}: computer asks, accepts an explicit reply, and never remembers always`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          const events = yield* Bus.Service
          yield* perm.setPermissionAskTimeout(null)
          yield* perm.setAutoApproveDelete(scenario === "delete-exemption" || scenario === "full-access")
          yield* perm.setSkipAll(scenario === "skip-all" || scenario === "full-access")
          const inherit = scenario.startsWith("inherit-")
          if (inherit) {
            forwardRef.setParentGrants("ses_computer_parent", {
              ruleset: scenario === "inherit-ruleset" ? [{ permission: "*", pattern: "*", action: "allow" }] : [],
              approved: scenario === "inherit-approved" ? [{ permission: "*", pattern: "*", action: "allow" }] : [],
            })
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => forwardRef.parentGrants.delete("ses_computer_parent")),
            )
          }
          const ruleset: Permission.Ruleset =
            scenario === "accept-edits"
              ? [{ permission: "edit", pattern: "*", action: "allow" }]
              : scenario === "wildcard-allow" || scenario === "computer-allow"
                ? [{ permission: scenario === "wildcard-allow" ? "*" : "computer", pattern: "*", action: "allow" }]
                : []

          for (const reply of ["always", "reject"] as const) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const asked = yield* Deferred.make<Permission.Request>()
                const replied = yield* Deferred.make<{
                  requestID: Permission.Request["id"]
                  sessionID: Permission.Request["sessionID"]
                  reply: Permission.Reply
                }>()
                const seen: Permission.Request[] = []
                const unsubAsked = yield* events.subscribeCallback(Permission.Event.Asked, (event) => {
                  seen.push(event.properties)
                  Effect.runSync(Deferred.succeed(asked, event.properties))
                })
                const unsubReplied = yield* events.subscribeCallback(Permission.Event.Replied, (event) => {
                  Effect.runSync(Deferred.succeed(replied, event.properties))
                })
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    unsubAsked()
                    unsubReplied()
                  }),
                )
                const fiber = yield* perm
                  .ask(buildRequest({
                    permission: "computer",
                    patterns: ["click"],
                    ruleset,
                    ...(inherit ? { interactive: true, inherit: { parentSessionID: "ses_computer_parent" } } : {}),
                  }))
                  .pipe(Effect.exit, Effect.forkScoped)
                const request = yield* Deferred.await(asked).pipe(Effect.timeout("2 seconds"))
                expect(request).toMatchObject({ permission: "computer", patterns: ["click"], sessionID: "ses_test" })
                expect(yield* perm.list()).toEqual([request])
                yield* perm.reply({ requestID: request.id, reply })
                expect(yield* Deferred.await(replied).pipe(Effect.timeout("2 seconds"))).toEqual({
                  requestID: request.id,
                  sessionID: request.sessionID,
                  reply,
                })
                const result = yield* Fiber.join(fiber)
                expect(result._tag).toBe(reply === "reject" ? "Failure" : "Success")
                if (result._tag === "Failure") expect(String(result.cause)).toContain("PermissionRejectedError")
                expect(seen).toEqual([request])
                expect(yield* perm.list()).toEqual([])
                expect(forwardRef.getParentGrants("ses_test")?.approved).toEqual([])
              }),
            )
            yield* perm.setSkipAll(false)
            yield* perm.setAutoApproveDelete(false)
          }
        }),
      ),
    )
  }

  it.live(
    "enabling both full-access switches does not flush a pending computer ask",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const events = yield* Bus.Service
        yield* perm.setAutoApproveDelete(false)
        yield* perm.setPermissionAskTimeout(null)
        const asked = yield* Deferred.make<Permission.Request>()
        const unsub = yield* events.subscribeCallback(Permission.Event.Asked, (event) => {
          Effect.runSync(Deferred.succeed(asked, event.properties))
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsub))
        const fiber = yield* perm.ask(buildRequest({ permission: "computer", patterns: ["click"] }))
          .pipe(Effect.exit, Effect.forkScoped)
        const request = yield* Deferred.await(asked).pipe(Effect.timeout("2 seconds"))
        yield* perm.setSkipAll(true)
        yield* perm.setAutoApproveDelete(true)
        expect(yield* perm.list()).toEqual([request])
        yield* perm.reply({ requestID: request.id, reply: "once" })
        expect((yield* Fiber.join(fiber))._tag).toBe("Success")
        expect(yield* perm.list()).toEqual([])
      }),
    ),
  )

  for (const denied of [true, false]) {
    it.live(
      `full access cannot override computer ${denied ? "explicit deny" : "non-interactive fail-closed"}`,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const perm = yield* Permission.Service
          const events = yield* Bus.Service
          yield* perm.setSkipAll(true)
          yield* perm.setAutoApproveDelete(true)
          const seen: Permission.Request[] = []
          const drained = yield* Deferred.make<void>()
          const unsub = yield* events.subscribeCallback(Permission.Event.Asked, (event) => {
            if (event.properties.permission === "test_barrier") {
              Effect.runSync(Deferred.succeed(drained, undefined))
              return
            }
            seen.push(event.properties)
          })
          yield* Effect.addFinalizer(() => Effect.sync(unsub))
          const result = yield* perm.ask(buildRequest({
            permission: "computer",
            patterns: ["click"],
            interactive: denied,
            ruleset: denied ? [{ permission: "computer", pattern: "*", action: "deny" }] : [],
          })).pipe(Effect.exit)
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(String(result.cause)).toContain("PermissionDeniedError")
          yield* events.publish(Permission.Event.Asked, {
            ...buildRequest({ permission: "test_barrier" }),
            id: "per_barrier" as never,
          })
          yield* Deferred.await(drained).pipe(Effect.timeout("2 seconds"))
          expect(seen).toEqual([])
          expect(yield* perm.list()).toEqual([])
        }),
      ),
    )
  }
})
