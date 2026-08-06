import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { TaskRegistry } from "../../src/task/registry"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Actor } from "../../src/actor/spawn"
import { Git } from "../../src/git"
import { ReviewGate } from "../../src/session/review"
import { ReviewGateState } from "../../src/session/review-gate-state"
import { Config } from "../../src/config"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import type { AgentOutcome } from "../../src/actor/spawn"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  Bus.defaultLayer,
  Session.defaultLayer,
  TaskRegistry.defaultLayer,
  Git.defaultLayer,
  ReviewGateState.defaultLayer,
)

const it = testEffect(env)

function git(dir: string, args: string[]) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
  return r.stdout
}

/** Commits a file, then introduces an uncommitted change so `git diff` is non-empty. */
async function seedDirty(dir: string) {
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
  git(dir, ["add", "a.ts"])
  git(dir, ["commit", "-q", "-m", "seed"])
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 2\n")
}

/** Plain-object Actor fake passed as a parameter (shouldReenter takes deps as args). */
function fakeActor(outcome: AgentOutcome): Actor.Interface {
  return {
    spawn: () =>
      Effect.gen(function* () {
        const d = yield* Deferred.make<AgentOutcome>()
        yield* Deferred.succeed(d, outcome)
        return { actorID: "review-1", sessionID: SessionID.make("unused"), outcome: d }
      }),
    cancel: () => Effect.void,
    getForkContext: () => Effect.succeed(undefined),
  }
}

function lastUser(sessionID: SessionID) {
  return MessageV2.User.parse({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    agentID: "main",
    model: { providerID: "test", modelID: "test-model" },
  })
}

const cfg = { review: { auto: true, max_review_rounds: 3 } } as Config.Info

describe("ReviewGate.shouldReenter", () => {
  it.live("findings → returns true and injects a synthetic user turn", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedDirty(dir))
          const state = yield* ReviewGateState.Service
          const taskReg = yield* TaskRegistry.Service
          const gitSvc = yield* Git.Service
          const sessions = yield* Session.Service
          const sess = yield* sessions.create({ title: "R" })
          const actor = fakeActor({
            status: "success",
            structured: { findings: [{ file: "a.ts", severity: "high", title: "magic number", detail: "hard-coded" }] },
          } satisfies AgentOutcome)

          const reenter = yield* ReviewGate.shouldReenter({
            sessionID: sess.id,
            worktree: dir,
            agent: lastUser(sess.id).agentID ?? "main",
            lastUser: lastUser(sess.id),
            cfg,
            state,
            taskReg,
            git: gitSvc,
            actor,
            sessions,
          })

          expect(reenter).toBe(true)
          const msgs = yield* sessions.messages({ sessionID: sess.id })
          const synthetic = msgs.flatMap((m) => m.parts).filter((p) => p.type === "text" && p.synthetic === true)
          expect(synthetic.length).toBeGreaterThan(0)
          if (synthetic[0]?.type === "text") expect(synthetic[0].text).toContain("independent reviewer")
        }),
      { git: true },
    ),
  )

  it.live("no findings → returns false and injects nothing", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedDirty(dir))
          const state = yield* ReviewGateState.Service
          const taskReg = yield* TaskRegistry.Service
          const gitSvc = yield* Git.Service
          const sessions = yield* Session.Service
          const sess = yield* sessions.create({ title: "R" })
          const actor = fakeActor({ status: "success", structured: { findings: [] } } satisfies AgentOutcome)

          const reenter = yield* ReviewGate.shouldReenter({
            sessionID: sess.id,
            worktree: dir,
            agent: lastUser(sess.id).agentID ?? "main",
            lastUser: lastUser(sess.id),
            cfg,
            state,
            taskReg,
            git: gitSvc,
            actor,
            sessions,
          })

          expect(reenter).toBe(false)
          const msgs = yield* sessions.messages({ sessionID: sess.id })
          const synthetic = msgs.flatMap((m) => m.parts).filter((p) => p.type === "text" && p.synthetic === true)
          expect(synthetic.length).toBe(0)
        }),
      { git: true },
    ),
  )

  it.live("empty diff → returns false without spawning the reviewer", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // `git: true` fixture committed a root commit; no working-tree changes.
          const state = yield* ReviewGateState.Service
          const taskReg = yield* TaskRegistry.Service
          const gitSvc = yield* Git.Service
          const sessions = yield* Session.Service
          const sess = yield* sessions.create({ title: "R" })
          const actor = fakeActor({ status: "failure", error: "should never be called" } satisfies AgentOutcome)

          const reenter = yield* ReviewGate.shouldReenter({
            sessionID: sess.id,
            worktree: dir,
            agent: lastUser(sess.id).agentID ?? "main",
            lastUser: lastUser(sess.id),
            cfg,
            state,
            taskReg,
            git: gitSvc,
            actor,
            sessions,
          })

          expect(reenter).toBe(false)
        }),
      { git: true },
    ),
  )

  it.live("type name agent (e.g. 'build') on a dirty repo → returns false (gate needs the identity)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedDirty(dir))
          const state = yield* ReviewGateState.Service
          const taskReg = yield* TaskRegistry.Service
          const gitSvc = yield* Git.Service
          const sessions = yield* Session.Service
          const sess = yield* sessions.create({ title: "R" })
          const actor = fakeActor({
            status: "success",
            structured: { findings: [{ file: "a.ts", severity: "high", title: "magic number", detail: "hard-coded" }] },
          } satisfies AgentOutcome)

          // `lastUser.agent` is the agent TYPE name ("build"), NOT the identity
          // ("main"). ReviewGate.decide derives isMain from `agent === "main"`,
          // so passing the type name must fail closed — pinning the contract
          // that the wrapper MUST pass `agentID` (or "main").
          const reenter = yield* ReviewGate.shouldReenter({
            sessionID: sess.id,
            worktree: dir,
            agent: lastUser(sess.id).agent,
            lastUser: lastUser(sess.id),
            cfg,
            state,
            taskReg,
            git: gitSvc,
            actor,
            sessions,
          })

          expect(reenter).toBe(false)
        }),
      { git: true },
    ),
  )
})
