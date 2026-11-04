#!/usr/bin/env bun
// Opt-in: seed once, then run in fresh processes against each source revision.
// bun run --cwd packages/cli ../../script/benchmark-recovery.ts --seed
// bun run --cwd packages/cli ../../script/benchmark-recovery.ts
// --small reduces the fixture; --wait pauses at ready until stdin closes for external RSS sampling.
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    seed: { type: "boolean" },
    small: { type: "boolean" },
    wait: { type: "boolean" },
    source: { type: "string" },
    directory: { type: "string" },
  },
})
const root = path.resolve(import.meta.dir, "..")
const source = path.resolve(values.source ?? root)
const directory = path.resolve(values.directory ?? path.join(root, "tmp/recovery-benchmark"))
const workspace = path.join(directory, "workspace")
const manifest = Bun.file(path.join(directory, "fixture.json"))
const database = Bun.file(path.join(directory, "fixture.sqlite"))
if (values.seed && ((await manifest.exists()) || (await database.exists())))
  throw new Error("Fixture already exists; use another directory")
if (!values.seed && !(await manifest.exists())) throw new Error("Seed the fixture first with --seed")
await mkdir(workspace, { recursive: true })
Object.assign(process.env, {
  MIMOCODE_HOME: path.join(directory, "runtime"),
  MIMOCODE_DB: path.join(directory, "fixture.sqlite"),
  MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true",
  MIMOCODE_DISABLE_MODELS_FETCH: "true",
  MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  MIMOCODE_MODELS_PATH: path.join(source, "packages/cli/test/tool/fixtures/models-api.json"),
  MIMOCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
})
const load = (name: string) => import(pathToFileURL(path.join(source, "packages/cli/src", name)).href)
const require = createRequire(path.join(source, "packages/cli/package.json"))
const { Effect } = await import(pathToFileURL(require.resolve("effect")).href)
const { Instance } = await load("project/instance.ts")
const { AppRuntime } = await load("effect/app-runtime.ts")
const { Database } = await load("storage/index.ts")
const { Session } = await load("session/index.ts")
const { SessionPrompt } = await load("session/prompt.ts")
const { stopIndexMigration } = await load("history/migration.ts")
const { Log } = await load("util/index.ts")
await Log.init({ print: false })
await load("server/projectors.ts")

type Fixture = {
  sessionID: string
  assistantMessageID: string
  parentMessageID: string
  messages: number
  parts: number
  tools: number
  images: number
  imageBytes: number
  partBytes: number
}

