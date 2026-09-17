import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { PartID, MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

// [TP-SR-R21-16]
describe("resume empty residue", () => {
  test("recovery lists empty tail; resume cleans shells without Abandoned-as-resumed", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "empty residue resume" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              time: { created: Date.now() },
            })

            const emptyShell = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              parentID: user.id,
              sessionID: session.id,
              mode: "build",
              agent: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("test-model"),
              providerID: ProviderID.make("test"),
              time: { created: Date.now() },
            })
            const emptyShell2 = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              parentID: user.id,
              sessionID: session.id,
              mode: "build",
              agent: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("test-model"),
              providerID: ProviderID.make("test"),
              time: { created: Date.now() + 1 },
            })

            const before = yield* prompt.recovery({ sessionID: session.id, agentID: "main", allowBusy: true })
            // resume empty tail — may fail later in runLoop without a real model, but cleanup must run first
            yield* prompt
              .resumeBackground({
                sessionID: session.id,
                assistantMessageID: emptyShell2.id,
                agentID: "main",
              })
              .pipe(Effect.catch(() => Effect.void))
            // allow detached runLoop / finalizers a beat
            yield* Effect.sleep("200 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            const shell1 = after.find((m) => m.info.id === emptyShell.id)
            const shell2 = after.find((m) => m.info.id === emptyShell2.id)
            const anyAbandonedAsResumed = after.some((m) => {
              if (m.info.role !== "assistant" || !m.info.error) return false
              const err = m.info.error as { data?: { message?: string }; message?: string }
              const msg = err?.data?.message ?? err?.message ?? ""
              return msg.includes("Abandoned: resumed as a new assistant turn")
            })
            return {
              parents: before.map((c) => c.parentMessageID),
              userParent: user.id,
              shell1Gone: shell1 === undefined,
              shell2Gone: shell2 === undefined,
              anyAbandonedAsResumed,
              candidateCount: before.length,
              candidateIds: before.map((c) => c.assistantMessageID),
            }
          }),
        ),
    })
    // recovery still surfaces the empty tail id (API shape unchanged); resume behavior is internal
    expect(result.candidateCount).toBeGreaterThan(0)
    expect(result.parents.every((p) => p === result.userParent)).toBe(true)
    // [TP-SR-R21-16] parent 下全部 empty residue 必须删干净，不得只清 resume 目标那一条
    expect(result.shell1Gone).toBe(true)
    expect(result.shell2Gone).toBe(true)
    expect(result.anyAbandonedAsResumed).toBe(false)
  })

  test("assistant with tool parts remains a recovery candidate after empty-path change", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "tool residue resume" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              time: { created: Date.now() },
            })
            const assistant = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              parentID: user.id,
              sessionID: session.id,
              mode: "build",
              agent: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("test-model"),
              providerID: ProviderID.make("test"),
              time: { created: Date.now() },
              finish: "tool-calls",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "tool",
              callID: "call_1",
              tool: "bash",
              state: {
                status: "running",
                input: { command: "ls" },
                title: "ls",
                metadata: {},
                time: { start: Date.now() },
              },
            })
            const candidates = yield* prompt.recovery({ sessionID: session.id, agentID: "main", allowBusy: true })
            return { candidates }
          }),
        ),
    })
    // tool-bearing incomplete assistant remains a recovery candidate (API shape unchanged)
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0]?.parentMessageID).toBeDefined()
  })
})
