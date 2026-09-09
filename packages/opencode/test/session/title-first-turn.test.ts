import { expect, spyOn, test } from "bun:test"
import { Database, sql } from "../../src/storage"
import { Effect } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Command } from "../../src/command"
import { injectScheduledPrompt, SessionPrompt } from "../../src/session/prompt"
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
            { type: "text" as const, text: "Reference secret ses_other", synthetic: true },
            { type: "text" as const, text: "Fix first task\nMore details" },
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
        const binary = path.join(tmp.path, "MiMo-AI-latest-arm64.dmg")
        await Bun.write(binary, Buffer.alloc(32 * 1024 * 1024, 0))
        const attached = await run(SessionPrompt.Service.use((svc) => svc.prompt({
          ...input,
          sessionID: attachment.id,
          messageID: MessageID.ascending(),
          parts: [{ type: "text", text: "(见附件)", synthetic: true }, { type: "file", filename: path.basename(binary), mime: "application/x-apple-diskimage", url: pathToFileURL(binary).href }],
        })))
        expect(attached.parts.filter(part => part.type === "file")).toMatchObject([{ url: pathToFileURL(binary).href }])
        expect(JSON.stringify(attached.parts).length).toBeLessThan(4096)
        expect(await run(Session.Service.use((svc) => svc.get(attachment.id)))).toMatchObject({
          title: "MiMo-AI-latest-arm64.dmg", titleSource: "fallback", titleRevision: 1,
        })
        expect(captured).toHaveLength(2)
        // [TP-ST-R3-02, TP-ST-R4-03] Failed lite tries the exact source once, never on later turns.
        reject = true
        const failed = await run(Session.Service.use((svc) => svc.create()))
        await run(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({ ...input, sessionID: failed.id, messageID: MessageID.ascending() }),
          ),
        )
        await until(() => captured.length === 4)
        expect(captured.slice(2).map(request => request.path)).toEqual(["/lite/v1/chat/completions", "/v1/chat/completions"])
        await Bun.sleep(150)
        expect((await run(Session.Service.use((svc) => svc.get(failed.id)))).titleSource).toBe("fallback")
        await run(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({ ...input, sessionID: failed.id, messageID: MessageID.ascending() }),
          ),
        )
        await Bun.sleep(50)
        expect(captured).toHaveLength(4)


        const hooked = await run(Session.Service.use(svc => svc.create()))
        await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: hooked.id, messageID: MessageID.ascending(), source: "hook", provenance: { hookPhase: "pre", hookIteration: 0, hookIDs: [], pluginNames: [] }, parts: [{ type: "text", text: "Hook instructions" }] })))
        expect(await run(Session.Service.use(svc => svc.get(hooked.id)))).toMatchObject({ title: "Untitled", titleRevision: 0 })
        await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: hooked.id, messageID: MessageID.ascending(), parts: [{ type: "text", text: "54321" }] })))
        expect(await run(Session.Service.use(svc => svc.get(hooked.id)))).toMatchObject({ title: "54321", titleRevision: 1 })
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
        expect(captured).toHaveLength(4)

        const same = await run(Session.Service.use(svc => svc.create()))
        await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: same.id, messageID: MessageID.ascending(), parts: [{ type: "text", text: "Untitled" }] })))
        await until(() => captured.length === 6)
        expect(await run(Session.Service.use(svc => svc.get(same.id)))).toMatchObject({ title: "Untitled", titleRevision: 1 })
        const service = await run(Session.Service.use(svc => Effect.succeed(svc)))
        const rejected = await run(Session.Service.use(svc => svc.create()))
        await expect(run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: rejected.id, source: "hook", parts: [{ type: "file", filename: "hook.dmg", mime: "application/x-apple-diskimage", url: pathToFileURL(binary).href }] })))).rejects.toThrow("non-text parts requires provenance")
        const sourceOnly = await run(Session.Service.use(svc => svc.create()))
        const automated = await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: sourceOnly.id, messageID: MessageID.ascending(), source: "hook", parts: [{ type: "text", text: "AUTOMATED_NOT_A_TITLE", synthetic: false }] })))
        expect(automated.parts).toMatchObject([{ type: "text", text: "AUTOMATED_NOT_A_TITLE", synthetic: true }])
        expect(await run(Session.Service.use(svc => svc.get(sourceOnly.id)))).toMatchObject({ title: "Untitled", titleRevision: 0 })
        expect((await run(Session.Service.use(svc => svc.messages({ sessionID: sourceOnly.id }))))[0].parts).toMatchObject([{ synthetic: true }])
        await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: sourceOnly.id, messageID: MessageID.ascending(), parts: [{ type: "text", text: "98765" }] })))
        expect(await run(Session.Service.use(svc => svc.get(sourceOnly.id)))).toMatchObject({ title: "98765", titleRevision: 1 })
        expect(captured).toHaveLength(6)
        const actorRoot = await run(Session.Service.use(svc => svc.create()))
        const spawned = await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: actorRoot.id, messageID: MessageID.ascending(), source: "spawn", agentID: "fixture-actor", parts: [{ type: "text", text: "Spawn task is not root user input" }] })))
        expect(spawned.parts[0]).not.toHaveProperty("synthetic", true)
        expect(await run(Session.Service.use(svc => svc.get(actorRoot.id)))).toMatchObject({ titleRevision: 0 })
        await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: actorRoot.id, messageID: MessageID.ascending(), parts: [{ type: "text", text: "45678" }] })))
        expect(await run(Session.Service.use(svc => svc.get(actorRoot.id)))).toMatchObject({ title: "45678", titleRevision: 1 })
        expect(captured).toHaveLength(6)
        await expect(run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: rejected.id, source: "spawn", parts: [{ type: "text", text: "Not a root user" }] })))).rejects.toThrow("Spawn input requires")
        expect(await run(Session.Service.use(svc => svc.messages({ sessionID: rejected.id })))).toHaveLength(0)
        expect((await run(Session.Service.use(svc => svc.get(rejected.id)))).titleRevision).toBe(0)
        const historyReads = spyOn(service, "messages")
        try {
          await run(SessionPrompt.Service.use(svc => svc.prompt({ ...input, sessionID: same.id, messageID: MessageID.ascending(), parts: [{ type: "text", text: "Later task" }] })))
          expect(historyReads.mock.calls.filter(([query]) => query.agentID === "main")).toHaveLength(0)
          expect(await run(Session.Service.use(svc => svc.get(same.id)))).toMatchObject({ title: "Untitled", titleRevision: 1 })
          expect(captured).toHaveLength(6)
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
  let requests = 0
  const server = Bun.serve({ port: 0, async fetch(request) {
    requests++
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
      await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify({ enabled_providers: ["main", "lite"], model: "main/text", model_groups: { lite: "lite/text" }, provider: { main: provider("main"), lite: provider("lite") }, command: { "title-fixture-command": { template: "COMMAND_TEMPLATE_NOT_A_TITLE $ARGUMENTS" }, "title-delegated": { template: "Delegate task", agent: "explore", model: "main/text", subtask: true } } }))
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
      const empty = await run(Session.Service.use(svc => svc.create()))
      await run(SessionPrompt.Service.use(svc => svc.command({ sessionID: empty.id, command: "title-fixture-skill", arguments: "", model: "main/text" })))
      expect(await run(Session.Service.use(svc => svc.get(empty.id)))).toMatchObject({ title: "Untitled", titleRevision: 1, titleSource: "fallback" })
      expect(titles).toHaveLength(1)
      const attached = await run(Session.Service.use(svc => svc.create()))
      const attachmentPath = path.join(tmp.path, "fixture-package.dmg")
      await Bun.write(attachmentPath, Buffer.alloc(32))
      await run(SessionPrompt.Service.use(svc => svc.command({ sessionID: attached.id, command: "title-fixture-command", arguments: "", model: "main/text", parts: [{ type: "file", filename: "fixture-package.dmg", mime: "application/x-apple-diskimage", url: pathToFileURL(attachmentPath).href }] })))
      expect(await run(Session.Service.use(svc => svc.get(attached.id)))).toMatchObject({ title: "fixture-package.dmg", titleRevision: 1, titleSource: "fallback" })
      expect(titles).toHaveLength(1)
      const retry = await run(Session.Service.use(svc => svc.create()))
      Database.use(db => db.run(sql`CREATE TEMP TRIGGER reject_command_title BEFORE UPDATE OF title ON session WHEN NEW.title_source = 'fallback' BEGIN SELECT RAISE(ABORT, 'command title fault'); END`))
      try {
        await expect(run(SessionPrompt.Service.use(svc => svc.command({ sessionID: retry.id, command: "title-fixture-skill", arguments: "Original command request", model: "main/text" })))).rejects.toThrow()
        expect(await run(Session.Service.use(svc => svc.messages({ sessionID: retry.id })))).toHaveLength(0)
      } finally { Database.use(db => db.run(sql`DROP TRIGGER reject_command_title`)) }
      await run(SessionPrompt.Service.use(svc => svc.command({ sessionID: retry.id, command: "title-fixture-skill", arguments: "Original command request", model: "main/text" })))
      await until(() => titles.length === 2)
      expect(titles[1]).toContain("Original command request")
      expect(titles[1]).not.toContain("/title-fixture-skill")
      const normal = await run(Session.Service.use(svc => svc.create()))
      await run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: normal.id, source: "hook", noReply: true, model: { providerID: ProviderID.make("main"), modelID: ModelID.make("text") }, parts: [{ type: "text", text: "HOOK_CONTEXT_NOT_A_TITLE" }] })))
      expect(await run(Session.Service.use(svc => svc.get(normal.id)))).toMatchObject({ title: "Untitled", titleRevision: 0 })
      expect(titles).toHaveLength(2)
      await run(SessionPrompt.Service.use(svc => svc.command({ sessionID: normal.id, command: "title-fixture-command", arguments: "Investigate request timing", model: "main/text", parts: [{ type: "text", text: "CONTEXT_NOT_A_TITLE", synthetic: true }] })))
      await until(() => titles.length === 3)
      expect(titles[2]).toContain("Investigate request timing")
      expect(titles[2]).not.toContain("COMMAND_TEMPLATE_NOT_A_TITLE")
      expect(titles[2]).not.toContain("CONTEXT_NOT_A_TITLE")
      expect(titles[2]).not.toContain("HOOK_CONTEXT_NOT_A_TITLE")
      const normalMessages = await run(Session.Service.use(svc => svc.messages({ sessionID: normal.id })))
      expect(JSON.stringify(normalMessages)).toContain("COMMAND_TEMPLATE_NOT_A_TITLE")
      expect(JSON.stringify(normalMessages)).toContain("CONTEXT_NOT_A_TITLE")
      const history = await run(Session.Service.use(svc => svc.create()))
      Database.use(db => db.run(sql`CREATE TEMP TRIGGER reject_history_title BEFORE UPDATE OF title ON session WHEN NEW.title_source = 'fallback' BEGIN SELECT RAISE(ABORT, 'history title fault'); END`))
      try {
        await run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: history.id, noReply: true, model: { providerID: ProviderID.make("main"), modelID: ModelID.make("text") }, parts: [{ type: "text", text: "12345" }] })))
        expect(await run(Session.Service.use(svc => svc.get(history.id)))).toMatchObject({ titleRevision: 0 })
      } finally { Database.use(db => db.run(sql`DROP TRIGGER reject_history_title`)) }
      await run(SessionPrompt.Service.use(svc => svc.command({ sessionID: history.id, command: "title-fixture-command", arguments: "Do not replace the original task", model: "main/text" })))
      expect(await run(Session.Service.use(svc => svc.get(history.id)))).toMatchObject({ title: "12345", titleRevision: 1 })
      expect(titles).toHaveLength(3)
      const beforeInvalid = requests
      for (const actual of [{ agent: "missing-agent", model: "main/text" }, { agent: "build", model: "missing/model" }]) {
        const invalid = await run(Session.Service.use(svc => svc.create()))
        // The delegated task uses the valid configured explore/main model;
        // validation must also cover the actual user-turn agent and model.
        await expect(run(SessionPrompt.Service.use(svc => svc.command({ sessionID: invalid.id, command: "title-delegated", arguments: "Must not initialize", ...actual })))).rejects.toThrow()
        expect(await run(Session.Service.use(svc => svc.get(invalid.id)))).toMatchObject({ title: "Untitled", titleRevision: 0 })
        expect(await run(Session.Service.use(svc => svc.messages({ sessionID: invalid.id })))).toHaveLength(0)
        await Bun.sleep(50)
        expect(requests).toBe(beforeInvalid)
        expect(titles).toHaveLength(3)
      }
    } })
  } finally { await server.stop(true) }
}, 30000)

