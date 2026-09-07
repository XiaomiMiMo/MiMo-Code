import { afterEach, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Actor } from "../../src/actor/spawn"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorStatusChanged } from "../../src/actor/events"
import { Bus } from "../../src/bus"
import { TaskRegistry } from "../../src/task/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { Inbox } from "../../src/inbox"
import { sessionPromptRef } from "../../src/inbox/inbox-ref"
import { SessionPrompt } from "../../src/session/prompt"
import { AppRuntime } from "../../src/effect/app-runtime"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

afterEach(() => Instance.disposeAll())

// Desktop tool-step-schema [TP-R14-07] [TP-R14-11].
test("failed completion-gate reentry preserves the result without reporting task success", async () => {
  const server = startScriptedLLMServer([{ lines: textStopResponse("MAIN-RESULT") }, { lines: [], status: 400 }])
  await using tmp = await tmpdir({
    git: true,
    config: {
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.origin}/v1` } } },
      agent: {
        custom: { model: "alibaba/qwen-plus", mode: "subagent", completionGate: true, permission: { "*": "deny" } },
      },
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const actors = yield* Actor.Service
            const sessions = yield* Session.Service
            const tasks = yield* TaskRegistry.Service
            const parent = yield* sessions.create({ title: "gate failure" })
            const task = yield* tasks.create({ session_id: parent.id, summary: "unfinished work" })
            const child = yield* actors.spawn({
              mode: "subagent",
              sessionID: parent.id,
              agentType: "custom",
              task: "work",
              task_id: task.id,
              context: "none",
              tools: [],
              background: false,
            })
            const outcome = yield* Deferred.await(child.outcome)
            expect(outcome.status).toBe("success")
            if (outcome.status === "success") {
              expect(outcome.finalText).toContain("MAIN-RESULT")
              expect(outcome.reportedStatus).toBe("partial")
              expect(outcome.warnings?.join(" ")).toContain("completion gate")
              expect(outcome.incompleteTasks).toContain(task.id)
            }
            const waited = yield* ActorWaiter.Service.use((waiter) =>
              waiter.wait({ sessionID: child.sessionID, actor_id: child.actorID }),
            ).pipe(Effect.provide(ActorWaiter.defaultLayer))
            expect(waited.result).toContain("MAIN-RESULT")
            expect(waited.reportedStatus).toBe("partial")
            expect(waited.warnings?.join(" ")).toContain("completion gate")
          }),
        ),
    })
  } finally {
    await server.stop()
  }
}, 30000)

// Desktop tool-step-schema [TP-R14-08] [TP-R14-11].
test("inbox waits for the entire spawn execution before starting a continuation", async () => {
  const server = startScriptedLLMServer([
    { lines: textStopResponse("SPAWN-RESULT") },
    { lines: textStopResponse("POST-RESULT") },
    { lines: textStopResponse("WOKEN-RESULT") },
    { lines: textStopResponse("LATE-WOKEN-RESULT") },
  ])
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const hook = path.join(dir, "hook.ts")
      await Bun.write(
        hook,
        `import fs from 'node:fs/promises'; export default async () => ({'actor.postStop': async (input, output) => { await fs.writeFile(${JSON.stringify(path.join(dir, "entered"))}, '1'); while (!await fs.stat(${JSON.stringify(path.join(dir, "release"))}).then(() => true, () => false)) await new Promise(r => setTimeout(r, 10)); if (input.iteration === 0) { output.continue = true; output.reason = 'postStop housekeeping'; } }});`,
      )
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify({
          plugin: [pathToFileURL(hook).href],
          enabled_providers: ["alibaba"],
          provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.origin}/v1` } } },
          agent: { custom: { model: "alibaba/qwen-plus" } },
        }),
      )
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const actors = yield* Actor.Service
            const sessions = yield* Session.Service
            const registry = yield* ActorRegistry.Service
            const inbox = yield* Inbox.Service
            const prompt = yield* SessionPrompt.Service
            const previous = sessionPromptRef.current
            sessionPromptRef.current = { loop: prompt.loop }
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                sessionPromptRef.current = previous
              }),
            )
            const parent = yield* sessions.create({
              title: "execution overlap",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            })
            const child = yield* actors.spawn({
              mode: "subagent",
              sessionID: parent.id,
              agentType: "custom",
              task: "spawn probe",
              context: "none",
              tools: [],
              background: true,
            })
            for (
              let i = 0;
              i < 500 && !(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "entered")).exists()));
              i++
            )
              yield* Effect.sleep("10 millis")
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "entered")).exists())).toBe(true)
            const bus = yield* Bus.Service
            let completions = 0
            let lateSend: Promise<unknown> | undefined
            const unsubscribe = yield* bus.subscribeCallback(ActorStatusChanged, (event) => {
              if (
                event.properties.sessionID !== child.sessionID ||
                event.properties.actorID !== child.actorID ||
                event.properties.status !== "idle"
              )
                return
              completions++
              if (completions === 2)
                lateSend = AppRuntime.runPromise(
                  inbox.send({
                    receiverSessionID: child.sessionID,
                    receiverActorID: child.actorID,
                    senderSessionID: parent.id,
                    senderActorID: "main",
                    content: "late wake at terminal boundary",
                  }),
                )
            })
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
            yield* inbox.send({
              receiverSessionID: child.sessionID,
              receiverActorID: child.actorID,
              senderSessionID: parent.id,
              senderActorID: "main",
              content: "woken probe",
            })
            yield* inbox.send({
              receiverSessionID: child.sessionID,
              receiverActorID: child.actorID,
              senderSessionID: parent.id,
              senderActorID: "main",
              content: "another queued message",
            })
            yield* Effect.sleep("150 millis")
            const duringHook = yield* registry.get(child.sessionID, child.actorID)
            expect(duringHook?.status).toBe("running")
            expect(server.captures.length).toBe(1)
            yield* Effect.promise(() => Bun.write(path.join(tmp.path, "release"), "1"))
            const outcome = yield* Deferred.await(child.outcome)
            expect(outcome.status).toBe("success")
            if (outcome.status === "success") expect(outcome.finalText).toBe("SPAWN-RESULT")
            let texts: string[] = []
            for (let i = 0; i < 500; i++) {
              const messages = yield* sessions.messages({ sessionID: child.sessionID, agentID: child.actorID })
              texts = messages.flatMap((m) =>
                m.info.role === "assistant" ? m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [],
              )
              if (texts.includes("LATE-WOKEN-RESULT")) break
              yield* Effect.sleep("10 millis")
            }
            expect(texts.filter((text) => text === "WOKEN-RESULT")).toHaveLength(1)
            expect(texts.filter((text) => text === "LATE-WOKEN-RESULT")).toHaveLength(1)
            yield* Effect.promise(() => lateSend!)
            yield* Effect.sleep("100 millis")
            const after = yield* sessions.messages({ sessionID: child.sessionID, agentID: child.actorID })
            expect(after.filter((message) => message.info.role === "assistant")).toHaveLength(4)
            expect(JSON.stringify(server.captures[1].messages)).not.toContain("woken probe")
            expect(JSON.stringify(server.captures[1].messages)).not.toContain("another queued message")
          }).pipe(Effect.scoped, Effect.provide(Inbox.defaultLayer)),
        ),
    })
  } finally {
    await Bun.write(path.join(tmp.path, "release"), "1")
    await server.stop()
  }
}, 30000)

