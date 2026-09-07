import { expect, spyOn, test } from "bun:test"
import { Database, sql } from "../../src/storage"
import { Effect } from "effect"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Command } from "../../src/command"
import { SessionPrompt } from "../../src/session/prompt"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import { textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"
import { MessageID } from "../../src/session/schema"

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for detached title")
}

// [TP-ST-R3-01, TP-ST-R4-01, TP-ST-R4-02, TP-ST-R2-05, TP-ST-R7-05]
test("fallback commits before detached lite request; duplicate receipt and later AI cannot overwrite manual", async () => {
  const captured: { model: string; messages: unknown[]; path: string }[] = []
  let reject = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      captured.push({ ...(await request.json()), path: new URL(request.url).pathname })
      await gate
      if (reject) return new Response(JSON.stringify({ error: { message: "No permission" } }), { status: 403 })
      return new Response(
        toolCallResponse({
          id: "title-output",
          name: "StructuredOutput",
          args: JSON.stringify({ title: "Generated summary" }),
        }).join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const provider = {
          npm: "@ai-sdk/openai-compatible",
          env: [],
          options: { apiKey: "fixture", baseURL: `http://localhost:${server.port}/v1` },
          models: {
            text: {
              name: "Text",
              tool_call: true,
              limit: { context: 8000, output: 1000 },
              modalities: { input: ["text"], output: ["text"] },
            },
          },
        }
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            provider: {
              main: provider,
              lite: {
                ...provider,
                options: { ...provider.options, baseURL: `http://localhost:${server.port}/lite/v1` },
              },
            },
            enabled_providers: ["main", "lite"],
            model: "main/text",
            model_groups: { lite: "lite/text" },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const run = AppRuntime.runPromise
        const session = await run(Session.Service.use((svc) => svc.create()))
        const messageID = MessageID.ascending()
        const input = {
          sessionID: session.id,
          messageID,
          noReply: true,
          model: { providerID: ProviderID.make("main"), modelID: ModelID.make("text") },
          parts: [
            { type: "text" as const, text: "Reference secret ses_other", metadata: { titleOrigin: "reference" } },
            { type: "text" as const, text: "Fix first task\nMore details", metadata: { titleOrigin: "user" } },
          ],
        }
        await run(SessionPrompt.Service.use((svc) => svc.prompt(input)))
        const fallback = await run(Session.Service.use((svc) => svc.get(session.id)))
        expect([fallback.title, fallback.titleSource, fallback.titleRevision]).toEqual([
          "Fix first task",
          "fallback",
          1,
        ])
        await until(() => captured.length === 1)
        expect(captured[0].path).toBe("/lite/v1/chat/completions")
        expect(JSON.stringify(captured[0])).not.toContain("Reference secret")
        expect(JSON.stringify(captured[0])).toContain("Fix first task")
        await run(
          Session.Service.use((svc) =>
            svc.setTitle({ sessionID: session.id, title: "My protected name", expectedRevision: 0 }),
          ),
        )
        release()
        await run(SessionPrompt.Service.use((svc) => svc.prompt(input)))
        await Bun.sleep(150)
        expect(captured).toHaveLength(1)
        const manual = await run(Session.Service.use((svc) => svc.get(session.id)))
        expect([manual.title, manual.titleSource, manual.titleRevision]).toEqual(["My protected name", "user", 2])
        const next = await run(Session.Service.use((svc) => svc.create()))
        await run(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({ ...input, sessionID: next.id, messageID: MessageID.ascending() }),
          ),
        )
        await until(async () => (await run(Session.Service.use((svc) => svc.get(next.id)))).titleSource === "generated")
        expect(captured).toHaveLength(2)
        await run(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({ ...input, sessionID: next.id, messageID: MessageID.ascending() }),
          ),
        )
        await Bun.sleep(50)
        expect(captured).toHaveLength(2)
        // [TP-ST-R2-01, TP-ST-R6-01] Branch and nonlinguistic first turns never request AI.
        const branch = await run(Session.Service.use((svc) => svc.fork({ sessionID: next.id })))
        await run(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({ ...input, sessionID: branch.id, messageID: MessageID.ascending() }),
          ),
        )
        const protectedBranch = await run(Session.Service.use((svc) => svc.get(branch.id)))
        expect([protectedBranch.title, protectedBranch.titleSource, protectedBranch.titleRevision]).toEqual([
          branch.title,
          "user",
          0,
        ])
        const numeric = await run(Session.Service.use((svc) => svc.create()))
        await run(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({
              ...input,
              sessionID: numeric.id,
              messageID: MessageID.ascending(),
              parts: [{ type: "text", text: "12345 😀" }],
            }),
          ),
        )
        expect((await run(Session.Service.use((svc) => svc.get(numeric.id)))).title).toBe("12345 😀")
        expect(captured).toHaveLength(2)
        const attachment = await run(Session.Service.use((svc) => svc.create()))
        await run(SessionPrompt.Service.use((svc) => svc.prompt({
          ...input,
          sessionID: attachment.id,
          messageID: MessageID.ascending(),
          parts: [{ type: "text", text: "(见附件)", metadata: {
            titleOrigin: "attachment-placeholder",
            titleAttachments: [{ name: "MiMo-AI-latest-arm64.dmg", path: "/fixture/MiMo-AI-latest-arm64.dmg" }],
          } }],
        })))
        expect(await run(Session.Service.use((svc) => svc.get(attachment.id)))).toMatchObject({
          title: "MiMo-AI-latest-arm64.dmg", titleSource: "fallback", titleRevision: 1,
        })
        expect(captured).toHaveLength(2)
        // [TP-ST-R3-02, TP-ST-R4-03] A failed resolved lite model does not rotate providers or retry on later user turns.
        reject = true
        const failed = await run(Session.Service.use((svc) => svc.create()))
        await run(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({ ...input, sessionID: failed.id, messageID: MessageID.ascending() }),
          ),
        )
        await until(() => captured.length === 3)
        await Bun.sleep(150)
        expect((await run(Session.Service.use((svc) => svc.get(failed.id)))).titleSource).toBe("fallback")
        await run(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({ ...input, sessionID: failed.id, messageID: MessageID.ascending() }),
          ),
        )
        await Bun.sleep(50)
        expect(captured).toHaveLength(3)

        const retry = await run(Session.Service.use(svc => svc.create()))
        Database.use(db => db.run(sql`CREATE TEMP TRIGGER reject_initial_title BEFORE UPDATE OF title ON session WHEN NEW.title_source = 'fallback' BEGIN SELECT RAISE(ABORT, 'initial title fault'); END`))
        try {
          await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: retry.id, messageID: MessageID.ascending(), parts: [{ type: "text", text: "12345" }] })))
          expect(await run(Session.Service.use(svc => svc.get(retry.id)))).toMatchObject({ title: "Untitled", titleRevision: 0 })
        } finally {
          Database.use(db => db.run(sql`DROP TRIGGER reject_initial_title`))
        }
        await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: retry.id, messageID: MessageID.ascending(), parts: [{ type: "text", text: "67890" }] })))
        expect(await run(Session.Service.use(svc => svc.get(retry.id)))).toMatchObject({ title: "12345", titleSource: "fallback", titleRevision: 1 })
        expect(captured).toHaveLength(3)

        const same = await run(Session.Service.use(svc => svc.create()))
        await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: same.id, messageID: MessageID.ascending(), parts: [{ type: "text", text: "Untitled" }] })))
        await until(() => captured.length === 4)
        expect(await run(Session.Service.use(svc => svc.get(same.id)))).toMatchObject({ title: "Untitled", titleRevision: 1 })
        const service = await run(Session.Service.use(svc => Effect.succeed(svc)))
        const historyReads = spyOn(service, "messages")
        try {
          await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, source: "spawn", sessionID: same.id, messageID: MessageID.ascending(), parts: [{ type: "text", text: "Later task" }] })))
          expect(historyReads).not.toHaveBeenCalled()
          expect(await run(Session.Service.use(svc => svc.get(same.id)))).toMatchObject({ title: "Untitled", titleRevision: 1 })
          expect(captured).toHaveLength(4)
        } finally { historyReads.mockRestore() }
      },
    })
  } finally {
    release()
    await server.stop(true)
  }
}, 30000)

