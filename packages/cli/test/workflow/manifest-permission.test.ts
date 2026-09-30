import { describe, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { Permission } from "../../src/permission"
import { Bus } from "../../src/bus"
import { makeLayer, ref, providerCfg } from "./lib"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(makeLayer())

// A workflow whose meta declares a permission the SESSION does NOT already allow.
// The up-front manifest ask therefore genuinely needs a decision. The body does
// no agent() call so the run's only permission interaction is the up-front ask.
const scriptWithManifest = [
  `export const meta = {`,
  `  name: "t",`,
  `  description: "d",`,
  `  permissions: [{ permission: "bash", patterns: ["rm *"], always: ["rm *"], reason: "cleanup" }],`,
  `}`,
  `return "body-ran"`,
].join("\n")

describe("WorkflowRuntime up-front manifest permission ask", () => {
  // THE REGRESSION: a workflow launched NON-INTERACTIVELY (background/nested — no
  // human attached) must NOT hang on the up-front manifest ask. With interactive
  // omitted (defaults fail-closed) and no session allow-rule, the ask would block
  // forever if it were interactive; instead the permission layer returns DeniedError
  // immediately, catchCause swallows it, and the run completes. A bounded wait
  // proves no hang (a hang would make wait() time out and the run stay "running").
  it.live("non-interactive launch does NOT hang — fails closed and completes", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const bus = yield* Bus.Service
        const asked: string[] = []
        yield* bus.subscribeCallback(Permission.Event.Asked, (e) => asked.push(e.properties.permission))
        // NO allow rule -> the manifest ask needs a human decision.
        const parent = yield* session.create({ title: "wf noninteractive" })
        // interactive omitted => StartInput default (fail-closed / interactive:false).
        const { runID } = yield* runtime.start({
          script: scriptWithManifest,
          sessionID: parent.id,
          parentActorID: "main",
          model: ref,
        })
        const outcome = yield* runtime.wait({ runID, timeoutMs: 5_000 })
        expect(outcome.status).toBe("completed")
        expect((outcome as { result: string }).result).toBe("body-ran")
        yield* Effect.sleep("50 millis") // bus is async
        // Fail-closed path creates NO Deferred and publishes NO Asked event.
        expect(asked).toEqual([])
      }),
      { git: true, config: providerCfg },
    ),
  )

  // The complement: a FOREGROUND launch (interactive:true, a human is attached)
  // still PROMPTS as before. We prove the ask fires by observing the Asked event
  // and answering it ("always") so the test itself doesn't block — demonstrating
  // the interactive path is preserved, not silently forced closed.
  it.live("interactive launch still prompts the human (Asked event fires)", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const permission = yield* Permission.Service
        const bus = yield* Bus.Service
        const asked: string[] = []
        // Answer each ask immediately so the interactive ask resolves instead of
        // blocking the test — the point is that an ask HAPPENS at all.
        yield* bus.subscribeCallback(Permission.Event.Asked, (e) => {
          asked.push(e.properties.permission)
          Effect.runFork(permission.reply({ requestID: e.properties.id, reply: "always" }).pipe(Effect.ignore))
        })
        const parent = yield* session.create({ title: "wf interactive" })
        const { runID } = yield* runtime.start({
          script: scriptWithManifest,
          sessionID: parent.id,
          parentActorID: "main",
          model: ref,
          interactive: true,
        })
        const outcome = yield* runtime.wait({ runID, timeoutMs: 5_000 })
        expect(outcome.status).toBe("completed")
        expect((outcome as { result: string }).result).toBe("body-ran")
        yield* Effect.sleep("50 millis")
        expect(asked).toContain("bash")
      }),
      { git: true, config: providerCfg },
    ),
  )
})