// Desktop tool-step-schema [TP-R14-09].
test("cancellation at onActorID is retained before the spawn fiber is attached", async () => {
  const server = startScriptedLLMServer([{ lines: textStopResponse("MUST-NOT-RUN") }])
  await using tmp = await tmpdir({
    git: true,
    config: {
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.origin}/v1` } } },
      agent: { custom: { model: "alibaba/qwen-plus" } },
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const actor = yield* Actor.Service
            const sessions = yield* Session.Service
            const registry = yield* ActorRegistry.Service
            const parent = yield* sessions.create({ title: "cancel before attachment" })
            let cancellation: Promise<void> | undefined
            const child = yield* actor.spawn({
              mode: "subagent",
              sessionID: parent.id,
              agentType: "custom",
              task: "must not execute",
              context: "none",
              tools: [],
              background: false,
              onActorID: (actorID) => {
                cancellation = AppRuntime.runPromise(actor.cancel(parent.id, actorID, "forced"))
              },
            })
            yield* Effect.promise(() => cancellation!)
            expect((yield* Deferred.await(child.outcome)).status).toBe("cancelled")
            expect((yield* registry.get(child.sessionID, child.actorID))?.lastOutcome).toBe("cancelled")
            expect(server.captures.length).toBe(0)
          }),
        ),
    })
  } finally {
    await server.stop()
  }
}, 30000)
