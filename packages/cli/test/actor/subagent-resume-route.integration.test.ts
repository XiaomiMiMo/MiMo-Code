import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ActorRegistry } from "../../src/actor/registry"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })
afterEach(async () => {
  await Instance.disposeAll()
})

const modelRef = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }

type WithId = { id: string }

async function seedProject(dir: string, origin: string) {
  await fs.writeFile(
    path.join(dir, "mimocode.json"),
    JSON.stringify(
      {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } } },
        agent: { custom: { model: "alibaba/qwen-plus", permission: { "*": "deny" } } },
      },
      null,
      2,
    ),
  )
}

// [TP-RUN-R12-32] [TP-RUN-R12-33] real POST /turn/:id/resume cascades idle subagent.
describe("resumeMainCascading integration", () => {
  test("POST resume cascades idle subagent and delivers scripted text", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = startScriptedLLMServer([
      { lines: textStopResponse("MAIN-RESUME-OK") },
      { lines: textStopResponse("CHILD-RESUME-OK") },
      { lines: textStopResponse("CHILD-RESUME-OK") },
    ])
    try {
      await seedProject(tmp.path, server.origin)
      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const reg = yield* ActorRegistry.Service
              const session = yield* sessions.create({ title: "resume cascade route" })

              const mainUser = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agent: "build",
                model: modelRef,
                time: { created: Date.now() },
              })
              const mainAsst = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "assistant" as const,
                parentID: mainUser.id,
                sessionID: session.id,
                mode: "build",
                agent: "build",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: modelRef.modelID,
                providerID: modelRef.providerID,
                time: { created: Date.now() },
              })

              yield* reg.register({
                sessionID: session.id,
                actorID: "custom-1",
                mode: "subagent",
                agent: "custom",
                description: "child",
                contextMode: "none",
                background: true,
                lifecycle: "ephemeral",
              })
              yield* reg.updateStatus(session.id, "custom-1", {
                status: "idle",
                lastOutcome: "failure",
                lastError: "abandoned",
              })
              const cUser = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agentID: "custom-1",
                agent: "custom",
                model: modelRef,
                time: { created: Date.now() },
              })
              const asst = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "assistant" as const,
                parentID: cUser.id,
                sessionID: session.id,
                agentID: "custom-1",
                mode: "build",
                agent: "custom",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: modelRef.modelID,
                providerID: modelRef.providerID,
                time: { created: Date.now() },
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: asst.id,
                sessionID: session.id,
                type: "text" as const,
                text: "partial",
              })

              // Real HTTP route — main (no agentID) → resumeMainCascading
              const app = Server.Default().app
              const q = `?directory=${encodeURIComponent(tmp.path)}`
              const res = yield* Effect.promise(() =>
                Promise.resolve(
                  app.request(`/session/${session.id}/turn/${(mainAsst as WithId).id}/resume${q}`, {
                    method: "POST",
                  }),
                ),
              )
              expect(res.status).toBe(202)

              let childOk = false
              for (let i = 0; i < 80 && !childOk; i++) {
                const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "custom-1" })
                childOk = msgs.some((m) =>
                  m.parts.some((p) => p.type === "text" && (p.text ?? "").includes("CHILD-RESUME-OK")),
                )
                if (!childOk) yield* Effect.sleep("100 millis")
              }
              let status = ""
              let outcome = ""
              for (let i = 0; i < 40; i++) {
                const row = yield* reg.get(session.id, "custom-1")
                status = row?.status ?? ""
                outcome = row?.lastOutcome ?? ""
                if (status === "idle") break
                yield* Effect.sleep("50 millis")
              }
              return { childOk, status, outcome, http: res.status }
            }),
          ),
      })
      expect(result.http).toBe(202)
      expect(result.childOk).toBe(true)
      expect(result.status).toBe("idle")
      expect(result.outcome).toBe("success")
    } finally {
      await server.stop()
    }
  }, 90_000)
})