function seed(sessionID: string): Fixture {
  const messages = values.small ? 128 : 7939
  const parts = values.small ? 512 : 35117
  const tools = values.small ? 128 : 9444
  const images = values.small ? 4 : 837
  const imageBytes = values.small ? 2 * 1024 * 1024 : 185_700_000
  const largestImage = values.small ? 1024 * 1024 : 9_940_000
  const commonImage = Math.floor((imageBytes - largestImage) / (images - 1))
  const remainder = imageBytes - largestImage - commonImage * (images - 1)
  const db = Database.Client().$client
  const insertMessage = db.prepare(
    "INSERT INTO message(id, session_id, agent_id, time_created, time_updated, data) VALUES (?, ?, 'main', ?, ?, ?)",
  )
  const insertPart = db.prepare(
    "INSERT INTO part(id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  )
  const messageID = (index: number) => `msg_benchmark_${index.toString().padStart(8, "0")}`
  const assistantMessageID = messageID(messages - 1)
  const parentMessageID = messageID(messages - 2)
  let partCount = 0
  let toolCount = 0
  let imageCount = 0
  let partBytes = 0
  const output = "Synthetic tool output. " + "x".repeat(values.small ? 64 : 6200)
  db.transaction(() => {
    for (let i = 0; i < messages; i++) {
      const id = messageID(i)
      const assistant = i > 0 && (i === messages - 1 || i % 2 === (messages % 2 === 0 ? 1 : 0))
      const created = 1_700_000_000_000 + i
      const info = assistant
        ? {
            role: "assistant",
            parentID: messageID(i - 1),
            modelID: "model",
            providerID: "test",
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp/example", root: "/tmp/example" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created, completed: created },
            finish: "stop",
            ...(i === messages - 1
              ? { error: { name: "APIError", data: { message: "Synthetic interruption", isRetryable: true } } }
              : {}),
          }
        : { role: "user", time: { created }, agent: "build", model: { providerID: "test", modelID: "model" } }
      insertMessage.run(id, sessionID, created, created, JSON.stringify(info))
      const count = Math.floor(parts / messages) + (i < parts % messages ? 1 : 0)
      for (let n = 0; n < count; n++) {
        const tail = i === messages - 1 && n === 0
        const tool = assistant && (tail || toolCount < tools - 1)
        const image = tool && (tail || imageCount < images - 1)
        const bytes = tail ? largestImage : commonImage + (imageCount === 0 ? remainder : 0)
        const attachment = image
          ? [
              {
                id: `prt_attachment_${imageCount++}`,
                sessionID,
                messageID: id,
                type: "file",
                mime: "image/png",
                filename: "example.png",
                url: `data:image/png;base64,${"A".repeat(bytes)}`,
              },
            ]
          : undefined
        const data = tool
          ? {
              type: "tool",
              callID: `call_${toolCount++}`,
              tool: "example",
              state: {
                status: "completed",
                input: {},
                output,
                title: "example",
                metadata: {},
                time: { start: created, end: created },
                attachments: attachment,
              },
            }
          : { type: "text", text: "Synthetic conversation text." }
        const json = JSON.stringify(data)
        partBytes += Buffer.byteLength(json)
        insertPart.run(
          `prt_benchmark_${(partCount++).toString().padStart(8, "0")}`,
          id,
          sessionID,
          created,
          created,
          json,
        )
      }
    }
  })()
  if (toolCount !== tools || imageCount !== images) throw new Error("Fixture shape mismatch")
  return {
    sessionID,
    assistantMessageID,
    parentMessageID,
    messages,
    parts: partCount,
    tools,
    images,
    imageBytes,
    partBytes,
  }
}

await Instance.provide({
  directory: workspace,
  fn: () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        // Keep the unrelated asynchronous full-text backfill outside this measurement.
        stopIndexMigration(Database.Client())
        if (values.seed) {
          const session = yield* sessions.create({ title: "Synthetic recovery benchmark" })
          const fixture = seed(session.id)
          yield* Effect.promise(() => Bun.write(manifest, JSON.stringify(fixture, null, 2)))
          console.log(JSON.stringify({ phase: "seeded", ...fixture }))
          return
        }
        const fixture: Fixture = yield* Effect.promise(() => manifest.json())
        console.log(JSON.stringify({ phase: "ready", pid: process.pid }))
        if (values.wait) yield* Effect.promise(() => Bun.stdin.text())
        const cpu = process.cpuUsage()
        const rssBefore = process.memoryUsage().rss
        const started = performance.now()
        const candidates = yield* prompt.recovery({ sessionID: fixture.sessionID })
        const elapsedMs = performance.now() - started
        const usage = process.cpuUsage(cpu)
        if (candidates.length !== 1 || candidates[0].assistantMessageID !== fixture.assistantMessageID)
          throw new Error("Recovery candidate changed")
        console.log(
          JSON.stringify({
            phase: "measured",
            ...fixture,
            elapsedMs,
            cpuUserMs: usage.user / 1000,
            cpuSystemMs: usage.system / 1000,
            rssBefore,
            rssAfter: process.memoryUsage().rss,
            candidates: candidates.length,
            // This includes module/service initialization; an external sampler can isolate recovery.
            processLifetimeMaxRss: process.resourceUsage().maxRSS * 1024,
          }),
        )
      }),
    ),
})
await Instance.disposeAll()
await AppRuntime.dispose()
Database.close()