test("source model threads through persisted prompt, command user model and historical recovery", async () => {
  const titles: { model: string; messages: unknown }[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json()
    const title = body.tools?.length === 1 && body.tools[0].function?.name === "StructuredOutput"
    if (title) titles.push(body)
    return new Response((title ? toolCallResponse({ id: "source-title", name: "StructuredOutput", args: JSON.stringify({ title: "Source summary" }) }) : textStopResponse("Done")).join(""), { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    await using tmp = await tmpdir({ git: true, config: {
      enabled_providers: ["fixture"], model: "fixture/other",
      provider: { fixture: { npm: "@ai-sdk/openai-compatible", env: [], options: { apiKey: "fixture", baseURL: `http://localhost:${server.port}/v1` }, models: Object.fromEntries(["source", "other", "task"].map(id => [id, { name: id, tool_call: true, limit: { context: 128000, output: 1000 }, modalities: { input: ["text"], output: ["text"] } }])) } },
      command: { regular: { template: "TEMPLATE $ARGUMENTS", model: "fixture/task" }, delegated: { template: "TEMPLATE $ARGUMENTS", agent: "explore", model: "fixture/task", subtask: true } },
    } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const run = AppRuntime.runPromise
      const source = { providerID: ProviderID.make("fixture"), modelID: ModelID.make("source") }
      const ordinary = await run(Session.Service.use(svc => svc.create()))
      const persisted = await run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: ordinary.id, noReply: true, model: source, parts: [{ type: "text", text: "Ordinary request" }] })))
      await until(() => titles.length === 1)
      expect(persisted.info.role === "user" && persisted.info.model).toEqual(source)
      expect(titles[0].model).toBe("source")
      for (const command of ["regular", "delegated"]) {
        const session = await run(Session.Service.use(svc => svc.create()))
        await run(SessionPrompt.Service.use(svc => svc.command({ sessionID: session.id, command, arguments: "Command request", model: "fixture/source" })))
        await until(() => titles.length === (command === "regular" ? 2 : 3))
        expect(titles.at(-1)?.model).toBe(command === "regular" ? "task" : "source")
        expect(JSON.stringify(titles.at(-1)?.messages)).not.toContain("TEMPLATE")
      }
      for (const entry of ["prompt", "command"] as const) {
        const session = await run(Session.Service.use(svc => svc.create()))
        Database.use(db => db.run(sql`CREATE TEMP TRIGGER reject_source_title BEFORE UPDATE OF title ON session WHEN NEW.title_source = 'fallback' BEGIN SELECT RAISE(ABORT, 'initial title fault'); END`))
        try {
          await run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: session.id, noReply: true, model: source, parts: [{ type: "text", text: "Historical first request" }] })))
          expect((await run(Session.Service.use(svc => svc.get(session.id)))).titleRevision).toBe(0)
        } finally { Database.use(db => db.run(sql`DROP TRIGGER reject_source_title`)) }
        if (entry === "prompt") await run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: session.id, noReply: true, model: { ...source, modelID: ModelID.make("other") }, parts: [{ type: "text", text: "Later request" }] })))
        else await run(SessionPrompt.Service.use(svc => svc.command({ sessionID: session.id, command: "regular", arguments: "Later command", model: "fixture/other" })))
        await until(() => titles.length === (entry === "prompt" ? 4 : 5))
        expect(titles.at(-1)?.model).toBe("source")
        expect(JSON.stringify(titles.at(-1)?.messages)).toContain("Historical first request")
        expect(JSON.stringify(titles.at(-1)?.messages)).not.toContain("Later")
      }
    } })
  } finally { await server.stop(true) }
}, 30000)

