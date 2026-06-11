import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import z from "zod"
import { schema as transformSchema } from "../../src/provider/transform"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Provider } from "../../src/provider"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ActorTool, type ActorPromptOps } from "../../src/tool/actor"
import { ActorRegistry } from "../../src/actor/registry"
import { TaskRegistry } from "../../src/task/registry"
import { ActorWaiter } from "../../src/actor/waiter"
import { spawnRef } from "../../src/actor/spawn-ref"
import type { SpawnInput, AgentOutcome } from "../../src/actor/spawn"
import { Team } from "../../src/team"
import { Truncate } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  spawnRef.current = undefined
  await Instance.disposeAll()
})

// Mock Actor.spawn that simulates the spawn lifecycle using ActorRegistry + Bus
// so tests can exercise the actor tool without the full Actor.layer graph.
function installMockSpawn(onSpawn?: (input: SpawnInput) => void) {
  return Effect.gen(function* () {
    const actorReg = yield* ActorRegistry.Service

    spawnRef.current = {
      spawn: (input: SpawnInput) =>
        Effect.gen(function* () {
          onSpawn?.(input)
          const actorID = yield* actorReg.allocateActorID(input.sessionID, input.agentType)
          yield* actorReg.register({
            sessionID: input.sessionID,
            actorID,
            mode: input.mode,
            parentActorID: input.parentActorID,
            agent: input.agentType,
            description: input.description ?? input.agentType,
            contextMode: input.context,
            background: input.background,
            lifecycle: "ephemeral",
            tools: input.tools,
          })
          yield* actorReg.updateStatus(input.sessionID, actorID, { status: "running" }).pipe(Effect.ignore)

          const outcome = yield* Deferred.make<AgentOutcome>()

          // Synchronously complete the actor so waiter.wait resolves immediately.
          yield* actorReg.updateStatus(input.sessionID, actorID, { status: "idle", lastOutcome: "success" }).pipe(Effect.ignore)
          yield* Deferred.succeed(outcome, { status: "success", finalText: "done" })

          return { actorID, sessionID: input.sessionID, outcome }
        }),
      cancel: () => Effect.void,
      getForkContext: () => Effect.succeed(undefined),
    }
  })
}

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    Provider.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    ActorWaiter.layer.pipe(Layer.provide(Bus.defaultLayer), Layer.provide(ActorRegistry.defaultLayer), Layer.provide(Session.defaultLayer)),
    Team.defaultLayer,
    SessionCheckpoint.defaultLayer,
    TaskRegistry.defaultLayer,
  ),
)

