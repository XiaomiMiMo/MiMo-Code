import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ActorRegistry } from "../../src/actor/registry"
import { Agent } from "../../src/agent/agent"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Bus } from "../../src/bus"
import { Inbox } from "../../src/inbox"
import { InboxTable } from "../../src/inbox/inbox.sql"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Git } from "../../src/git"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Shell } from "../../src/shell/shell"
import { Database } from "../../src/storage"
import { Truncate } from "../../src/tool"
import { BashTool } from "../../src/tool/bash"
import * as BashPredict from "../../src/tool/bash-predict"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Slow-command prediction: static families classify without history, the
// timing store answers with a per-project median, and graceFor turns that
// estimate into the synchronous window before a background handoff. The
// integration case seeds history for a bare-name command (not a project
// path) so only prediction can grant it background eligibility, and seeds it
// above the grace window so only prediction can collapse the wait to the
// warmup.

afterEach(async () => {
  await Instance.disposeAll()
})

const base = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)

const it = testEffect(
  Layer.mergeAll(
    base,
    Inbox.layer.pipe(Layer.provide(base)),
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Git.defaultLayer,
  ),
)

const posix = process.platform !== "win32"
const pinnedShell = posix ? "/bin/sh" : process.env.COMSPEC || "cmd.exe"

// execute() infers its metadata from the classic (synchronous) branch, so the
// handoff-only fields need a narrow read rather than the union being widened.
const background = (metadata: unknown) => metadata as { running?: boolean; jobID?: string; exit?: number | null }

const pinShell = Effect.acquireRelease(
  Effect.sync(() => {
    const prev = process.env.SHELL
    process.env.SHELL = pinnedShell
    Shell.acceptable.reset()
    Shell.preferred.reset()
    return prev
  }),
  (prev) =>
    Effect.sync(() => {
      if (prev === undefined) delete process.env.SHELL
      else process.env.SHELL = prev
      Shell.acceptable.reset()
      Shell.preferred.reset()
    }),
)

const env = (key: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prev = process.env[key]
      process.env[key] = value
      return prev
    }),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env[key]
        else process.env[key] = prev
      }),
  )

const ctx = (sessionID: SessionID, messageID: MessageID) => ({
  sessionID,
  messageID,
  callID: "test-call",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

// Parent user message → assistant message → tool part, the FK order the part
// insert needs; the part starts "running" so the monitor's completion rewrite
// is what the assertions observe.
const seedToolPart = (sessions: Session.Interface, sessionID: SessionID, command: string) =>
  Effect.gen(function* () {
    const userID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: userID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderID.make("seed"), modelID: ModelID.make("seed") },
    } satisfies MessageV2.User)
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: userID,
      modelID: ModelID.make("seed"),
      providerID: ProviderID.make("seed"),
      mode: "primary",
      agent: "build",
      path: { cwd: Instance.worktree, root: Instance.worktree },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } satisfies MessageV2.Assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool",
      callID: "test-call",
      tool: "bash",
      state: {
        status: "running",
        input: { command, description: "predicted slow command" },
        time: { start: Date.now() },
      },
    } satisfies MessageV2.ToolPart)
    return messageID
  })

function until<A>(label: string, check: () => A | undefined) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = check()
      if (value !== undefined) return value
      yield* Effect.sleep("250 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
  })
}

const completedState = (messageID: MessageID) => {
  const found = MessageV2.parts(messageID).find((item) => item.type === "tool" && item.callID === "test-call")
  if (!found || found.type !== "tool" || found.state.status !== "completed") return undefined
  return found.state
}

const inboxRow = (sessionID: SessionID) =>
  Database.use((db) => db.select().from(InboxTable).all()).find(
    (row) => row.receiver_session_id === sessionID && row.receiver_actor_id === "main",
  )

// Unique fake project dirs keep record→estimate assertions on isolated keys —
// the store is shared through the preload path across the whole test process.
let unique = 0
const freshDir = () => path.join(os.tmpdir(), `bash-predict-${process.pid}-${unique++}`)

