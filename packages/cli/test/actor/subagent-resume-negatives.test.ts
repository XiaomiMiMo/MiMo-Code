import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Deferred, Fiber } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { ActorRegistry } from "../../src/actor/registry"
import { Inbox } from "../../src/inbox"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"
import { parseActorNotification } from "../../src/inbox/render"

void Log.init({ print: false })
afterEach(async () => {
  await Instance.disposeAll()
})

const modelRef = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }

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

function incompleteAsst(input: {
  sessionID: SessionID
  parentID: MessageID
  agentID?: string
  agent: string
  cwd: string
  mode?: string
}) {
  return {
    id: MessageID.ascending(),
    role: "assistant" as const,
    parentID: input.parentID,
    sessionID: input.sessionID,
    ...(input.agentID !== undefined ? { agentID: input.agentID } : {}),
    mode: input.mode ?? "build",
    agent: input.agent,
    path: { cwd: input.cwd, root: input.cwd },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: modelRef.modelID,
    providerID: modelRef.providerID,
    time: { created: Date.now() },
  }
}

// [TP-RUN-R12-32] [TP-RUN-R12-33] [TP-RUN-R12-34] negative + multi-child coverage.
describe("subagent resume recovery negatives", () => {
  test("two idle children each deliver after POST resume", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = startScriptedLLMServer([
      // Last entry repeats for every subsequent request (main + both children).
      { lines: textStopResponse("RESUME-OK") },
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
              const inbox = yield* Inbox.Service
              const session = yield* sessions.create({ title: "multi child resume" })
              const mainUser = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agent: "build",
                model: modelRef,
                time: { created: Date.now() },
              })
              const mainAsst = yield* sessions.updateMessage(
                incompleteAsst({ sessionID: session.id, parentID: mainUser.id, agent: "build", cwd: tmp.path }),
              )
              const seedChild = (actorID: string, deliver: string) =>
                Effect.gen(function* () {
                  yield* reg.register({
                    sessionID: session.id,
                    actorID,
                    mode: "subagent",
                    agent: "custom",
                    description: actorID,
                    contextMode: "none",
                    background: true,
                    lifecycle: "ephemeral",
                  })
                  yield* reg.updateStatus(session.id, actorID, { status: "idle", lastOutcome: "failure" })
                  const u = yield* sessions.updateMessage({
                    id: MessageID.ascending(),
                    role: "user" as const,
                    sessionID: session.id,
                    agentID: actorID,
                    agent: "custom",
                    model: modelRef,
                    time: { created: Date.now() },
                  })
                  const a = yield* sessions.updateMessage(
                    incompleteAsst({
                      sessionID: session.id,
                      parentID: u.id,
                      agentID: actorID,
                      agent: "custom",
                      cwd: tmp.path,
                    }),
                  )
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: a.id,
                    sessionID: session.id,
                    type: "text" as const,
                    text: deliver,
                  })
                })
              yield* seedChild("custom-a", "seed-a")
              yield* seedChild("custom-b", "seed-b")

              const app = Server.Default().app
              const q = `?directory=${encodeURIComponent(tmp.path)}`
              const res = yield* Effect.promise(() =>
                Promise.resolve(
                  app.request(`/session/${session.id}/turn/${mainAsst.id}/resume${q}`, {
                    method: "POST",
                  }),
                ),
              )
              expect(res.status).toBe(202)

              const hasText = (agentID: string, needle: string) =>
                Effect.gen(function* () {
                  for (let i = 0; i < 80; i++) {
                    const msgs = yield* sessions.messages({ sessionID: session.id, agentID })
                    if (msgs.some((m) => m.parts.some((p) => p.type === "text" && (p.text ?? "").includes(needle)))) {
                      return true
                    }
                    yield* Effect.sleep("100 millis")
                  }
                  return false
                })
              const aOk = yield* hasText("custom-a", "RESUME-OK")
              const bOk = yield* hasText("custom-b", "RESUME-OK")
              let aOutcome = ""
              let bOutcome = ""
              let aResultId = ""
              let bResultId = ""
              for (let i = 0; i < 50; i++) {
                const aRow = yield* reg.get(session.id, "custom-a")
                const bRow = yield* reg.get(session.id, "custom-b")
                aOutcome = aRow?.lastOutcome ?? ""
                bOutcome = bRow?.lastOutcome ?? ""
                aResultId = aRow?.resultMessageID ?? ""
                bResultId = bRow?.resultMessageID ?? ""
                if (aOutcome === "success" && bOutcome === "success" && aResultId && bResultId) break
                yield* Effect.sleep("50 millis")
              }
              // Drain parent inbox repeatedly until both notifications land.
              let notifA = false
              let notifB = false
              for (let i = 0; i < 20 && !(notifA && notifB); i++) {
                yield* inbox.drain(session.id, "main").pipe(Effect.catch(() => Effect.succeed(0)))
                const mainMsgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
                notifA = mainMsgs.some((m) =>
                  m.parts.some((p) => p.type === "text" && (p.text ?? "").includes("custom-a")),
                )
                notifB = mainMsgs.some((m) =>
                  m.parts.some((p) => p.type === "text" && (p.text ?? "").includes("custom-b")),
                )
                if (!(notifA && notifB)) yield* Effect.sleep("50 millis")
              }
              // Result pointer → message ownership + persisted actorResult
              const aMsg = yield* sessions
                .messages({ sessionID: session.id, agentID: "custom-a" })
                .pipe(Effect.map((msgs) => msgs.find((m) => m.info.id === aResultId)))
              const bMsg = yield* sessions
                .messages({ sessionID: session.id, agentID: "custom-b" })
                .pipe(Effect.map((msgs) => msgs.find((m) => m.info.id === bResultId)))
              const aFinal = aMsg?.info.role === "assistant" ? aMsg.info.actorResult?.finalText : undefined
              const bFinal = bMsg?.info.role === "assistant" ? bMsg.info.actorResult?.finalText : undefined
              // Parse parent notifications as completed with Result.
              yield* inbox.drain(session.id, "main").pipe(Effect.catch(() => Effect.succeed(0)))
              const mainForParse = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const parsed = mainForParse.flatMap((m) =>
                m.parts.flatMap((p) => {
                  if (p.type !== "text") return []
                  const parsedN = parseActorNotification(p.text ?? "")
                  return parsedN ? [parsedN] : []
                }),
              )
              const notifAOk = parsed.some(
                (n) => n.description === "custom-a" && n.status === "completed" && (n.summary ?? "").includes("RESUME-OK"),
              )
              const notifBOk = parsed.some(
                (n) => n.description === "custom-b" && n.status === "completed" && (n.summary ?? "").includes("RESUME-OK"),
              )
              return {
                aOk,
                bOk,
                aOutcome,
                bOutcome,
                aResultId,
                bResultId,
                notifA,
                notifB,
                aOwned: aMsg?.info.agentID === "custom-a",
                bOwned: bMsg?.info.agentID === "custom-b",
                aFinal,
                bFinal,
                notifAOk,
                notifBOk,
              }
            }).pipe(Effect.provide(Inbox.defaultLayer)),
          ),
      })
      expect(result.aOk).toBe(true)
      expect(result.bOk).toBe(true)
      expect(result.aOutcome).toBe("success")
      expect(result.bOutcome).toBe("success")
      expect(result.aResultId.length).toBeGreaterThan(0)
      expect(result.bResultId.length).toBeGreaterThan(0)
      expect(result.aResultId).not.toBe(result.bResultId)
      expect(result.aOwned).toBe(true)
      expect(result.bOwned).toBe(true)
      expect(result.notifA).toBe(true)
      expect(result.notifB).toBe(true)
      expect(result.aFinal).toContain("RESUME-OK")
      expect(result.bFinal).toContain("RESUME-OK")
      expect(result.notifAOk).toBe(true)
      expect(result.notifBOk).toBe(true)
    } finally {
      await server.stop()
    }
  }, 120_000)

  // [TP-RUN-R12-34] C07: full missing ForkContext via send stays failure this run.
  test("send follow-up on full actor without fork context fails honestly", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = startScriptedLLMServer([{ lines: textStopResponse("UNUSED") }])
    try {
      await seedProject(tmp.path, server.origin)
      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const reg = yield* ActorRegistry.Service
              const inbox = yield* Inbox.Service
              const session = yield* sessions.create({ title: "missing fork send" })
              // Main slice needs a model-bearing message so inbox.drain can seed
              // the parent notification into a user turn (same as production).
              const mainUser = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agent: "build",
                model: modelRef,
                time: { created: Date.now() },
              })
              yield* sessions.updateMessage(
                incompleteAsst({ sessionID: session.id, parentID: mainUser.id, agent: "build", cwd: tmp.path }),
              )
              yield* reg.register({
                sessionID: session.id,
                actorID: "custom-full",
                mode: "subagent",
                agent: "custom",
                description: "full no fork",
                contextMode: "full",
                background: true,
                lifecycle: "ephemeral",
              })
              yield* reg.updateStatus(session.id, "custom-full", { status: "idle", lastOutcome: "failure" })
              const fu = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agentID: "custom-full",
                agent: "custom",
                model: modelRef,
                time: { created: Date.now() },
              })
              const fa = yield* sessions.updateMessage(
                incompleteAsst({
                  sessionID: session.id,
                  parentID: fu.id,
                  agentID: "custom-full",
                  agent: "custom",
                  cwd: tmp.path,
                }),
              )
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: fa.id,
                sessionID: session.id,
                type: "text" as const,
                text: "full-seed",
              })
              // Durable follow-up, then join the same wake path production uses
              // (loop + inboxWake). Forked inbox.wake timing is not CI-stable.
              yield* inbox.send({
                receiverSessionID: session.id,
                receiverActorID: "custom-full",
                senderSessionID: session.id,
                senderActorID: "main",
                content: "follow-up",
                wake: false,
              })
              yield* prompt
                .loop({
                  sessionID: session.id,
                  agentID: "custom-full",
                  notifyParentOnComplete: true,
                  inboxWake: true,
                })
                .pipe(
                  Effect.timeout("20 seconds"),
                  Effect.catchCause(() => Effect.void),
                )
              const inboxSvc = yield* Inbox.Service
              let notifyFailed = false
              let fakeCompleted = false
              let fullErr = ""
              let fullOutcome = ""
              for (let i = 0; i < 80; i++) {
                yield* inboxSvc.drain(session.id, "main").pipe(Effect.catch(() => Effect.succeed(0)))
                const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
                const parsed = msgs.flatMap((m) =>
                  m.parts.flatMap((p) => {
                    if (p.type !== "text") return []
                    const n = parseActorNotification(p.text ?? "")
                    return n ? [n] : []
                  }),
                )
                notifyFailed = parsed.some((n) => n.description === "full no fork" && n.status === "failed")
                fakeCompleted = parsed.some((n) => n.description === "full no fork" && n.status === "completed")
                const row = yield* reg.get(session.id, "custom-full")
                fullOutcome = row?.lastOutcome ?? ""
                fullErr = row?.lastError ?? ""
                if (notifyFailed && fullOutcome === "failure" && fullErr.includes("missing fork")) break
                yield* Effect.sleep("50 millis")
              }
              return {
                notifyFailed,
                fakeCompleted,
                fullOutcome,
                fullErr,
                providerCalls: server.captures.length,
              }
            }).pipe(Effect.provide(Inbox.defaultLayer)),
          ),
      })
      expect(result.fullOutcome).toBe("failure")
      expect(result.fullErr).toContain("missing fork")
      expect(result.notifyFailed).toBe(true)
      expect(result.fakeCompleted).toBe(false)
      expect(result.providerCalls).toBe(0)
    } finally {
      await server.stop()
    }
  }, 90_000)

  // [TP-RUN-R12-33] C02: Stop between main acceptance and cascade uses the acceptance epoch.
  // [TP-SR-R21-10] assistant/cascade 202=异步受理；Stop 后 main 已受理不再派发 child（互不清扫/不重复启动）。
  test("stop after main start barrier prevents child resume", async () => {
    await using tmp = await tmpdir({ git: true })
    const accepted = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const server = startScriptedLLMServer([
      {
        lines: textStopResponse("MAIN-HUNG"),
        beforeReply: () => Effect.runPromise(Deferred.await(release)),
      },
      { lines: textStopResponse("CHILD-MUST-NOT") },
    ])
    try {
      await seedProject(tmp.path, server.origin)
      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const reg = yield* ActorRegistry.Service
              const runState = yield* SessionRunState.Service
              const session = yield* sessions.create({ title: "accept barrier" })
              const mainUser = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agent: "build",
                model: modelRef,
                time: { created: Date.now() },
              })
              const mainAsst = yield* sessions.updateMessage(
                incompleteAsst({ sessionID: session.id, parentID: mainUser.id, agent: "build", cwd: tmp.path }),
              )
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
              yield* reg.updateStatus(session.id, "custom-1", { status: "idle", lastOutcome: "failure" })
              const u = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agentID: "custom-1",
                agent: "custom",
                model: modelRef,
                time: { created: Date.now() },
              })
              yield* sessions.updateMessage(
                incompleteAsst({
                  sessionID: session.id,
                  parentID: u.id,
                  agentID: "custom-1",
                  agent: "custom",
                  cwd: tmp.path,
                }),
              )

              // Patch start for main only: real start, then hold until release.
              const origStart = runState.start
              const childTurnsBefore = (yield* reg.get(session.id, "custom-1"))?.turnCount ?? 0
              const childAsstBefore = (yield* sessions.messages({ sessionID: session.id, agentID: "custom-1" })).filter(
                (m) => m.info.role === "assistant",
              ).length
              const patched = Object.assign(
                (sid: SessionID, aid: string, oi: never, work: never) =>
                  origStart(sid, aid, oi, work).pipe(
                    Effect.tap(() =>
                      aid === "main" && sid === session.id
                        ? Effect.promise(async () => {
                            await Effect.runPromise(Deferred.succeed(accepted, undefined))
                            await Effect.runPromise(Deferred.await(release))
                          })
                        : Effect.void,
                    ),
                  ),
                origStart,
              )
              ;(runState as { start: typeof origStart }).start = patched

              const fiber = yield* prompt
                .resumeMainCascading({
                  sessionID: session.id,
                  assistantMessageID: mainAsst.id,
                  agentID: "main",
                })
                .pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.forkChild,
                )

              try {
                yield* Effect.promise(() => Effect.runPromise(Deferred.await(accepted)))
                yield* prompt.cancel(session.id)
                yield* Effect.promise(async () => {
                  await Effect.runPromise(Deferred.succeed(release, undefined))
                })
                // Join must converge — timeout is a test failure, not success.
                yield* Fiber.join(fiber).pipe(
                  Effect.timeout("8 seconds"),
                  Effect.catch(() => Effect.die(new Error("resumeMainCascading fiber did not converge"))),
                )
                yield* Effect.sleep("100 millis")
              } finally {
                ;(runState as { start: typeof origStart }).start = origStart
              }

              const childMsgs = yield* sessions.messages({ sessionID: session.id, agentID: "custom-1" })
              const delivered = childMsgs.some((m) =>
                m.parts.some((p) => p.type === "text" && (p.text ?? "").includes("CHILD-MUST-NOT")),
              )
              const childAsstAfter = childMsgs.filter((m) => m.info.role === "assistant").length
              const childTurnsAfter = (yield* reg.get(session.id, "custom-1"))?.turnCount ?? 0
              return {
                delivered,
                childAsstAfter,
                childAsstBefore,
                childTurnsAfter,
                childTurnsBefore,
                providerCalls: server.captures.length,
              }
            }),
          ),
      })
      expect(result.delivered).toBe(false)
      expect(result.childAsstAfter).toBe(result.childAsstBefore)
      expect(result.childTurnsAfter).toBe(result.childTurnsBefore)
      // providerCalls may be 0 if main resume failed before HTTP; child must not run.
    } finally {
      await server.stop()
    }
  }, 90_000)

  // [TP-RUN-R12-33] C08: admission timeout returns not-admitted and does not run later.
  test("cascade admission timeout interrupts pending resume", async () => {
    await using tmp = await tmpdir({ git: true })
    const block = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const server = startScriptedLLMServer([{ lines: textStopResponse("LATE-MUST-NOT") }])
    try {
      await seedProject(tmp.path, server.origin)
      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const reg = yield* ActorRegistry.Service
              const runState = yield* SessionRunState.Service
              const session = yield* sessions.create({ title: "admit timeout" })
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
              yield* reg.updateStatus(session.id, "custom-1", { status: "idle", lastOutcome: "failure" })
              const u = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agentID: "custom-1",
                agent: "custom",
                model: modelRef,
                time: { created: Date.now() },
              })
              yield* sessions.updateMessage(
                incompleteAsst({
                  sessionID: session.id,
                  parentID: u.id,
                  agentID: "custom-1",
                  agent: "custom",
                  cwd: tmp.path,
                }),
              )

              const origAssert = runState.assertNotBusy
              let childAssertCalls = 0
              const patchedAssert = Object.assign(
                (sid: SessionID, aid?: string) =>
                  origAssert(sid, aid).pipe(
                    Effect.andThen(() => {
                      if (sid !== session.id || aid !== "custom-1") return Effect.void
                      childAssertCalls++
                      // 1st call = cascade outer eligibility; 2nd = planResume admission.
                      if (childAssertCalls < 2) return Effect.void
                      return Effect.promise(async () => {
                        await Effect.runPromise(Deferred.succeed(block, undefined))
                        await Effect.runPromise(Deferred.await(release))
                      })
                    }),
                  ),
                origAssert,
              )
              ;(runState as { assertNotBusy: typeof origAssert }).assertNotBusy = patchedAssert

              try {
                const cascadeFiber = yield* prompt
                  .cascadeSubagentResume(session.id)
                  .pipe(
                    Effect.catchCause(() => Effect.succeed([] as { actorID: string; status: string; reason?: string }[])),
                    Effect.forkChild,
                  )
                // Wait until admission barrier is hit (planResume).
                let hit = false
                for (let i = 0; i < 80 && !hit; i++) {
                  hit = yield* Deferred.isDone(block)
                  if (!hit) yield* Effect.sleep("50 millis")
                }
                expect(hit).toBe(true)
                // Release after production 8s admission timeout has a chance to fire.
                // Don't convert a cascade hang into empty success.
                const outcomes = yield* Fiber.join(cascadeFiber).pipe(
                  Effect.timeout("15 seconds"),
                  Effect.catch(() =>
                    Effect.die(new Error("cascade did not return not-admitted after admission block")),
                  ),
                )
                yield* Effect.promise(async () => {
                  await Effect.runPromise(Deferred.succeed(release, undefined))
                })
                yield* Effect.sleep("300 millis")
                const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "custom-1" })
                const delivered = msgs.some((m) =>
                  m.parts.some((p) => p.type === "text" && (p.text ?? "").includes("LATE-MUST-NOT")),
                )
                const asstCount = msgs.filter((m) => m.info.role === "assistant").length
                return { outcomes, delivered, asstCount, providerCalls: server.captures.length, hit }
              } finally {
                ;(runState as { assertNotBusy: typeof origAssert }).assertNotBusy = origAssert
              }
            }),
          ),
      })
      const entry = result.outcomes.find((o) => o.actorID === "custom-1")
      expect(result.hit).toBe(true)
      expect(entry?.status).toBe("failed")
      expect(entry?.reason).toBe("not-admitted")
      expect(result.delivered).toBe(false)
      expect(result.providerCalls).toBe(0)
    } finally {
      await server.stop()
    }
  }, 90_000)

  // [TP-RUN-R12-34] C07 via cascade resume: same missing-fork failure.
  test("cascade resume on full actor without fork context fails honestly", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = startScriptedLLMServer([{ lines: textStopResponse("UNUSED") }])
    try {
      await seedProject(tmp.path, server.origin)
      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const reg = yield* ActorRegistry.Service
              const session = yield* sessions.create({ title: "missing fork resume" })
              // Main slice needs a model-bearing message so inbox.drain can seed
              // the parent notification into a user turn (same as production).
              const mainUser = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agent: "build",
                model: modelRef,
                time: { created: Date.now() },
              })
              yield* sessions.updateMessage(
                incompleteAsst({ sessionID: session.id, parentID: mainUser.id, agent: "build", cwd: tmp.path }),
              )
              yield* reg.register({
                sessionID: session.id,
                actorID: "custom-full",
                mode: "subagent",
                agent: "custom",
                description: "full no fork",
                contextMode: "full",
                background: true,
                lifecycle: "ephemeral",
              })
              yield* reg.updateStatus(session.id, "custom-full", { status: "idle", lastOutcome: "failure" })
              const fu = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user" as const,
                sessionID: session.id,
                agentID: "custom-full",
                agent: "custom",
                model: modelRef,
                time: { created: Date.now() },
              })
              const fa = yield* sessions.updateMessage(
                incompleteAsst({
                  sessionID: session.id,
                  parentID: fu.id,
                  agentID: "custom-full",
                  agent: "custom",
                  cwd: tmp.path,
                }),
              )
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: fa.id,
                sessionID: session.id,
                type: "text" as const,
                text: "full-seed",
              })
              // Cascade only waits for admission; the missing-fork failure +
              // terminal notify settle on the background fiber afterwards.
              const outcomes = yield* prompt.cascadeSubagentResume(session.id).pipe(
                Effect.catchCause(() => Effect.succeed([] as { actorID: string; status: string; reason?: string }[])),
              )
              const inboxSvc = yield* Inbox.Service
              let notifyFailed = false
              let fakeCompleted = false
              let fullFail = false
              let fullErr = ""
              for (let i = 0; i < 120; i++) {
                yield* inboxSvc.drain(session.id, "main").pipe(Effect.catch(() => Effect.succeed(0)))
                const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
                const parsed = msgs.flatMap((m) =>
                  m.parts.flatMap((p) => {
                    if (p.type !== "text") return []
                    const n = parseActorNotification(p.text ?? "")
                    return n ? [n] : []
                  }),
                )
                notifyFailed = parsed.some((n) => n.description === "full no fork" && n.status === "failed")
                fakeCompleted = parsed.some((n) => n.description === "full no fork" && n.status === "completed")
                const row = yield* reg.get(session.id, "custom-full")
                fullFail = row?.status === "idle" && row.lastOutcome === "failure"
                fullErr = row?.lastError ?? ""
                if (notifyFailed && fullFail && fullErr.includes("missing fork")) break
                yield* Effect.sleep("50 millis")
              }
              return {
                outcomes,
                notifyFailed,
                fakeCompleted,
                fullFail,
                fullErr,
                providerCalls: server.captures.length,
              }
            }).pipe(Effect.provide(Inbox.defaultLayer)),
          ),
      })
      const cascadeEntry = result.outcomes.find((o) => o.actorID === "custom-full")
      expect(cascadeEntry?.status).toBe("resumed")
      expect(result.notifyFailed).toBe(true)
      expect(result.fakeCompleted).toBe(false)
      expect(result.fullFail).toBe(true)
      expect(result.fullErr).toContain("missing fork")
      expect(result.providerCalls).toBe(0)
    } finally {
      await server.stop()
    }
  }, 90_000)
})
