import { expect, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Installation } from "../../src/installation"
import { SystemPrompt } from "../../src/session/system"

test("Installation.method() works without Instance context (mimo upgrade scenario)", async () => {
  const method = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.method()))
  expect(typeof method).toBe("string")
})

test("SystemPrompt layer constructs without Instance context", async () => {
  const svc = await AppRuntime.runPromise(
    Effect.gen(function* () {
      return yield* SystemPrompt.Service
    }).pipe(Effect.provide(SystemPrompt.layer)),
  )
  expect(svc.environment).toBeDefined()
  expect(svc.skills).toBeDefined()
})