test("registered skill command titles use user arguments rather than the selected slash prefix", async () => {
  const titles: string[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json()
    const isTitle = new URL(request.url).pathname.startsWith("/lite/")
    if (isTitle) titles.push(JSON.stringify(body.messages))
    const response = isTitle
      ? toolCallResponse({ id: "skill-title", name: "StructuredOutput", args: JSON.stringify({ title: "Repair API 404" }) })
      : textStopResponse("Done")
    return new Response(response.join(""), { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    await using tmp = await tmpdir({ git: true, init: async dir => {
      await Bun.write(path.join(dir, ".mimocode/skill/title-fixture-skill/SKILL.md"), "---\nname: title-fixture-skill\ndescription: Test skill command title provenance.\n---\nSKILL_BODY_NOT_A_TITLE\n")
      const provider = (prefix: string) => ({ npm: "@ai-sdk/openai-compatible", env: [], options: { apiKey: "fixture", baseURL: `http://localhost:${server.port}/${prefix}/v1` }, models: { text: { name: "Text", tool_call: true, limit: { context: 128000, output: 1000 }, modalities: { input: ["text"], output: ["text"] } } } })
      await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify({ enabled_providers: ["main", "lite"], model: "main/text", model_groups: { lite: "lite/text" }, provider: { main: provider("main"), lite: provider("lite") } }))
    } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const run = AppRuntime.runPromise
      const commands = await run(Command.Service.use(svc => svc.list()))
      expect(commands.find(command => command.name === "title-fixture-skill")?.source).toBe("skill")
      const session = await run(Session.Service.use(svc => svc.create()))
      await run(SessionPrompt.Service.use(svc => svc.command({ sessionID: session.id, command: "title-fixture-skill", arguments: "Repair API 404", model: "main/text" })))
      await until(async () => (await run(Session.Service.use(svc => svc.get(session.id)))).titleSource === "generated")
      expect(titles).toHaveLength(1)
      expect(titles[0]).toContain("Repair API 404")
      expect(titles[0]).not.toContain("/title-fixture-skill")
      expect(titles[0]).not.toContain("SKILL_BODY_NOT_A_TITLE")
    } })
  } finally { await server.stop(true) }
}, 30000)

