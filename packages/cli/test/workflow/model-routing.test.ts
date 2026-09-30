import { describe, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { makeLayer, providerCfg } from "./lib"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(makeLayer())

describe("workflow agent({model}) tier routing", () => {
  it.live(
    "resolves a built-in tier ref without throwing and completes the run",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            title: "model-routing",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const runtime = yield* WorkflowRuntime.Service
          yield* llm.text("ok")
          const script = [
            `export const meta = { name: "mr", description: "d" }`,
            `const r = await agent("hi", { model: "lite" })`,
            `return { ok: r !== undefined }`,
          ].join("\n")
          const { runID } = yield* runtime.start({ script, sessionID: session.id, parentActorID: "main" })
          const outcome = yield* runtime.wait({ runID, timeoutMs: 30000 })
          expect(outcome.status).toBe("completed")
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )

  it.live(
    "unknown group ref falls back instead of throwing the run",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            title: "model-routing-fallback",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const runtime = yield* WorkflowRuntime.Service
          yield* llm.text("ok")
          const script = [
            `export const meta = { name: "mr2", description: "d" }`,
            `const r = await agent("hi", { model: "definitely-not-a-group" })`,
            `return { ok: r !== undefined }`,
          ].join("\n")
          const { runID } = yield* runtime.start({ script, sessionID: session.id, parentActorID: "main" })
          const outcome = yield* runtime.wait({ runID, timeoutMs: 30000 })
          expect(outcome.status).toBe("completed")
        }),
        { git: true, config: providerCfg },
      ),
    30000,
  )
})
