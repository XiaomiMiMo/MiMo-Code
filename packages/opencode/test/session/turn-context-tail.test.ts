import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session as SessionNs } from "../../src/session"
import { appendTurnContext, LLM, turnContextMessages } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ProviderTransform } from "../../src/provider"
import { ToolRegistry } from "../../src/tool"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import type { Agent } from "../../src/agent/agent"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(
    SessionNs.defaultLayer,
    LLM.defaultLayer,
    ToolRegistry.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

function makeUser(system?: string, systemMode?: MessageV2.User["systemMode"]): MessageV2.User {
  return {
    id: MessageID.ascending(),
    sessionID: SessionID.make("ses_turncontext"),
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    system,
    systemMode,
  } as unknown as MessageV2.User
}

const agent = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
} satisfies Agent.Info

describe("turnContextMessages", () => {
  it.effect("absent, empty and whitespace-only per-turn context add nothing", () =>
    Effect.sync(() => {
      expect(turnContextMessages(makeUser())).toEqual([])
      expect(turnContextMessages(makeUser(""))).toEqual([])
      expect(turnContextMessages(makeUser("   \n  "))).toEqual([])
    }),
  )

  it.effect("per-turn context becomes a trailing user message wrapped in system-reminder", () =>
    Effect.sync(() => {
      const messages = turnContextMessages(makeUser("## Current date and time\nlocal time 17:58."))
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe("user")
      expect(messages[0].content).toBe(
        "<system-reminder>\n## Current date and time\nlocal time 17:58.\n</system-reminder>",
      )
    }),
  )

  it.effect("last-step context merges into the control user message", () =>
    Effect.sync(() => {
      const result = appendTurnContext([{ role: "user", content: "MAX_STEPS" }], makeUser("clock"), true)
      expect(result).toEqual([{
        role: "user",
        content: "MAX_STEPS\n\n<system-reminder>\nclock\n</system-reminder>",
      }])
    }),
  )

  it.effect("replace-agent system never becomes a trailing user reminder", () =>
    Effect.sync(() => {
      const user = makeUser("replacement system", "replace-agent")
      expect(turnContextMessages(user)).toEqual([])
      expect(appendTurnContext([{ role: "user", content: "question" }], user, true)).toEqual([
        { role: "user", content: "question" },
      ])
    }),
  )
})

describe("Anthropic cache tail", () => {
  it.effect("marks only the historical tail and appended context segment", () =>
    Effect.sync(() => {
    const model = ProviderTest.model({
      providerID: ProviderID.make("anthropic"),
      id: ModelID.make("claude-sonnet-4"),
      api: { id: "claude-sonnet-4", url: "https://example.com", npm: "@ai-sdk/anthropic" },
    })
    const result = ProviderTransform.message([
      { role: "system", content: "stable system" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      ...turnContextMessages(makeUser("## Current date and time\nlocal time 17:58.")),
    ] as any[], model, {}) as any[]
    const marked = result.filter((message) => message.providerOptions?.anthropic?.cacheControl)
    expect(marked).toHaveLength(3)
    expect(marked.map((message) => message.content)).toEqual([
      "stable system",
      "old answer",
      "<system-reminder>\n## Current date and time\nlocal time 17:58.\n</system-reminder>",
    ])
    }),
  )
})

describe("system prefix stability across turns", () => {
  // Two consecutive turns whose ONLY difference is the client-supplied per-turn
  // context — exactly what a minute-precision client clock produces. The
  // system prefix must not move, or the provider's prefix cache is invalidated
  // for the entire conversation sitting behind it.
  it.live("a changed per-turn context leaves the system prefix byte-identical", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const llm = yield* LLM.Service
          const session = yield* sessions.create({})
          const model = ProviderTest.model({
            id: ModelID.make("gpt-5.2"),
            providerID: ProviderID.make("openai"),
          })

          const build = (clock: string) =>
            llm.buildSystemArray({
              agent,
              model,
              system: ["# Environment\nstable across turns"],
              user: makeUser(`## Current date and time\nlocal time ${clock}.`),
              sessionID: session.id,
            })

          const first = yield* build("17:57")
          const second = yield* build("17:58")

          expect(second).toEqual(first)
          expect(first.join("\n")).not.toContain("17:57")
          expect(first.join("\n")).toContain("stable across turns")
        }),
      { git: true },
    ),
  )
})