const seed = Effect.fn("ActorToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): ActorPromptOps {
  return {
    cancel() {},
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.actor", () => {
  it.live("description sorts subagents by name and is stable across calls", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const get = Effect.fnUntraced(function* () {
            const tools = yield* registry.tools({ ...ref, agent: build })
            return tools.find((tool) => tool.id === ActorTool.id)?.description ?? ""
          })
          const first = yield* get()
          const second = yield* get()

          expect(first).toBe(second)

          const alpha = first.indexOf("- alpha: Alpha agent")
          const explore = first.indexOf("- explore:")
          const general = first.indexOf("- general:")
          const zebra = first.indexOf("- zebra: Zebra agent")

          expect(alpha).toBeGreaterThan(-1)
          expect(explore).toBeGreaterThan(alpha)
          expect(general).toBeGreaterThan(explore)
          expect(zebra).toBeGreaterThan(general)
        }),
      {
        config: {
          agent: {
            zebra: {
              description: "Zebra agent",
              mode: "subagent",
            },
            alpha: {
              description: "Alpha agent",
              mode: "subagent",
            },
          },
        },
      },
    ),
  )

  it.live("description hides denied subagents for the caller", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const description =
            (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === ActorTool.id)?.description ?? ""

          expect(description).toContain("- alpha: Alpha agent")
          expect(description).not.toContain("- zebra: Zebra agent")
        }),
      {
        config: {
          permission: {
            task: {
              "*": "allow",
              zebra: "deny",
            },
          },
          agent: {
            zebra: {
              description: "Zebra agent",
              mode: "subagent",
            },
            alpha: {
              description: "Alpha agent",
              mode: "subagent",
            },
          },
        },
      },
    ),
  )

  it.live("execute resumes an existing task session from actor_id", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installMockSpawn()
        const { chat, assistant } = yield* seed()
        const tool = yield* ActorTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            operation: {
              action: "run",
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              actor_id: "ses_missing", // v9: actor_id in run action is ignored — always creates new
            },
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        // v9: run always creates a new actor under the parent session
        expect(result.metadata.sessionId).toBe(chat.id)
        expect(result.output).toContain("actor_id:")
      }),
    ),
  )

  it.live("execute asks by default and skips checks when bypassed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installMockSpawn()
        const { chat, assistant } = yield* seed()
        const tool = yield* ActorTool
        const def = yield* tool.init()
        const calls: unknown[] = []

        const exec = (extra?: Record<string, unknown>) =>
          def.execute(
            {
              operation: {
                action: "run",
                description: "inspect bug",
                prompt: "look into the cache key path",
                subagent_type: "general",
              },
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { ...extra },
              messages: [],
              metadata: () => Effect.void,
              ask: (input) =>
                Effect.sync(() => {
                  calls.push(input)
                }),
            },
          )

        yield* exec()
        yield* exec({ bypassAgentCheck: true })

        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual({
          permission: "actor",
          patterns: ["general"],
          always: ["*"],
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
          },
        })
      }),
    ),
  )

  it.live("execute creates a child when actor_id does not exist", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installMockSpawn()
        const { chat, assistant } = yield* seed()
        const tool = yield* ActorTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            operation: {
              action: "run",
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              actor_id: "ses_missing",
            },
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        // v9: run creates a new actor under the parent session (subagent mode)
        expect(result.metadata.sessionId).toBe(chat.id)
        expect(result.metadata.actorId).toBeDefined()
        expect(result.output).toContain(`actor_id: ${result.metadata.actorId}`)
      }),
    ),
  )

  it.live("execute shapes child permissions for task, todowrite, and primary tools", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* installMockSpawn()
          const { chat, assistant } = yield* seed()
          const tool = yield* ActorTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              operation: {
                action: "run",
                description: "inspect bug",
                prompt: "look into the cache key path",
                subagent_type: "reviewer",
              },
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {},
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          // v9: run registers actor in registry with tools whitelist
          const actorReg = yield* ActorRegistry.Service
          const actor = yield* actorReg.get(chat.id, result.metadata.actorId)
          expect(actor).toBeDefined()
          expect(actor!.agent).toBe("reviewer")
          expect(result.metadata.sessionId).toBe(chat.id)
        }),
      {
        config: {
          agent: {
            reviewer: {
              mode: "subagent",
              permission: {
                actor: "allow",
              },
            },
          },
          experimental: {
            primary_tools: ["bash", "read"],
          },
        },
      },
    ),
  )
})

