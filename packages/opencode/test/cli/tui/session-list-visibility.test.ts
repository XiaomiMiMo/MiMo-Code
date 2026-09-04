import { afterEach, describe, expect, setDefaultTimeout } from "bun:test"
import { Effect, Layer } from "effect"

setDefaultTimeout(30_000)

import { Agent } from "../../../src/agent/agent"
import { Actor } from "../../../src/actor/spawn"
import { ActorRegistry } from "../../../src/actor/registry"
import { Bus } from "../../../src/bus"
import { Config } from "../../../src/config"
import { Git } from "../../../src/git"
import { Instance } from "../../../src/project/instance"
import { Provider } from "../../../src/provider"
import { Session } from "../../../src/session"
import { classifySession } from "../../../src/session/visibility"
import { SessionID } from "../../../src/session/schema"
import { Truncate } from "../../../src/tool"
import { Worktree } from "../../../src/worktree"
import * as CrossSpawnSpawner from "../../../src/effect/cross-spawn-spawner"
import { Log } from "../../../src/util"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const env = Layer.mergeAll(
  Session.defaultLayer,
  ActorRegistry.defaultLayer,
  Provider.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Bus.defaultLayer,
  Config.defaultLayer,
  Worktree.defaultLayer,
  Git.defaultLayer,
  Actor.defaultLayer,
)

const it = testEffect(env)

const DIALOG = new URL("../../../src/cli/cmd/tui/component/dialog-session-list.tsx", import.meta.url).pathname

/**
 * The populations the Sessions dialog has to tell apart, as the user actually
 * sees them. Both are children of the SAME parent, both were created by
 * `session.create({ parentID })`, and the only thing that separates them is the
 * actor row — which is exactly why the list may not discriminate on the title.
 *
 *   - orchestrator peer children (`actor/spawn.ts`, `mode: "peer"`) — the
 *     `Orchestrator` / `[topic:…]` rows in the user's list. MUST stay listed.
 *   - the checkpoint-writer host (`session/checkpoint.ts`, `mode: "subagent"`,
 *     `agent: "checkpoint-writer"`) — the `↳ checkpoint-writer: …` rows. MUST go.
 */
const scaffold = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const actorReg = yield* ActorRegistry.Service

  const root = yield* sessions.create({ title: "Orchestrator" })

  const registerPeer = (sessionID: string) =>
    actorReg.register({
      sessionID: SessionID.make(sessionID),
      actorID: sessionID,
      mode: "peer",
      agent: "build",
      description: "orchestrator child",
      contextMode: "none",
      contextWatermark: undefined,
      background: true,
      lifecycle: "persistent",
      tools: undefined,
    })

  // Titled exactly as the user's screenshot shows them.
  const topic = yield* sessions.create({
    parentID: root.id as SessionID,
    title: "[topic:memory-switch] memory 开关方案调研",
  })
  yield* registerPeer(topic.id)

  const plain = yield* sessions.create({
    parentID: root.id as SessionID,
    title: "build: 在 mimocode 引擎侧实现「memory 写入开关」",
  })
  yield* registerPeer(plain.id)

  // checkpoint.ts creates this with the title ALREADY set, before it registers
  // the actor row — which is how it reaches the TUI store via `session.updated`.
  const writerHost = yield* sessions.create({
    parentID: root.id as SessionID,
    title: "checkpoint-writer: Previous checkpoint: /Users/mi/.local/share/mimocode/memory/sessions/ses_x/checkpoint.md",
  })
  yield* actorReg.register({
    sessionID: writerHost.id as SessionID,
    actorID: "checkpoint-writer-1",
    mode: "subagent",
    agent: "checkpoint-writer",
    description: "writer",
    contextMode: "none",
    contextWatermark: undefined,
    background: true,
    lifecycle: "ephemeral",
    tools: undefined,
  })

  return { sessions, actorReg, root, topic, plain, writerHost }
})

/** The dialog reads rows out of the sync store; over the API that is listBySession. */
const rowsOf = (actorReg: ActorRegistry.Interface, sessionID: string) =>
  actorReg.listBySession(SessionID.make(sessionID)).pipe(
    Effect.map((rows) => rows.map((row) => ({ mode: row.mode, agent: row.agent }))),
  )

