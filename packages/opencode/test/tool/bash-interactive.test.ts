import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import * as BashInteractive from "../../src/tool/bash-interactive"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(BashInteractive.defaultLayer, Bus.layer, CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer),
)

// Desktop turn-execution TP-R4-04b: source comes from the tool, never the active UI.
for (const sourced of [true, false]) {
  it.live(
    `[TP-R4-04b] interactive service preserves ${sourced ? "explicit source" : "source-free compatibility"} through event, list and reply`,
    () =>
      provideTmpdirInstance((directory) =>
        Effect.gen(function* () {
          const service = yield* BashInteractive.Service
          const bus = yield* Bus.Service
          const asked = Promise.withResolvers<BashInteractive.InteractiveRequest>()
          const unsubscribe = yield* bus.subscribeCallback(BashInteractive.Event.Asked, (event) =>
            asked.resolve(event.properties),
          )
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
          const source = sourced ? { sessionID: "ses_example", messageID: "msg_example", callID: "call_example" } : {}
          const fiber = yield* service
            .request({ command: "echo example", cwd: directory, description: "Example", ...source })
            .pipe(Effect.forkChild)
          const event = yield* Effect.promise(() => asked.promise)
          expect(event).toMatchObject({ command: "echo example", cwd: directory, description: "Example", ...source })
          expect(BashInteractive.Event.Asked.properties.parse(event)).toEqual(event)
          expect(yield* service.list()).toEqual([event])
          if (!sourced) {
            expect(event.sessionID).toBeUndefined()
            expect(event.messageID).toBeUndefined()
            expect(event.callID).toBeUndefined()
          }
          yield* service.reply({ id: event.id, output: "Declined by client", exitCode: 1 })
          expect(yield* Fiber.join(fiber)).toEqual({ output: "Declined by client", exitCode: 1 })
          expect(yield* service.list()).toEqual([])
        }),
      ),
  )
}