test("completed user turns do not automatically reconsider the title",  async () => {
  let reviews = 0
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json()
    const review = body.tools?.length === 1 && body.tools[0].function?.name === "StructuredOutput"
    if (review) reviews++
    const chunks = review
      ? toolCallResponse({ id: "review-result", name: "StructuredOutput", args: JSON.stringify({ title: "New queue task" }) })
      : textStopResponse("The task is now queue analysis.")
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
      const scheduled = await run(Session.Service.use(svc => svc.create()))
      await run(injectScheduledPrompt({ sessionID: scheduled.id, value: "Scheduled automated task", isMeta: false, origin: { kind: "cron", taskId: "fixture-task", kindOfTask: "cron" } }))
      expect(await run(Session.Service.use(svc => svc.get(scheduled.id)))).toMatchObject({ title: "Untitled", titleRevision: 0 })
      const scheduledMessages = await run(Session.Service.use(svc => svc.messages({ sessionID: scheduled.id })))
      expect(scheduledMessages.find(message => message.info.role === "user")?.parts).toMatchObject([{ type: "text", synthetic: true }])
      expect(reviews).toBe(0)
      const s = await run(Session.Service.use(svc => svc.create()))
      await run(Session.Service.use(svc => svc.setGeneratedTitle({ sessionID: s.id, title: "Original task", expectedRevision: 0 })))
      const turn = (text: string) => run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: s.id, model: { providerID: ProviderID.make("fixture"), modelID: ModelID.make("text") }, parts: [{ type: "text", text }] })))
      await turn("Switch to queue analysis")
      expect(reviews).toBe(0)
      await turn("Continue the queue analysis task")
      await Bun.sleep(100)
      expect((await run(Session.Service.use(svc => svc.get(s.id)))).title).toBe("Original task")
      expect(reviews).toBe(0)
    } })
  } finally { await server.stop(true) }
}, 30000)

