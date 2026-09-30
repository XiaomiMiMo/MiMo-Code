import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { runTurn } from "../../src/actor/turn"
import { initProjectors } from "../../src/server/projectors"
import { Database } from "../../src/storage"
import { Log } from "../../src/util"

const [mode, directory, sessionInput] = process.argv.slice(2)
if (!directory || !process.send) throw new Error("actor-process requires its test parent")
await Log.init({ print: false })
initProjectors()
const release = Promise.withResolvers<void>()
process.on("message", message => { if (message === "finish") release.resolve() })
const send = (value: unknown) => new Promise<void>((resolve, reject) => {
  process.send!(value, (error?: Error | null) => (error ? reject(error) : resolve()))
})
const services = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, ActorWaiter.defaultLayer)

try {
  await Instance.provide({ directory, fn: () => Effect.runPromise(Effect.gen(function* () {
    const sessions = yield* Session.Service
    const registry = yield* ActorRegistry.Service
    const waiter = yield* ActorWaiter.Service
    if (mode === "inspect") {
      const sessionID = SessionID.make(sessionInput)
      const actor = yield* registry.get(sessionID, "case-child")
      const waited = yield* waiter.wait({ sessionID, actor_id: "case-child", timeout_ms: 50 })
      yield* Effect.promise(() => send({ kind: "result", actor, waited }))
      return
    }
    const session = yield* sessions.create({ title: `actor process case: ${mode}` })
    yield* registry.register({ sessionID: session.id, actorID: "case-child", mode: "subagent", agent: "general", description: "process case", contextMode: "none", background: true, lifecycle: "ephemeral" })
    if (mode === "hold") {
      yield* runTurn(session.id, "case-child", Effect.gen(function* () {
        yield* Effect.promise(() => send({ kind: "ready", sessionID: session.id }))
        yield* Effect.promise(() => release.promise)
      }))
      yield* Effect.promise(() => send({ kind: "finished" }))
      return
    }
    if (mode !== "settle") throw new Error(`Unknown case mode: ${mode}`)
    const parentID = MessageID.ascending()
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({ id: parentID, sessionID: session.id, agentID: "case-child", role: "user", agent: "general", model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }, time: { created: Date.now() } })
    yield* sessions.updateMessage({ id: messageID, sessionID: session.id, agentID: "case-child", role: "assistant", parentID, agent: "general", mode: "default", modelID: ModelID.make("test-model"), providerID: ProviderID.make("test"), path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), completed: Date.now() }, actorResult: { finalText: "PERSISTED-PARTIAL" } })
    yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID, type: "text", text: "PERSISTED-PARTIAL" })
    yield* runTurn(session.id, "case-child", Effect.fail("controlled failure"), () => Effect.succeed(messageID)).pipe(Effect.exit)
    yield* Effect.promise(() => send({ kind: "result", sessionID: session.id }))
  }).pipe(Effect.scoped, Effect.provide(services))) })
} catch (error) {
  await send({ kind: "error", message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  await Instance.disposeAll()
  Database.close()
  process.disconnect?.()
}
