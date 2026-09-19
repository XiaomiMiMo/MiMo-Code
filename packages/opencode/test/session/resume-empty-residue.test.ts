import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { PartID, MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const modelRef = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

function shellMessage(input: { sessionID: string; parentID: string; created: number; cwd: string; finish?: string }) {
  return {
    id: MessageID.ascending(),
    role: "assistant" as const,
    parentID: input.parentID,
    sessionID: input.sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: input.cwd, root: input.cwd },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: modelRef.modelID,
    providerID: modelRef.providerID,
    time: { created: input.created },
    ...(input.finish ? { finish: input.finish as "tool-calls" } : {}),
  }
}

// [TP-SR-R21-16] Resume has only tool-resume (useful parts) / user-resume (no parts; re-run from parent user).
describe("resume empty residue", () => {
  test("user-resume cleans empty shells without Abandoned-as-resumed", async () => {
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
              model: modelRef,
              time: { created: Date.now() },
            })
            const shell1 = yield* sessions.updateMessage(
              shellMessage({ sessionID: session.id, parentID: user.id, created: Date.now(), cwd: tmp.path }) as Parameters<typeof sessions.updateMessage>[0],
            )
            const shell2 = yield* sessions.updateMessage(
              shellMessage({ sessionID: session.id, parentID: user.id, created: Date.now() + 1, cwd: tmp.path }) as Parameters<typeof sessions.updateMessage>[0],
            )
            const before = yield* prompt.recovery({ sessionID: session.id, agentID: "main", allowBusy: true })
            yield* prompt
              .resumeBackground({ sessionID: session.id, assistantMessageID: shell2.id, agentID: "main" })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("200 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            return {
              parents: before.flatMap((c) => (c.kind === "assistant" ? [c.parentMessageID] : [])),
              userParent: user.id,
              shell1Gone: after.find((m) => m.info.id === shell1.id) === undefined,
              shell2Gone: after.find((m) => m.info.id === shell2.id) === undefined,
              anyAbandonedAsResumed: after.some((m) => {
                if (m.info.role !== "assistant" || !m.info.error) return false
                const err = m.info.error as { data?: { message?: string }; message?: string }
                const msg = err?.data?.message ?? err?.message ?? ""
                return msg.includes("Abandoned: resumed as a new assistant turn")
              }),
              candidateCount: before.length,
            }
          }),
        ),
    })
    expect(result.candidateCount).toBeGreaterThan(0)
    expect(result.parents.every((p) => p === result.userParent)).toBe(true)
    // [TP-SR-R21-16]
    expect(result.shell1Gone).toBe(true)
    expect(result.shell2Gone).toBe(true)
    expect(result.anyAbandonedAsResumed).toBe(false)
  })

  test("assistant with tool parts remains a recovery candidate", async () => {
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
              model: modelRef,
              time: { created: Date.now() },
            })
            const assistant = yield* sessions.updateMessage(
              shellMessage({
                sessionID: session.id,
                parentID: user.id,
                created: Date.now(),
                cwd: tmp.path,
                finish: "tool-calls",
              }) as Parameters<typeof sessions.updateMessage>[0],
            )
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
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0]?.kind).toBe("assistant")
    // [C004] Keep parent identity — kind alone is not an equivalent assertion.
    expect(result.candidates[0]).toMatchObject({
      kind: "assistant",
      assistantMessageID: expect.any(String),
      parentMessageID: expect.any(String),
    })
  })

  test("tool-resume on useful target cleans empty siblings and keeps useful", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "tool resume + empty sibling" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: modelRef,
              time: { created: Date.now() },
            })
            const empty = yield* sessions.updateMessage(
              shellMessage({ sessionID: session.id, parentID: user.id, created: Date.now(), cwd: tmp.path }) as Parameters<typeof sessions.updateMessage>[0],
            )
            const useful = yield* sessions.updateMessage(
              shellMessage({
                sessionID: session.id,
                parentID: user.id,
                created: Date.now() + 2,
                cwd: tmp.path,
                finish: "tool-calls",
              }) as Parameters<typeof sessions.updateMessage>[0],
            )
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: useful.id,
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
            yield* prompt
              .resumeBackground({ sessionID: session.id, assistantMessageID: useful.id, agentID: "main" })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("200 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            return {
              emptyGone: after.find((m) => m.info.id === empty.id) === undefined,
              usefulKept: after.some((m) => m.info.id === useful.id),
            }
          }),
        ),
    })
    expect(result.emptyGone).toBe(true)
    expect(result.usefulKept).toBe(true)
  })

  test("user-resume on empty tail does not retarget sibling useful as resumeFrom", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "user resume empty tail" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: modelRef,
              time: { created: Date.now() },
            })
            const usefulOld = yield* sessions.updateMessage(
              shellMessage({
                sessionID: session.id,
                parentID: user.id,
                created: Date.now(),
                cwd: tmp.path,
                finish: "tool-calls",
              }) as Parameters<typeof sessions.updateMessage>[0],
            )
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: usefulOld.id,
              sessionID: session.id,
              type: "tool",
              callID: "call_old",
              tool: "bash",
              state: {
                status: "running",
                input: { command: "ls" },
                title: "ls",
                metadata: {},
                time: { start: Date.now() },
              },
            })
            const empty = yield* sessions.updateMessage(
              shellMessage({ sessionID: session.id, parentID: user.id, created: Date.now() + 3, cwd: tmp.path }) as Parameters<typeof sessions.updateMessage>[0],
            )
            yield* prompt
              .resumeBackground({ sessionID: session.id, assistantMessageID: empty.id, agentID: "main" })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("200 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            const usefulInfo = after.find((m) => m.info.id === usefulOld.id)?.info
            const abandonMsg =
              usefulInfo && usefulInfo.role === "assistant" && usefulInfo.error
                ? ((usefulInfo.error as { data?: { message?: string }; message?: string }).data?.message ?? "")
                : ""
            return {
              emptyGone: after.find((m) => m.info.id === empty.id) === undefined,
              usefulNotResumeTarget: !abandonMsg.includes("Abandoned: resumed as a new assistant turn"),
              users: after.filter((m) => m.info.role === "user").length,
            }
          }),
        ),
    })
    expect(result.emptyGone).toBe(true)
    expect(result.usefulNotResumeTarget).toBe(true)
    expect(result.users).toBe(1)
  })

  // user-resume with a completed sibling + empty tail must still start a run (userRedispatch), not silent no-op
  test("user-resume with completed sibling still starts a run from parent user", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "completed sibling + empty tail" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: modelRef,
              time: { created: Date.now() },
            })
            const completed = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              parentID: user.id,
              sessionID: session.id,
              mode: "build",
              agent: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: modelRef.modelID,
              providerID: modelRef.providerID,
              time: { created: Date.now(), completed: Date.now() },
              finish: "stop",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: completed.id,
              sessionID: session.id,
              type: "text",
              text: "already answered",
            })
            const empty = yield* sessions.updateMessage(
              shellMessage({ sessionID: session.id, parentID: user.id, created: Date.now() + 3, cwd: tmp.path }) as Parameters<
                typeof sessions.updateMessage
              >[0],
            )
            const usersBefore = (yield* sessions.messages({ sessionID: session.id, agentID: "main" })).filter(
              (m) => m.info.role === "user",
            ).length
            yield* prompt
              .resumeBackground({ sessionID: session.id, assistantMessageID: empty.id, agentID: "main" })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("250 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            const assistantsAfter = after.filter((m) => m.info.role === "assistant")
            return {
              emptyGone: after.find((m) => m.info.id === empty.id) === undefined,
              completedKept: after.some((m) => m.info.id === completed.id),
              usersStable: after.filter((m) => m.info.role === "user").length === usersBefore,
              // Run started: a new assistant appeared, or the old completed one gained an error (failed runLoop)
              ranSomething:
                assistantsAfter.some((m) => m.info.id !== completed.id && m.info.id !== empty.id) ||
                assistantsAfter.some(
                  (m) => m.info.role === "assistant" && m.info.id === completed.id && Boolean(m.info.error),
                ),
            }
          }),
        ),
    })
    expect(result.emptyGone).toBe(true)
    expect(result.completedKept).toBe(true)
    expect(result.usersStable).toBe(true)
    expect(result.ranSomething).toBe(true)
  })

  test("busy rejects resume without deleting shells", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const run = yield* SessionRunState.Service
            const session = yield* sessions.create({ title: "live shell busy" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: modelRef,
              time: { created: Date.now() },
            })
            const shell = yield* sessions.updateMessage(
              shellMessage({ sessionID: session.id, parentID: user.id, created: Date.now(), cwd: tmp.path }) as Parameters<typeof sessions.updateMessage>[0],
            )
            const hang = Effect.sleep("30 seconds") as Effect.Effect<never>
            yield* run.start(session.id, "main", Effect.die("interrupt") as never, hang as never)
            const busyExit = yield* run.assertNotBusy(session.id, "main").pipe(Effect.exit)
            yield* prompt
              .resumeBackground({ sessionID: session.id, assistantMessageID: shell.id, agentID: "main" })
              .pipe(Effect.catch(() => Effect.void))
            const mid = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            const liveStillThere = mid.some((m) => m.info.id === shell.id)
            yield* run.cancel(session.id)
            yield* Effect.sleep("100 millis")
            return { busy: busyExit._tag === "Failure", liveStillThere }
          }),
        ),
    })
    expect(result.busy).toBe(true)
    expect(result.liveStillThere).toBe(true)
  })

  test("resume target disappearing after recovery yields Failure", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "vanished target" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: modelRef,
              time: { created: Date.now() },
            })
            const shell = yield* sessions.updateMessage(
              shellMessage({ sessionID: session.id, parentID: user.id, created: Date.now(), cwd: tmp.path }) as Parameters<typeof sessions.updateMessage>[0],
            )
            const before = yield* prompt.recovery({ sessionID: session.id, agentID: "main", allowBusy: true })
            expect(before.some((c) => c.kind === "assistant" && c.assistantMessageID === shell.id)).toBe(true)
            yield* sessions.removeMessage({ sessionID: session.id, messageID: shell.id })
            const exit = yield* prompt
              .resumeBackground({ sessionID: session.id, assistantMessageID: shell.id, agentID: "main" })
              .pipe(Effect.exit)
            return { failed: exit._tag === "Failure" }
          }),
        ),
    })
    expect(result.failed).toBe(true)
  })

  test("assistant with only file parts is user-resume and gets cleaned", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "file-only residue" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: modelRef,
              time: { created: Date.now() },
            })
            const assistant = yield* sessions.updateMessage(
              shellMessage({ sessionID: session.id, parentID: user.id, created: Date.now(), cwd: tmp.path }) as Parameters<typeof sessions.updateMessage>[0],
            )
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "file",
              mime: "text/plain",
              filename: "note.txt",
              url: "file:///tmp/note.txt",
            })
            const candidates = yield* prompt.recovery({ sessionID: session.id, agentID: "main", allowBusy: true })
            yield* prompt
              .resumeBackground({ sessionID: session.id, assistantMessageID: assistant.id, agentID: "main" })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("150 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            return {
              listed: candidates.some((c) => c.kind === "assistant" && c.assistantMessageID === assistant.id),
              shellGone: after.find((m) => m.info.id === assistant.id) === undefined,
            }
          }),
        ),
    })
    expect(result.listed).toBe(true)
    expect(result.shellGone).toBe(true)
  })
})
