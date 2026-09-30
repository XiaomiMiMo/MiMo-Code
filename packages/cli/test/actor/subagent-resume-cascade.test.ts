import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ActorRegistry } from "../../src/actor/registry"
import { MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const modelRef = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

function incompleteAssistant(input: {
  sessionID: string
  parentID: string
  created: number
  cwd: string
  agentID?: string
}) {
  return {
    id: MessageID.ascending(),
    role: "assistant" as const,
    parentID: input.parentID,
    sessionID: input.sessionID,
    ...(input.agentID !== undefined ? { agentID: input.agentID } : {}),
    mode: "explore",
    agent: "explore",
    path: { cwd: input.cwd, root: input.cwd },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: modelRef.modelID,
    providerID: modelRef.providerID,
    time: { created: input.created },
  }
}

// [TP-RUN-R12-32] [TP-RUN-R12-33] cascade selection: candidates + not-this-process-live.
describe("cascadeSubagentResume", () => {
  test("selects idle/orphan subagent with incomplete assistant; skips clean idle and main", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const reg = yield* ActorRegistry.Service
            const session = yield* sessions.create({ title: "cascade resume" })

            const mainUser = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: modelRef,
              time: { created: Date.now() },
            })
            yield* sessions.updateMessage(
              incompleteAssistant({
                sessionID: session.id,
                parentID: mainUser.id,
                created: Date.now(),
                cwd: tmp.path,
              }) as Parameters<typeof sessions.updateMessage>[0],
            )

            // idle zombie with incomplete assistant → cascade-eligible (normal context:none)
            yield* reg.register({
              sessionID: session.id,
              actorID: "explore-1",
              mode: "subagent",
              agent: "explore",
              description: "zombie",
              contextMode: "none",
              background: true,
              lifecycle: "ephemeral",
            })
            yield* reg.updateStatus(session.id, "explore-1", {
              status: "idle",
              lastOutcome: "failure",
              lastError:
              'Process restarted; settled by abandon threshold. Not final — actor send can recover.',
            })
            const e1User = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agentID: "explore-1",
              agent: "explore",
              model: modelRef,
              time: { created: Date.now() },
            })
            yield* sessions.updateMessage(
              incompleteAssistant({
                sessionID: session.id,
                parentID: e1User.id,
                created: Date.now(),
                cwd: tmp.path,
                agentID: "explore-1",
              }) as Parameters<typeof sessions.updateMessage>[0],
            )

            // running (even past abandon-window locally) is never auto-takeover
            yield* reg.register({
              sessionID: session.id,
              actorID: "explore-orphan-run",
              mode: "subagent",
              agent: "explore",
              description: "orphan running",
              contextMode: "full",
              background: true,
              lifecycle: "ephemeral",
            })
            yield* reg.updateStatus(session.id, "explore-orphan-run", { status: "running" })
            const oUser = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agentID: "explore-orphan-run",
              agent: "explore",
              model: modelRef,
              time: { created: Date.now() },
            })
            yield* sessions.updateMessage(
              incompleteAssistant({
                sessionID: session.id,
                parentID: oUser.id,
                created: Date.now(),
                cwd: tmp.path,
                agentID: "explore-orphan-run",
              }) as Parameters<typeof sessions.updateMessage>[0],
            )

            // clean idle success → skip no-recovery-candidate
            yield* reg.register({
              sessionID: session.id,
              actorID: "explore-2",
              mode: "subagent",
              agent: "explore",
              description: "clean idle",
              contextMode: "full",
              background: true,
              lifecycle: "ephemeral",
            })
            yield* reg.updateStatus(session.id, "explore-2", {
              status: "idle",
              lastOutcome: "success",
            })

            const pre = yield* prompt.recovery({ sessionID: session.id, agentID: "explore-1", allowBusy: true })
            expect(pre.length).toBeGreaterThan(0)

            const outcomes = yield* prompt.cascadeSubagentResume(session.id)
            return { outcomes, e1PreCount: pre.length }
          }),
        ),
    })

    const byId = Object.fromEntries(result.outcomes.map((o) => [o.actorID, o]))
    expect(result.e1PreCount).toBeGreaterThan(0)
    expect(byId["explore-2"]?.status).toBe("skipped")
    expect(byId["explore-2"]?.reason).toBe("no-recovery-candidate")
    // running is never auto-takeover (ownership stays with claimed row)
    expect(byId["explore-orphan-run"]?.status).toBe("skipped")
    expect(byId["explore-orphan-run"]?.reason).toBe("live")
    expect(byId["explore-1"]).toBeDefined()
    expect(["resumed", "failed"]).toContain(byId["explore-1"]?.status)
    expect(byId["main"]).toBeUndefined()
  })

  // [TP-RUN-R12-33] Stop after acceptance invalidates remaining cascade (C02).
  test("cascade with pre-stop epoch is cancelled", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const reg = yield* ActorRegistry.Service
            const session = yield* sessions.create({ title: "cascade cancel epoch" })
            yield* reg.register({
              sessionID: session.id,
              actorID: "explore-1",
              mode: "subagent",
              agent: "explore",
              description: "zombie",
              contextMode: "none",
              background: true,
              lifecycle: "ephemeral",
            })
            yield* reg.updateStatus(session.id, "explore-1", { status: "idle", lastOutcome: "failure" })
            const u = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user" as const,
              sessionID: session.id,
              agentID: "explore-1",
              agent: "explore",
              model: modelRef,
              time: { created: Date.now() },
            })
            yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "assistant" as const,
              parentID: u.id,
              sessionID: session.id,
              agentID: "explore-1",
              mode: "explore",
              agent: "explore",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: modelRef.modelID,
              providerID: modelRef.providerID,
              time: { created: Date.now() },
            })
            // Epoch 0 is the pre-cancel acceptance token.
            yield* prompt.cancel(session.id)
            const outcomes = yield* prompt.cascadeSubagentResume(session.id, 0)
            return { outcomes }
          }),
        ),
    })
    expect(result.outcomes.every((o) => o.reason === "cascade-cancelled" || o.actorID === undefined)).toBe(true)
    expect(result.outcomes.find((o) => o.actorID === "explore-1")?.reason).toBe("cascade-cancelled")
  })
})