test("two completed user turns trigger contextual title reconsideration",  async () => {
  let reviews = 0
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json()
    const review = JSON.stringify(body.messages).includes("Reconsider this title only")
    if (review) reviews++
    const chunks = review
      ? toolCallResponse({ id: "review-result", name: "StructuredOutput", args: JSON.stringify({ title: "New queue task" }) })
      : textStopResponse("The task is now queue analysis.\n<!-- thread-purpose-changed -->")
    return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    await using tmp = await tmpdir({ git: true, init: async dir => {
      await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify({
        enabled_providers: ["fixture"], model: "fixture/text", model_groups: { lite: "fixture/text" },
        provider: { fixture: { npm: "@ai-sdk/openai-compatible", env: [], options: { apiKey: "fixture", baseURL: `http://localhost:${server.port}/v1` }, models: { text: { name: "Text", tool_call: true, limit: { context: 128000, output: 1000 }, modalities: { input: ["text"], output: ["text"] } } } } },
      }))
    } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const run = AppRuntime.runPromise
      const s = await run(Session.Service.use(svc => svc.create()))
      await run(Session.Service.use(svc => svc.setGeneratedTitle({ sessionID: s.id, title: "Original task", expectedRevision: 0 })))
      const turn = (text: string) => run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: s.id, model: { providerID: ProviderID.make("fixture"), modelID: ModelID.make("text") }, parts: [{ type: "text", text }] })))
      await turn("Switch to queue analysis")
      expect(reviews).toBe(0)
      await turn("Continue the queue analysis task")
      await until(async () => (await run(Session.Service.use(svc => svc.get(s.id)))).title === "New queue task")
      expect(reviews).toBe(1)
    } })
  } finally { await server.stop(true) }
}, 30000)