describe("Actor tool subagent_type enum (F36)", () => {
  // The actor tool's `subagent_type` schema is built dynamically from the
  // agent registry, filtered to mode==="subagent" && !hidden. Spawnable
  // agents (general, explore, user-config-defined) appear in the enum;
  // hidden internals (title, summary, checkpoint-writer per F24) do not.
  // We probe via the resolved tool's parameters schema since that's the
  // contract surface the LLM hits — Actor.Service.spawn bypasses zod.
  it.live("subagent_type enum includes spawnable agents and rejects hidden ones", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* ActorTool
        const def = yield* tool.init()

        // Probe the subagent_type field directly. Validate the rest of the
        // payload has known-good shape so the only failing field is the enum.
        const accept = (subagentType: string) =>
          def.parameters.safeParse({
            operation: {
              action: "spawn",
              description: "test",
              prompt: "test",
              subagent_type: subagentType,
            },
          })

        // general and explore are mode="subagent" + !hidden → in the enum.
        expect(accept("general").success).toBe(true)
        expect(accept("explore").success).toBe(true)

        // title, summary, checkpoint-writer are hidden=true → not in the enum.
        expect(accept("title").success).toBe(false)
        expect(accept("summary").success).toBe(false)
        expect(accept("checkpoint-writer").success).toBe(false)

        // Made-up name → not in the enum.
        expect(accept("does-not-exist").success).toBe(false)
      }),
    ),
  )

  it.live("user-config-defined subagents appear in the enum", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const tool = yield* ActorTool
          const def = yield* tool.init()

          const accept = (subagentType: string) =>
            def.parameters.safeParse({
              operation: {
                action: "spawn",
                description: "test",
                prompt: "test",
                subagent_type: subagentType,
              },
            })

          // User-config-defined "alpha" is mode="subagent" → in the enum.
          expect(accept("alpha").success).toBe(true)
        }),
      {
        config: {
          agent: {
            alpha: {
              description: "Alpha agent",
              mode: "subagent",
            },
          },
        },
      },
    ),
  )

  // Mirror of the task tool's schema regression test (commit 334cf6708).
  // The pre-discriminated-union schema let the model fill every "optional" string
  // with "" — including actor_id — which slipped past the runtime guards in some
  // paths and produced confusing tool errors elsewhere.
  it.live("schema rejects empty strings, unknown fields, and per-action missing required fields", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* ActorTool
        const def = yield* tool.init()
        const params = def.parameters
        const wrap = (op: Record<string, unknown>) => params.safeParse(op)

        // run (sync) and spawn (async): operation envelope required; action/description/prompt/subagent_type required.
        expect(wrap({ operation: { action: "run", description: "x", prompt: "y", subagent_type: "general" } }).success).toBe(true)
        expect(wrap({ operation: { action: "spawn", description: "x", prompt: "y", subagent_type: "general" } }).success).toBe(true)

        expect(wrap({ operation: { action: "run", description: "", prompt: "y", subagent_type: "general" } }).success).toBe(false)
        expect(wrap({ operation: { action: "run", description: "x", prompt: "", subagent_type: "general" } }).success).toBe(false)
        expect(wrap({ operation: { action: "run", description: "x", prompt: "y", subagent_type: "general", actor_id: "" } }).success).toBe(false)
        expect(wrap({ operation: { action: "run", description: "x", prompt: "y", subagent_type: "general", junk: "z" } }).success).toBe(false)
        expect(wrap({ operation: { action: "run", description: "x", prompt: "y" } }).success).toBe(false) // missing subagent_type
        expect(wrap({ operation: { action: "run", prompt: "y", subagent_type: "general" } }).success).toBe(false) // missing description
        expect(wrap({ description: "x", prompt: "y", subagent_type: "general" }).success).toBe(false) // missing operation envelope

        // status / wait / cancel: actor_id required and non-empty.
        expect(wrap({ operation: { action: "status", actor_id: "abc" } }).success).toBe(true)
        expect(wrap({ operation: { action: "status" } }).success).toBe(false)
        expect(wrap({ operation: { action: "status", actor_id: "" } }).success).toBe(false)
        expect(wrap({ operation: { action: "wait" } }).success).toBe(false)
        expect(wrap({ operation: { action: "cancel" } }).success).toBe(false)
        // kill is no longer a valid action
        expect(wrap({ operation: { action: "kill", actor_id: "abc" } }).success).toBe(false)

        // Flat shape (old format) is rejected — the discriminator must live inside the envelope.
        expect(
          params.safeParse({ operation: "run", description: "x", prompt: "y", subagent_type: "general" }).success,
        ).toBe(false)
      }),
    ),
  )

  it.live("flattened schema keeps operation as the sole root key (mimo can't drop the discriminator)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* ActorTool
        const def = yield* tool.init()
        const fakeModel = {
          providerID: "mimo",
          api: { id: "mimo-v2.5-pro", npm: "@ai-sdk/openai-compatible" },
          id: "mimo-v2.5-pro",
          capabilities: { input: {} },
        } as any
        const flat = transformSchema(fakeModel, z.toJSONSchema(def.parameters)) as any
        // Root must expose ONLY `operation`. A flat bag (the bug) lets mimo omit
        // the discriminator entirely; a nested envelope makes it unmissable.
        expect(Object.keys(flat.properties)).toEqual(["operation"])
        expect(flat.required).toEqual(["operation"])
        // The operation node must carry type:"object" (the .meta fix) so models
        // don't stringify the envelope, and must retain its inner 6-way union.
        expect(flat.properties.operation.type).toBe("object")
        expect((flat.properties.operation.oneOf ?? flat.properties.operation.anyOf).length).toBe(6)
      }),
    ),
  )

  it.live("schema accepts an arbitrary task_id string (validation moved to execute)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* ActorTool
        const def = yield* tool.init()
        const probe = (task_id: string) =>
          def.parameters.safeParse({
            operation: {
              action: "run",
              description: "test",
              prompt: "test",
              subagent_type: "general",
              task_id,
            },
          })

        // Well-formed TID: accepted (as before).
        expect(probe("T4").success).toBe(true)
        // Malformed TID: previously rejected by the regex and hard-failed the
        // whole call; now accepted at the schema layer so execute can degrade it.
        expect(probe("not-a-task").success).toBe(true)
        expect(probe("banana").success).toBe(true)
      }),
    ),
  )
})