describe("tool.bash slow prediction", () => {
  test("classifies static slow families and skips fast ones", () => {
    expect(BashPredict.slowCommand("pytest")).toBe(true)
    expect(BashPredict.slowCommand("cargo build")).toBe(true)
    expect(BashPredict.slowCommand("bun run build")).toBe(true)
    expect(BashPredict.slowCommand("cd x && npm install")).toBe(true)
    expect(BashPredict.slowCommand("pytest | tee out")).toBe(true)
    expect(BashPredict.slowCommand("git status")).toBe(false)
    expect(BashPredict.slowCommand("bun --version")).toBe(false)
    expect(BashPredict.slowCommand("bun run dev")).toBe(false)
    expect(BashPredict.slowCommand('echo "run build"')).toBe(false)
    expect(BashPredict.slowCommand("npm ls")).toBe(false)
  })

  test("records samples and estimates the median per key", async () => {
    const dir = freshDir()
    await BashPredict.record(BashPredict.key(dir, "run build"), 1000)
    await BashPredict.record(BashPredict.key(dir, "run build"), 3000)
    await BashPredict.record(BashPredict.key(dir, "run build"), 2000)
    expect(await BashPredict.estimate(dir, "run build")).toBe(2000)
    // Other commands and other projects never leak into this history.
    expect(await BashPredict.estimate(dir, "other command")).toBeUndefined()
    expect(await BashPredict.estimate(freshDir(), "run build")).toBeUndefined()
  })

  test("keeps at most 20 samples per key, newest last", async () => {
    const dir = freshDir()
    for (let i = 0; i < 25; i++) await BashPredict.record(BashPredict.key(dir, "make"), 1000 + i)
    const timing = process.env.MIMOCODE_BASH_TIMING_PATH
    expect(timing).toBeDefined()
    const store = JSON.parse(await fs.readFile(timing!, "utf8")) as Record<string, { samples: number[] }>
    const samples = store[BashPredict.key(dir, "make")].samples
    expect(samples.length).toBe(20)
    expect(samples[0]).toBe(1005)
    expect(samples[19]).toBe(1024)
  })

  test("scales the grace window from the estimate", () => {
    const restore = [
      ["MIMOCODE_EXPERIMENTAL_BASH_JOB_GRACE_MS", process.env.MIMOCODE_EXPERIMENTAL_BASH_JOB_GRACE_MS],
      ["MIMOCODE_EXPERIMENTAL_BASH_PREDICT_WARMUP_MS", process.env.MIMOCODE_EXPERIMENTAL_BASH_PREDICT_WARMUP_MS],
    ] as const
    process.env.MIMOCODE_EXPERIMENTAL_BASH_JOB_GRACE_MS = "60000"
    process.env.MIMOCODE_EXPERIMENTAL_BASH_PREDICT_WARMUP_MS = "1000"
    try {
      expect(BashPredict.graceFor()).toBe(60000) // no history → the full grace
      expect(BashPredict.graceFor(120000)).toBe(1000) // at/above grace → warmup only
      expect(BashPredict.graceFor(30000)).toBe(30000) // in between → the estimate
      expect(BashPredict.graceFor(500)).toBe(1000) // below warmup → warmup floor
    } finally {
      for (const [key, prev] of restore) {
        if (prev === undefined) delete process.env[key]
        else process.env[key] = prev
      }
    }
  })

  it.live(
    "predicted-slow bare command hands off at the warmup window",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* pinShell
          yield* env("MIMOCODE_EXPERIMENTAL_BASH_PREDICT_SLOW_MS", "1000")
          yield* env("MIMOCODE_EXPERIMENTAL_BASH_PREDICT_WARMUP_MS", "100")
          const timingPath = path.join(dir, "timing.json")
          yield* env("MIMOCODE_BASH_TIMING_PATH", timingPath)
          const command = posix ? "sleep 5" : "ping -n 6 127.0.0.1 >nul"
          // Seed this project's history far above the grace window: only the
          // prediction can make a bare name backgroundable AND collapse the
          // synchronous wait to the 100 ms warmup.
          const projectKey = BashPredict.key(Instance.directory, command)
          yield* Effect.promise(() =>
            fs.writeFile(timingPath, JSON.stringify({ [projectKey]: { at: Date.now(), samples: [120000] } })),
          )
          const sessions = yield* Session.Service
          const info = yield* sessions.create({ title: "Test" })
          const messageID = yield* seedToolPart(sessions, info.id, command)
          const tool = yield* (yield* BashTool).init()

          const started = Date.now()
          const handoff = yield* tool.execute(
            { command, workdir: dir, description: "predicted slow command" },
            ctx(info.id, messageID),
          )
          const elapsed = Date.now() - started

          expect(handoff.output).toContain("handed off")
          expect(handoff.output).toContain("history predicts about 120000 ms")
          expect(background(handoff.metadata).running).toBe(true)
          expect(handoff.metadata.exit).toBeNull()
          // Sync would block for the full ~5 s sleep; the warmup handoff must
          // return well before that.
          expect(elapsed).toBeLessThan(4000)

          const state = yield* until("tool part completion", () => completedState(messageID))
          expect(state.metadata.exit).toBe(0)
          expect(typeof background(state.metadata).jobID).toBe("string")

          const row = yield* until("inbox row", () => inboxRow(info.id))
          const text = (row.content as { text?: string }).text ?? ""
          expect(text).toContain(`Command: ${command}`)
          expect(text).toContain("exit code 0")

          // finalize recorded the completed run alongside the seeded sample —
          // exactly once (phase-1 and monitor finalize are mutually exclusive).
          const store = JSON.parse(
            yield* Effect.promise(() => fs.readFile(timingPath, "utf8")),
          ) as Record<string, { samples: number[] }>
          const samples = store[projectKey].samples
          expect(samples.length).toBe(2)
          expect(samples[1]).toBeGreaterThanOrEqual(4000)
        }),
      ),
    60000,
  )
})
