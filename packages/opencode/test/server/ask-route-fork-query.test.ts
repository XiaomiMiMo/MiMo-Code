import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Plugin } from "../../src/plugin"
import { Agent } from "../../src/agent/agent"
import { Session as SessionNs } from "../../src/session"
import { Provider } from "../../src/provider"
import { ProviderTest } from "../fake/provider"
import { Log } from "../../src/util"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { forkQuery } from "../../src/tool/session"

void Log.init({ print: false })

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
)

const env = Layer.mergeAll(SessionNs.defaultLayer, CrossSpawnSpawner.defaultLayer, deps)

const it = testEffect(env)

// The POST /:sessionID/ask route is a thin wrapper over forkQuery (the same
// frozen-snapshot, read-only fork-query the session tool's `ask` verb uses).
// This asserts forkQuery is exported and its no-activity early-return path
// works without spawning a fork or touching an LLM: a brand-new session with
// no main-slice user message has nothing to snapshot, so forkQuery answers
// directly. The full LLM-backed path is covered in session-tool.test.ts.
describe("forkQuery (backing the /:sessionID/ask route)", () => {
  it.live(
    "returns a graceful answer for a session with no activity",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const provider = yield* Provider.Service
        const info = yield* sessions.create({})

        const answer = yield* forkQuery(
          // actor is never reached on the no-activity path; the early return
          // fires before any spawn, so a stub interface is sufficient here.
          { sessions, provider, actor: {} as never },
          info.id,
          "what is this session about?",
        )

        expect(answer).toContain("no activity")
      }),
    ),
  )
})