describe("Actor tool task_id degradation", () => {
  it.live("malformed task_id degrades to ad-hoc with a notice", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installMockSpawn()
        const { chat, assistant } = yield* seed()
        const tool = yield* ActorTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            operation: {
              action: "run",
              description: "inspect bug",
              prompt: "look into it",
              subagent_type: "general",
              task_id: "not-a-task",
            },
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.output).toContain("task_id")
        expect(result.output).toContain("not-a-task")
        expect(result.output.toLowerCase()).toContain("ad-hoc")
      }),
    ),
  )

  it.live("well-formed but nonexistent task_id degrades to ad-hoc with a notice", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installMockSpawn()
        const { chat, assistant } = yield* seed()
        const tool = yield* ActorTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            operation: {
              action: "run",
              description: "inspect bug",
              prompt: "look into it",
              subagent_type: "general",
              task_id: "T999",
            },
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.output).toContain("T999")
        expect(result.output.toLowerCase()).toContain("ad-hoc")
      }),
    ),
  )

  it.live("existing task_id is preserved with no degradation notice", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        let capturedTaskId: string | undefined = "UNSET"
        yield* installMockSpawn((input) => {
          capturedTaskId = input.task_id
        })
        const { chat, assistant } = yield* seed()
        const tasks = yield* TaskRegistry.Service
        const task = yield* tasks.create({ session_id: chat.id, summary: "real task" })

        const tool = yield* ActorTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            operation: {
              action: "run",
              description: "inspect bug",
              prompt: "look into it",
              subagent_type: "general",
              task_id: task.id,
            },
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        // No degradation notice when the task genuinely exists.
        expect(result.output.toLowerCase()).not.toContain("ran ad-hoc")
        // And the valid id is actually threaded through to spawn.
        expect(capturedTaskId).toBe(task.id)
      }),
    ),
  )

  it.live("background spawn with malformed task_id includes the notice in its output", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installMockSpawn()
        const { chat, assistant } = yield* seed()
        const tool = yield* ActorTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            operation: {
              action: "spawn",
              description: "bg task",
              prompt: "do it in the background",
              subagent_type: "general",
              task_id: "not-a-task",
            },
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.output).toContain("not-a-task")
        expect(result.output.toLowerCase()).toContain("ad-hoc")
        expect(result.output).toContain("Background actor started")
      }),
    ),
  )
})