describe("the Sessions dialog lists orchestrator children and not machinery hosts", () => {
  it.live("admits orchestrator peer children (including [topic:…]) and refuses the writer host", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { actorReg, root, topic, plain, writerHost } = yield* scaffold

        const verdict = (s: { id: string; parentID?: string | null }) =>
          rowsOf(actorReg, s.id).pipe(Effect.map((rows) => classifySession(s, rows)))

        // ⚠️The regression this test exists for. These are user-visible sessions
        // the orchestrator created with `session create`; a filter that drops them
        // is worse than the bug it was written to fix.
        expect((yield* verdict(topic)).renderable).toBe(true)
        expect((yield* verdict(plain)).renderable).toBe(true)

        // The parent itself is a root and is listed without consulting rows.
        expect((yield* verdict(root)).renderable).toBe(true)

        const writer = yield* verdict(writerHost)
        expect(writer.renderable).toBe(false)
        if (!writer.renderable) expect(writer.reason).toContain("checkpoint-writer")
      }),
    ),
  )

  // The two populations differ ONLY by actor row: same parent, same creation call.
  // The writer's title is the one thing a tempting shortcut would key on, so the
  // titles are swapped here. If either verdict follows the title, the rule has
  // drifted and a user session named "checkpoint-writer: …" would vanish.
  it.live("the verdict follows the actor row, not the title", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const actorReg = yield* ActorRegistry.Service
        const root = yield* sessions.create({ title: "Orchestrator" })

        // Peer row wearing the writer's title.
        const decoy = yield* sessions.create({
          parentID: root.id as SessionID,
          title: "checkpoint-writer: Previous checkpoint: /tmp/decoy.md",
        })
        yield* actorReg.register({
          sessionID: decoy.id as SessionID,
          actorID: decoy.id,
          mode: "peer",
          agent: "build",
          description: "orchestrator child that named itself confusingly",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "persistent",
          tools: undefined,
        })

        // Writer row wearing a friendly topic title.
        const disguised = yield* sessions.create({
          parentID: root.id as SessionID,
          title: "[topic:memory-switch] memory 开关方案调研",
        })
        yield* actorReg.register({
          sessionID: disguised.id as SessionID,
          actorID: "checkpoint-writer-1",
          mode: "subagent",
          agent: "checkpoint-writer",
          description: "writer",
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "ephemeral",
          tools: undefined,
        })

        const verdict = (s: { id: string; parentID?: string | null }) =>
          rowsOf(actorReg, s.id).pipe(Effect.map((rows) => classifySession(s, rows)))

        expect((yield* verdict(decoy)).renderable).toBe(true)
        expect((yield* verdict(disguised)).renderable).toBe(false)
      }),
    ),
  )
})

// There is no Solid render harness for the dialog, so the wiring is asserted at
// the source level — the same reason and the same shape as the route guard's
// assertion in test/session/internal-session-prohibition.test.ts. Without this,
// deleting the filter would restore the bug while both behavioural tests above
// still passed, because they exercise classifySession rather than the dialog.
describe("the Sessions dialog wires the visibility predicate into its child arm", () => {
  it.live("filters children through classifySession", () =>
    Effect.promise(async () => {
      const src = await Bun.file(DIALOG).text()
      expect(src).toContain('from "@/session/visibility"')
      expect(src).toContain("classifySession(x, sync.data.actor?.[x.id]).renderable")
      // The root arm must stay unconditional and the child arm must be gated:
      // this is the exact expression, so a future edit that drops `listable(x)`
      // fails here.
      expect(src).toContain("x.parentID === undefined || (isChildOfCurrent(x) && listable(x))")
    }),
  )

  it.live("does not discriminate on the checkpoint-writer title", () =>
    Effect.promise(async () => {
      const src = await Bun.file(DIALOG).text()
      const code = src
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
        .join("\n")
      expect(code).not.toContain('"checkpoint-writer')
      expect(code).not.toContain("startsWith(")
    }),
  )
})
