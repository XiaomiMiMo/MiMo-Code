import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import assert from "node:assert/strict"
import { Deferred, Effect } from "effect"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "actor-notification-cases-"))
const env = {
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  MIMOCODE_DB: path.join(root, "cases.db"),
  MIMOCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
  MIMOCODE_MODELS_PATH: path.resolve(import.meta.dir, "../test/tool/fixtures/models-api.json"),
  MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true",
  MIMOCODE_EXPERIMENTAL_ORCHESTRATOR: "true",
}
Object.assign(process.env, env)
delete process.env.MIMOCODE_HOME
await fs.mkdir(env.HOME, { recursive: true })
const { Instance } = await import("../src/project/instance")
const { Session } = await import("../src/session")
const { Actor } = await import("../src/actor/spawn")
const { ActorWaiter } = await import("../src/actor/waiter")
const { SessionPrompt } = await import("../src/session/prompt")
const { Inbox } = await import("../src/inbox")
const { AppLayer } = await import("../src/effect/app-runtime")
const { attach } = await import("../src/effect/run-service")
const { Database } = await import("../src/storage")
const { initProjectors } = await import("../src/server/projectors")
const { ProviderID, ModelID } = await import("../src/provider/schema")
const { startScriptedLLMServer, textStopResponse } = await import("../test/lib/scripted-llm-server")
initProjectors()
const cases = []
for (const scenario of ["warning", "failure"] as const) {
  const directory = path.join(root, scenario)
  await fs.mkdir(directory)
  const server = startScriptedLLMServer([
    { lines: textStopResponse(`PRESERVED-${scenario.toUpperCase()}-RESULT`) },
    { lines: [], status: 400 },
  ])
  const hook = path.join(directory, "hook.ts")
  await fs.writeFile(hook, `export default async () => ({ 'actor.${scenario === "warning" ? "postStop" : "preStop"}': async (input, output) => { if (input.iteration === 0) { output.continue = true; output.reason = 'deterministic local failure probe'; } } });`)
  await fs.writeFile(path.join(directory, "mimocode.json"), JSON.stringify({
    plugin: [pathToFileURL(hook).href],
    enabled_providers: ["alibaba"],
    provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.origin}/v1` } } },
    agent: { custom: { model: "alibaba/qwen-plus", permission: { "*": "deny" } } },
  }, null, 2))
  try {
    const result = await Instance.provide({ directory, fn: () => Effect.runPromise(attach(Effect.gen(function* () {
      const sessions = yield* Session.Service
      const actor = yield* Actor.Service
      const prompt = yield* SessionPrompt.Service
      const inbox = yield* Inbox.Service
      const parent = yield* sessions.create({ title: `PR2347 本地故障案例 ${scenario}` })
      yield* prompt.prompt({ sessionID: parent.id, agent: "custom", model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }, noReply: true, parts: [{ type: "text", text: `本地确定性测试：${scenario}。HTTP 400 来自模拟服务，并非真实模型故障。只查看结果，不继续发消息。` }] })
      const child = yield* actor.spawn({ mode: "subagent", sessionID: parent.id, agentType: "custom", task: "Produce the controlled result", context: "none", tools: [], background: true })
      const outcome = yield* Deferred.await(child.outcome)
      assert.equal(outcome.status, scenario === "warning" ? "success" : "failure")
      const waited = yield* ActorWaiter.Service.use((waiter) => waiter.wait({ sessionID: child.sessionID, actor_id: child.actorID, timeout_ms: 1000 })).pipe(Effect.provide(ActorWaiter.defaultLayer))
      assert.equal(waited.result, `PRESERVED-${scenario.toUpperCase()}-RESULT`)
      if (scenario === "warning") assert.ok(waited.warnings?.some((warning) => warning.includes("postStop")))
      if (scenario === "failure") assert.ok(waited.error)
      let notifications: string[] = []
      for (let i = 0; i < 100; i++) {
        yield* inbox.drain(parent.id, "main")
        const messages = yield* sessions.messages({ sessionID: parent.id, agentID: "main" })
        notifications = messages.flatMap((message) => message.parts.flatMap((part) => part.type === "text" && part.text.includes("Background sub-session") ? [part.text] : []))
        if (notifications.length) break
        yield* Effect.sleep("20 millis")
      }
      assert.equal(notifications.length, 1)
      assert.ok(notifications[0].includes(`PRESERVED-${scenario.toUpperCase()}-RESULT`))
      return { scenario, directory, sessionID: parent.id, actorID: child.actorID, waited, notification: notifications[0] }
    }).pipe(Effect.provide(Inbox.defaultLayer))).pipe(Effect.scoped, Effect.provide(AppLayer))) })
    cases.push(result)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await Instance.disposeAll()
    await server.stop()
  }
}
Database.close()
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const commands = cases.map((item) => `env ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${quote(process.execPath)} run --conditions=browser ${quote(path.resolve(import.meta.dir, "../src/index.ts"))} ${quote(item.directory)} --session ${quote(item.sessionID)}`)
await fs.writeFile(path.join(root, "cases.json"), JSON.stringify({ root, cases, commands }, null, 2))
console.log(`\nSaved cases: ${root}\nRead-only inspection: the local provider is stopped; do not send new prompts.\n${commands.join("\n\n")}`)
process.exit(0)