test("ephemeral lite reads a referenced fixture then emits StructuredOutput without persisted tool messages",  async () => {
  const captured: { messages: unknown[]; tools: { function: { name: string } }[] }[] = []
  let resource = ""
  const server = Bun.serve({ port: 0, async fetch(request) {
    captured.push(await request.json())
    const first = captured.length === 1
    return new Response(toolCallResponse({ id: first ? "read-fixture" : "title-fixture", name: first ? "read" : "StructuredOutput", args: JSON.stringify(first ? { path: resource } : { title: "Queue latency analysis" }) }).join(""), { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    await using tmp = await tmpdir({ git: true, init: async dir => {
      resource = path.join(dir, "notes.txt")
      await Bun.write(resource, "Queue latency comes from lock contention.")
      await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify({
        enabled_providers: ["fixture"], model: "fixture/text", model_groups: { lite: "fixture/text" },
        provider: { fixture: {
          npm: "@ai-sdk/openai-compatible",
          env: [],
          options: { apiKey: "fixture", baseURL: `http://localhost:${server.port}/v1` },
          models: { text: { name: "Text", tool_call: true, limit: { context: 8000, output: 1000 }, modalities: { input: ["text"], output: ["text"] } } },
        } },
      }))
    } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const run = AppRuntime.runPromise
      const session = await run(Session.Service.use(svc => svc.create()))
      await run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: session.id, noReply: true, model: { providerID: ProviderID.make("fixture"), modelID: ModelID.make("text") }, parts: [{ type: "text", text: `Analyze [notes](${resource})`, metadata: { titleAttachments: [{ name: "notes.txt", path: resource }] } }] })))
      await until(async () => (await run(Session.Service.use(svc => svc.get(session.id)))).titleSource === "generated")
      expect(captured).toHaveLength(2)
      expect(captured[0].tools.map(tool => tool.function.name).sort()).toEqual(["StructuredOutput", "read"])
      expect(JSON.stringify(captured[1].messages)).toContain("Queue latency comes from lock contention.")
      expect(await run(Session.Service.use(svc => svc.children(session.id)))).toHaveLength(0)
      const messages = await run(Session.Service.use(svc => svc.messages({ sessionID: session.id })))
      expect(messages).toHaveLength(1)
      expect(messages[0].info.role).toBe("user")
      for (const reference of [path.join(tmp.path, ".env"), "/outside-title-fixture/private.txt"]) {
        await run(SessionPrompt.Service.use(svc => svc.genTitle({ text: `Describe ${reference}`, sessionID: session.id, providerID: ProviderID.make("fixture"), references: [{ name: "restricted", path: reference }] })))
        expect(captured.at(-1)!.tools.map(tool => tool.function.name)).not.toContain("read")
      }
      const restricted = await run(Session.Service.use(svc => svc.create()))
      await run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: restricted.id, noReply: true, tools: { read: false }, model: { providerID: ProviderID.make("fixture"), modelID: ModelID.make("text") }, parts: [{ type: "text", text: `Analyze ${resource}`, metadata: { titleAttachments: [{ name: "notes.txt", path: resource }] } }] })))
      await until(async () => (await run(Session.Service.use(svc => svc.get(restricted.id)))).titleSource === "generated")
      expect(captured.at(-1)!.tools.map(tool => tool.function.name)).not.toContain("read")
      await run(Session.Service.use(svc => svc.setPermission({ sessionID: session.id, permission: [{ permission: "read", pattern: "*", action: "deny" }] })))
      await run(SessionPrompt.Service.use(svc => svc.genTitle({ text: `Describe ${resource}`, sessionID: session.id, providerID: ProviderID.make("fixture"), references: [{ name: "denied", path: resource }] })))
      expect(captured.at(-1)!.tools.map(tool => tool.function.name)).not.toContain("read")
    } })
  } finally { await server.stop(true) }
}, 30000)