test("ephemeral lite offers only StructuredOutput without reading files or persisting tool messages",  async () => {
  const captured: { messages: unknown[]; tools: { function: { name: string } }[] }[] = []
  let resource = ""
  const server = Bun.serve({ port: 0, async fetch(request) {
    captured.push(await request.json())
    return new Response(toolCallResponse({ id: "title-fixture", name: "StructuredOutput", args: JSON.stringify({ title: "Queue latency analysis" }) }).join(""), { headers: { "content-type": "text/event-stream" } })
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
      await run(SessionPrompt.Service.use(svc => svc.prompt({ sessionID: session.id, noReply: true, model: { providerID: ProviderID.make("fixture"), modelID: ModelID.make("text") }, parts: [{ type: "text", text: `Analyze [notes](${resource})` }, { type: "file", filename: "notes.txt", mime: "text/plain", url: pathToFileURL(resource).href }] })))
      await until(async () => (await run(Session.Service.use(svc => svc.get(session.id)))).titleSource === "generated")
      expect(captured).toHaveLength(1)
      expect(captured[0].tools.map(tool => tool.function.name)).toEqual(["StructuredOutput"])
      expect(JSON.stringify(captured[0].messages)).not.toContain("Queue latency comes from lock contention.")
      expect(await run(Session.Service.use(svc => svc.children(session.id)))).toHaveLength(0)
      const messages = await run(Session.Service.use(svc => svc.messages({ sessionID: session.id })))
      expect(messages).toHaveLength(1)
      expect(messages[0].info.role).toBe("user")

    } })
  } finally { await server.stop(true) }
}, 30000)
