import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ToolRegistry } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { ProviderID, ModelID } from "../../src/provider/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { SessionID, MessageID } from "../../src/session/schema"
import { viewExecSubtools } from "../../src/tool/tool-script"

const it = testEffect(
  Layer.mergeAll(ToolRegistry.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

describe("ToolRegistry.tools: invocation style resolution", () => {
  it.live("reads video and audio through the Codex exec gateway and preserves their attachments", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(12)])
        const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(24)])
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "clip.mp4"), bytes))
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "clip.wav"), wav))
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const model = ProviderTest.model({
          id: ModelID.make("model"),
          providerID: ProviderID.make("test"),
          api: { id: "model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
          capabilities: {
            ...ProviderTest.model().capabilities,
            input: { text: true, image: false, audio: true, video: true, pdf: false },
          },
        })
        const defs = yield* reg.tools({
          providerID: model.providerID,
          modelID: model.id,
          agent: yield* agents.get("build"),
          harness: "codex",
        })
        const exec = defs.find((tool) => tool.id === "exec")!
        expect(exec.description).toContain("watch_video(input:")
        expect(exec.description).toContain("listen_audio(input:")
        const result = yield* exec.execute(
          {
            code: 'return await Promise.all([tools.watch_video({ path: "clip.mp4" }), tools.listen_audio({ path: "clip.wav" })])',
          },
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            callID: "call_test",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            extra: { model, harness: "codex" },
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        expect(result.output).toContain("Video read successfully")
        expect(result.output).toContain("Audio read successfully")
        const video = viewExecSubtools(result.metadata).find((part) => part.tool === "watch_video")
        expect(video?.state.status).toBe("completed")
        expect(video?.state.attachments).toEqual([
          {
            type: "file",
            mime: "video/mp4",
            filename: "clip.mp4",
            url: `data:video/mp4;base64,${bytes.toString("base64")}`,
          },
        ])
        const audio = viewExecSubtools(result.metadata).find((part) => part.tool === "listen_audio")
        expect(audio?.state.status).toBe("completed")
        expect(audio?.state.attachments).toEqual([
          {
            type: "file",
            mime: "audio/wav",
            filename: "clip.wav",
            url: `data:audio/wav;base64,${wav.toString("base64")}`,
          },
        ])
      }),
    ),
  )

  it.live("advertises only exec in Codex mode while keeping hidden tools registered", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("openai/gpt-5.4"),
          agent: build,
        })
        const registered = yield* reg.registered({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("openai/gpt-5.4"),
          agent: build,
        })
        const ids = tools.map((tool) => tool.id)
        const nested = [
          "bash",
          "apply_patch",
          "view_image",
          "watch_video",
          "listen_audio",
          "actor",
          "task",
          "question",
          "webfetch",
          "skill_search",
          "skill",
          "plan_exit",
          "memory",
          "history",
          "cron",
        ]

        expect(ids).toEqual(["exec"])
        expect(registered.map((tool) => tool.id)).toContain("webfetch")
        expect(registered.map((tool) => tool.id)).toContain("watch_video")
        expect(registered.map((tool) => tool.id)).toContain("listen_audio")
        nested.forEach((id) => expect(ids).not.toContain(id))

        const description = tools.find((tool) => tool.id === "exec")?.description ?? ""
        expect(description).toContain("webfetch(input:")
        nested.filter((id) => id !== "bash").forEach((id) => expect(description).toContain(`${id}(input:`))
        expect(description).toContain("exec_command(input:")
        expect(description).not.toContain("\n  bash(input:")
        expect(description).toContain("`timeout` is always measured in milliseconds")
      }),
    ),
  )

  it.live("uses the harness rather than MiMo API transport to select the toolset", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        const normalDefault = yield* reg.tools({
          providerID: ProviderID.make("xiaomi"),
          modelID: ModelID.make("mimo-v2.6"),
          agent: build,
        })
        const responsesDefault = yield* reg.tools({
          providerID: ProviderID.make("xiaomi"),
          modelID: ModelID.make("mimo-v2.6-ptc"),
          agent: build,
        })
        const normalCodex = yield* reg.tools({
          providerID: ProviderID.make("xiaomi"),
          modelID: ModelID.make("mimo-v2.6"),
          agent: build,
          harness: "codex",
        })
        const responsesCodex = yield* reg.tools({
          providerID: ProviderID.make("xiaomi"),
          modelID: ModelID.make("mimo-v2.6-ptc"),
          agent: build,
          harness: "codex",
        })

        expect(normalDefault.map((tool) => tool.id)).toContain("bash")
        expect(normalDefault.map((tool) => tool.id)).not.toContain("exec")
        expect(normalDefault.map((tool) => tool.id)).not.toContain("watch_video")
        expect(normalDefault.map((tool) => tool.id)).not.toContain("listen_audio")
        expect(responsesDefault.map((tool) => tool.id)).toContain("bash")
        expect(responsesDefault.map((tool) => tool.id)).not.toContain("exec")
        expect(normalCodex.map((tool) => tool.id)).toEqual(["exec"])
        expect(responsesCodex.map((tool) => tool.id)).toEqual(["exec"])
      }),
    ),
  )

  it.live.skip("exposes exec by default only to GPT models", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        if (!general) throw new Error("no general agent")
        const ids = (modelID: string) =>
          reg
            .tools({
              providerID: ProviderID.opencode,
              modelID: ModelID.make(modelID),
              agent: general,
            })
            .pipe(Effect.map((tools) => tools.map((tool) => tool.id)))

        const gpt = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("openai/gpt-5.4"),
          agent: general,
        })
        const exec = gpt.find((tool) => tool.id === "exec")
        expect(exec).toBeDefined()
        expect(exec?.description).toContain("Run independent calls with `Promise.all` or `Promise.allSettled`")
        expect(exec?.description).toContain("keep dependent operations sequential")
        expect(exec?.description).toContain("do not use `exec` merely to force concurrency")
        expect(exec?.description).toContain("apply_patch(input:")
        expect(exec?.description).toContain("exec_command(input:")
        expect(exec?.description).not.toContain("\n  bash(input:")
        expect(exec?.description).not.toContain("read(input:")
        expect(exec?.description).not.toContain("write(input:")
        expect(exec?.description).not.toContain("edit(input:")
        expect(yield* ids("anthropic/claude-sonnet-4-6")).not.toContain("exec")
        expect(yield* ids("mimo-v2")).not.toContain("exec")
      }),
    ),
    30000,
  )

  it.live.skip("keeps skill_search registered but hidden for GPT models", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        if (!general) throw new Error("no general agent")
        const ids = (modelID: string) =>
          reg
            .tools({
              providerID: ProviderID.opencode,
              modelID: ModelID.make(modelID),
              agent: general,
            })
            .pipe(Effect.map((tools) => tools.map((tool) => tool.id)))

        expect(yield* ids("openai/gpt-5.4")).not.toContain("skill_search")
        expect(yield* ids("anthropic/claude-sonnet-4-6")).toContain("skill_search")
        expect(yield* ids("mimo-v2")).toContain("skill_search")
      }),
    ),
  )

  it.live.skip("uses the filesystem-capable bash description for GPT models", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        if (!general) throw new Error("no general agent")
        const tools = yield* reg.tools({
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-5"),
          agent: general,
        })
        const bash = tools.find((tool) => tool.id === "bash")
        expect(bash?.description).toContain("the dedicated `read`, `write`, and `edit` tools are unavailable")
        expect(bash?.description).toContain("Use `apply_patch`")
        expect(bash?.description).not.toContain("DO NOT use it for file operations")
        expect(tools.some((tool) => tool.id === "notebook_edit")).toBeFalse()
        expect(tools.some((tool) => tool.id === "grep")).toBeFalse()
        expect(tools.some((tool) => tool.id === "glob")).toBeFalse()
      }),
    ),
  )

  it.live("keeps the specialized-tool bash description for non-GPT models", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        if (!general) throw new Error("no general agent")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: general,
        })
        const bash = tools.find((tool) => tool.id === "bash")
        expect(bash?.description).toContain("DO NOT use it for file operations")
        expect(bash?.description).not.toContain("the dedicated `read`, `write`, and `edit` tools are unavailable")
        expect(tools.find((tool) => tool.id === "skill_search")?.description).not.toContain("first query")
        expect(tools.some((tool) => tool.id === "notebook_edit")).toBeTrue()
        expect(tools.some((tool) => tool.id === "grep")).toBeTrue()
        expect(tools.some((tool) => tool.id === "glob")).toBeTrue()
      }),
    ),
  )

  it.live.skip("masks multiedit for GPT models", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(dir, ".mimocode/tool"), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".mimocode/tool/multiedit.ts"),
            [
              "export default {",
              "  description: 'multi-edit files',",
              "  args: {},",
              "  execute: async () => 'done',",
              "}",
            ].join("\n"),
          ),
        )
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        if (!general) throw new Error("no general agent")
        const ids = (modelID: string) =>
          reg
            .tools({
              providerID: ProviderID.opencode,
              modelID: ModelID.make(modelID),
              agent: general,
            })
            .pipe(Effect.map((tools) => tools.map((tool) => tool.id)))

        expect(yield* ids("openai/gpt-5.4")).not.toContain("multiedit")
        expect(yield* ids("anthropic/claude-sonnet-4-6")).toContain("multiedit")
      }),
    ),
    30000,
  )

  it.live("default config keeps task in JSON mode", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const reg = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        if (!general) throw new Error("no general agent")
        const tools = yield* reg.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("opencode/claude-sonnet-4-6"),
          agent: general,
        })
        const task = tools.find((t) => t.id === "task")
        expect(task).toBeDefined()
        // JSON mode → parameters is an object wrapping an `operation` discriminated
        // union (discriminator "action"). Confirm `operation` is present and `script`
        // (the shell-mode shape) is not.
        const schema = task!.parameters as any
        expect(schema.shape?.operation ?? schema._def?.shape?.operation).toBeDefined()
        expect(schema.shape?.script ?? schema._def?.shape?.script).toBeUndefined()
      }),
    ),
  )

  it.live(
    "invocationStyleByTool.task='shell' replaces parameters with { script } once shell field exists",
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const reg = yield* ToolRegistry.Service
            const agents = yield* Agent.Service
            const general = yield* agents.get("general")
            if (!general) throw new Error("no general agent")
            const tools = yield* reg.tools({
              providerID: ProviderID.opencode,
              modelID: ModelID.make("opencode/claude-sonnet-4-6"),
              agent: general,
            })
            const task = tools.find((t) => t.id === "task")
            expect(task).toBeDefined()
            // Task has shell field (Task 13 added it). Shell mode is active: parameters has `script`.
            const schema = task!.parameters as any
            expect(schema.shape?.script ?? schema._def?.shape?.script).toBeDefined()
            expect(schema.shape?.action ?? schema._def?.shape?.action).toBeUndefined()
          }),
        { config: { tool: { invocation_style_by_tool: { task: "shell" } } } },
      ),
  )

  it.live("invocationStyleByTool.read='shell' falls back to JSON (read has no shell field)", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const reg = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const general = yield* agents.get("general")
          if (!general) throw new Error("no general agent")
          const tools = yield* reg.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("opencode/claude-sonnet-4-6"),
            agent: general,
          })
          const read = tools.find((t) => t.id === "read")
          expect(read).toBeDefined()
          const schema = read!.parameters as any
          // Original `read` parameters has file_path; shell wrap would expose `script`
          expect(schema.shape?.file_path ?? schema._def?.shape?.file_path).toBeDefined()
          expect(schema.shape?.script ?? schema._def?.shape?.script).toBeUndefined()
        }),
      { config: { tool: { invocation_style_by_tool: { read: "shell" } } } },
    ),
  )
})

describe("ToolRegistry.tools: shell mode end-to-end on task", () => {
  it.live("task shell-mode resolves to shellInputSchema parameters and shell description", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const reg = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const general = yield* agents.get("general")
          if (!general) throw new Error("no general agent")
          const tools = yield* reg.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("opencode/claude-sonnet-4-6"),
            agent: general,
          })
          const task = tools.find((t) => t.id === "task")!
          // Sanity: parameters is shellInputSchema (just `script`)
          const parsed = task.parameters.parse({ script: "task list" })
          expect(parsed).toEqual({ script: "task list" })
          // Description starts with the task.shell.txt header
          expect(task.description).toContain("Persistent work-item tool (shell form)")
          // Description is NOT the JSON-mode task.txt
          expect(task.description).not.toContain('"action": "create"')
        }),
      { config: { tool: { invocation_style_by_tool: { task: "shell" } } } },
    ),
  )
})
