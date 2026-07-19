import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ActorRegistry } from "../../src/actor/registry"
import { Log } from "../../src/util"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { makeLayer, providerCfg } from "../workflow/lib"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(makeLayer())

// I1 keystone: the runLoop must call ActorRegistry.updateTurn once per model
// step. Session.create auto-registers the ("main") actor row with turn_count=0
// and last_turn_time/time.updated pinned to registration. Without the per-step
// heartbeat the orchestrator cannot tell a progressing child from a stalled one
// (turnCount frozen at 0, timestamps frozen for the whole turn).
//
// Drive a 2-step turn (tool call → text) and assert the row's turn_count
// advanced past 0 and last_turn_time / time.updated moved forward from the
// values captured at registration.
it.live("runLoop emits a per-step turn heartbeat on the actor registry row", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const registry = yield* ActorRegistry.Service

      const session = yield* sessions.create({
        title: "turn heartbeat",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Snapshot the auto-registered main actor row before the turn runs.
      const before = yield* registry.get(session.id, "main")
      expect(before).toBeDefined()
      expect(before!.turnCount).toBe(0)
      const beforeTurnTime = before!.lastTurnTime
      const beforeUpdated = before!.time.updated

      // Force a multi-step loop: first step is a tool call (finish=tool-calls,
      // loop continues), second step produces final text (finish=stop).
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      yield* prompt.loop({ sessionID: session.id })
      // Two model steps ⇒ two LLM calls ⇒ two heartbeats.
      expect(yield* llm.calls).toBe(2)

      const after = yield* registry.get(session.id, "main")
      expect(after).toBeDefined()
      // turn_count is the strong signal: it only advances via updateTurn.
      expect(after!.turnCount).toBeGreaterThan(0)
      expect(after!.turnCount).toBe(2)
      // last_turn_time and time.updated advanced from registration.
      expect(after!.lastTurnTime).toBeGreaterThanOrEqual(beforeTurnTime)
      expect(after!.time.updated).toBeGreaterThanOrEqual(beforeUpdated)
      // Combined: at least one timestamp strictly moved forward past
      // registration, proving mid-flight progress was recorded.
      expect(after!.lastTurnTime + after!.time.updated).toBeGreaterThan(beforeTurnTime + beforeUpdated)
    }),
    { git: true, config: providerCfg },
  ),
)
