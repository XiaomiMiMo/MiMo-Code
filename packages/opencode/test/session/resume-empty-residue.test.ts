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
            const shell1 = yield* sessions.updateMessage({
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
            const shell2 = yield* sessions.updateMessage({
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
            yield* prompt
              .resumeBackground({
                sessionID: session.id,
                assistantMessageID: shell2.id,
                agentID: "main",
              })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("200 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            return {
              parents: before.map((c) => c.parentMessageID),
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
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0]?.parentMessageID).toBeDefined()
  })

  // F1: mixed useful incomplete + empty tail → empties cleaned, useful kept; no parent re-dispatch stamp
  test("mixed useful incomplete + empty tail cleans empties and keeps useful residue", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "mixed residue" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              time: { created: Date.now() },
            })
            const useful = yield* sessions.updateMessage({
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
            const empty = yield* sessions.updateMessage({
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
              time: { created: Date.now() + 2 },
            })
            yield* prompt
              .resumeBackground({
                sessionID: session.id,
                assistantMessageID: empty.id,
                agentID: "main",
              })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("200 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            const usefulMsg = after.find((m) => m.info.id === useful.id)
            const usefulInfo = usefulMsg?.info
            const abandonStamp =
              usefulInfo && usefulInfo.role === "assistant" && usefulInfo.error
                ? ((usefulInfo.error as { data?: { message?: string }; message?: string }).data?.message ??
                  (usefulInfo.error as { message?: string }).message ??
                  "")
                : ""
            return {
              emptyGone: after.find((m) => m.info.id === empty.id) === undefined,
              usefulKept: usefulMsg !== undefined,
              usefulStillHasToolParts: usefulMsg?.parts.some((part) => part.type === "tool") ?? false,
              // path A: useful sibling is abandoned-as-resumed; path B would leave it unstamped
              // and re-dispatch parent user (user count would stay 1 but no abandon stamp).
              usefulAbandonedAsResumed: abandonStamp.includes("Abandoned: resumed as a new assistant turn"),
              users: after.filter((m) => m.info.role === "user").length,
              emptySiblingCount: after.filter(
                (m) =>
                  m.info.role === "assistant" &&
                  m.info.parentID === user.id &&
                  !m.parts.some(
                    (part) =>
                      (part.type === "text" && part.text.trim().length > 0) ||
                      part.type === "tool" ||
                      (part.type === "reasoning" && part.text.trim().length > 0),
                  ),
              ).length,
            }
          }),
        ),
    })
    expect(result.emptyGone).toBe(true)
    expect(result.usefulKept).toBe(true)
    expect(result.usefulStillHasToolParts).toBe(true)
    // Mixed residue must take path A on the useful incomplete, not path B parent re-dispatch.
    expect(result.usefulAbandonedAsResumed).toBe(true)
    expect(result.users).toBe(1)
  })

  // completed useful + empty tail → cleanup-only (no parent re-dispatch, no Failure orphan)
  test("empty tail after completed useful assistant cleans shells without parent re-dispatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "completed+empty" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
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
              modelID: ModelID.make("test-model"),
              providerID: ProviderID.make("test"),
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
            const empty = yield* sessions.updateMessage({
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
              time: { created: Date.now() + 3 },
            })
            const exit = yield* prompt
              .resumeBackground({
                sessionID: session.id,
                assistantMessageID: empty.id,
                agentID: "main",
              })
              .pipe(Effect.exit)
            yield* Effect.sleep("100 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            return {
              succeeded: exit._tag === "Success",
              emptyGone: after.find((m) => m.info.id === empty.id) === undefined,
              completedKept: after.some((m) => m.info.id === completed.id),
              users: after.filter((m) => m.info.role === "user").length,
            }
          }),
        ),
    })
    expect(result.succeeded).toBe(true)
    expect(result.emptyGone).toBe(true)
    expect(result.completedKept).toBe(true)
    expect(result.users).toBe(1)
  })

  // Review#2: non-tail useful incomplete + completed middle + empty tail → cleanup-only, no false path-A abandon
  test("non-tail useful incomplete is not retargeted when completed sits after it", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "non-tail useful + completed + empty" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              time: { created: Date.now() },
            })
            const usefulOld = yield* sessions.updateMessage({
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
              modelID: ModelID.make("test-model"),
              providerID: ProviderID.make("test"),
              time: { created: Date.now() + 1, completed: Date.now() + 1 },
              finish: "stop",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: completed.id,
              sessionID: session.id,
              type: "text",
              text: "later answer",
            })
            const empty = yield* sessions.updateMessage({
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
              time: { created: Date.now() + 2 },
            })
            yield* prompt
              .resumeBackground({
                sessionID: session.id,
                assistantMessageID: empty.id,
                agentID: "main",
              })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("150 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            const usefulInfo = after.find((m) => m.info.id === usefulOld.id)?.info
            const abandonMsg =
              usefulInfo && usefulInfo.role === "assistant" && usefulInfo.error
                ? ((usefulInfo.error as { data?: { message?: string }; message?: string }).data?.message ??
                  (usefulInfo.error as { message?: string }).message ??
                  "")
                : ""
            return {
              emptyGone: after.find((m) => m.info.id === empty.id) === undefined,
              completedKept: after.some((m) => m.info.id === completed.id),
              usefulNotAbandonedAsResumeTarget: !abandonMsg.includes("Abandoned: resumed as a new assistant turn"),
              users: after.filter((m) => m.info.role === "user").length,
            }
          }),
        ),
    })
    expect(result.emptyGone).toBe(true)
    expect(result.completedKept).toBe(true)
    expect(result.usefulNotAbandonedAsResumeTarget).toBe(true)
    expect(result.users).toBe(1)
  })

  // F2: live empty shell under busy runner must not be deleted
  test("live empty shell is not deleted while session is busy", async () => {
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
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              time: { created: Date.now() },
            })
            const shell = yield* sessions.updateMessage({
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
            const hang = Effect.sleep("30 seconds") as Effect.Effect<never>
            yield* run.start(
              session.id,
              "main",
              Effect.die("interrupt") as never,
              hang as never,
            )
            const busyExit = yield* run.assertNotBusy(session.id, "main").pipe(Effect.exit)
            yield* prompt
              .resumeBackground({
                sessionID: session.id,
                assistantMessageID: shell.id,
                agentID: "main",
              })
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

  // F6: target vanishes after recovery listing → NotFound, not dangling path A
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
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              time: { created: Date.now() },
            })
            const shell = yield* sessions.updateMessage({
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
            const before = yield* prompt.recovery({ sessionID: session.id, agentID: "main", allowBusy: true })
            expect(before.some((c) => c.assistantMessageID === shell.id)).toBe(true)
            yield* sessions.removeMessage({ sessionID: session.id, messageID: shell.id })
            const exit = yield* prompt
              .resumeBackground({
                sessionID: session.id,
                assistantMessageID: shell.id,
                agentID: "main",
              })
              .pipe(Effect.exit)
            return { failed: exit._tag === "Failure" }
          }),
        ),
    })
    expect(result.failed).toBe(true)
  })

  // Predicate lock: file/patch-only assistant is empty residue (D16e: tool/text/reasoning only)
  test("assistant with only file/patch parts is empty residue and gets cleaned", async () => {
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
            })
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
              .resumeBackground({
                sessionID: session.id,
                assistantMessageID: assistant.id,
                agentID: "main",
              })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("150 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            return {
              listed: candidates.some((c) => c.assistantMessageID === assistant.id),
              shellGone: after.find((m) => m.info.id === assistant.id) === undefined,
            }
          }),
        ),
    })
    expect(result.listed).toBe(true)
    expect(result.shellGone).toBe(true)
  })

  // ⚠️ round2: useful-tail resume must still clean empty siblings under the same parent
  test("useful tail resume cleans empty siblings under the same parent", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "useful tail + empty sibling" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              time: { created: Date.now() },
            })
            const emptySibling = yield* sessions.updateMessage({
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
            const usefulTail = yield* sessions.updateMessage({
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
              time: { created: Date.now() + 2 },
              finish: "tool-calls",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: usefulTail.id,
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
              .resumeBackground({
                sessionID: session.id,
                assistantMessageID: usefulTail.id,
                agentID: "main",
              })
              .pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep("200 millis")
            const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            return {
              emptySiblingGone: after.find((m) => m.info.id === emptySibling.id) === undefined,
              usefulKept: after.some((m) => m.info.id === usefulTail.id),
            }
          }),
        ),
    })
    expect(result.emptySiblingGone).toBe(true)
    expect(result.usefulKept).toBe(true)
  })
})
