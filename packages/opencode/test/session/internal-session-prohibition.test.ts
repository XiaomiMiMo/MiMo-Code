import { afterEach, describe, expect, setDefaultTimeout } from "bun:test"
import { Effect, Layer } from "effect"

// Live tests: real sessions + the session tool's full layer stack.
setDefaultTimeout(30_000)

import { Agent } from "../../src/agent/agent"
import { Actor } from "../../src/actor/spawn"
import { ActorRegistry } from "../../src/actor/registry"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Git } from "../../src/git"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { Session } from "../../src/session"
import { classifySession, verifySessionRenderable } from "../../src/session/visibility"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool"
import { SessionTool } from "../../src/tool/session"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import { Worktree } from "../../src/worktree"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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

const ctx = (sessionID: string) => ({
  sessionID: SessionID.make(sessionID),
  messageID: MessageID.ascending(),
  agent: "build",
  actorID: "main",
  abort: new AbortController().signal,
  extra: {},
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

/**
 * Builds the five shapes that matter, exactly as they exist in the real DB:
 *   - peer child      → actor row keyed (session_id = child.id, actor_id = child.id), mode "peer"
 *   - writer host     → actor row keyed (session_id = child.id, actor_id = "checkpoint-writer-1"), mode "subagent"
 *   - ask fork        → tool/session.ts:128's forkQuery host: mode "subagent" whose
 *                       agent is the TARGET's agent ("build"), title `ask: …`
 *   - unregistered    → child session with no actor row at all (17 such children
 *                       exist in the live DB: pre-registry @explore/@general subagents)
 *   - writerRoot      → a ROOT that carries a checkpoint-writer row, because
 *                       before the writer got its own child session it registered
 *                       under the session it was checkpointing. One such root
 *                       exists in the live DB and it is a real conversation.
 */
const scaffold = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const actorReg = yield* ActorRegistry.Service

  const root = yield* sessions.create({ title: "root" })

  const peer = yield* sessions.create({ parentID: root.id as SessionID, title: "general: do a thing" })
  yield* actorReg.register({
    sessionID: peer.id as SessionID,
    actorID: peer.id,
    mode: "peer",
    agent: "general",
    description: "peer child",
    contextMode: "none",
    contextWatermark: undefined,
    background: false,
    lifecycle: "persistent",
    tools: undefined,
  })

  const writerHost = yield* sessions.create({ parentID: root.id as SessionID, title: "checkpoint-writer: root" })
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

  const askFork = yield* sessions.create({ parentID: root.id as SessionID, title: "ask: what is the status" })
  yield* actorReg.register({
    sessionID: askFork.id as SessionID,
    actorID: "build-1",
    mode: "subagent",
    agent: "build",
    description: "fork-query",
    contextMode: "full",
    contextWatermark: undefined,
    background: false,
    lifecycle: "ephemeral",
    tools: undefined,
  })

  const unregistered = yield* sessions.create({
    parentID: root.id as SessionID,
    title: "Explore codebase structure (@explore subagent)",
  })

  const writerRoot = yield* sessions.create({ title: "a real conversation that got checkpointed" })
  yield* actorReg.register({
    sessionID: writerRoot.id as SessionID,
    actorID: "checkpoint-writer-1",
    mode: "subagent",
    agent: "checkpoint-writer",
    description: "writer registered under the session it checkpointed",
    contextMode: "none",
    contextWatermark: undefined,
    background: true,
    lifecycle: "ephemeral",
    tools: undefined,
  })

  return { sessions, root, peer, writerHost, askFork, unregistered, writerRoot }
})

describe("runtime-spawned agent hosts are never rendered — the rule", () => {
  it.live("a root is renderable without consulting its actor rows at all", () =>
    Effect.gen(function* () {
      let asked = 0
      const verdict = yield* Effect.promise(() =>
        verifySessionRenderable({ id: "ses_root" }, async () => {
          asked++
          return []
        }),
      )
      expect(verdict.renderable).toBe(true)
      expect(asked).toBe(0)
    }),
  )

  it.live("parent_id arriving as SQL NULL is still a root (nullable-column rule)", () =>
    Effect.sync(() => {
      expect(classifySession({ id: "ses_root", parentID: null }, undefined).renderable).toBe(true)
    }),
  )

  // REWRITTEN, was: "an unverifiable child is refused — the prohibition fails
  // closed", asserting `renderable === false` and a reason containing "could not
  // verify". That assertion belonged to the previous criterion (renderable iff
  // root or present among the parent's `visible: true` children), where an
  // unreadable sibling list left the classifier with no evidence either way and
  // refusing was the safe default.
  //
  // The requirement changed with the criterion. The verdict is now read off the
  // session's OWN actor rows against SYSTEM_SPAWNED_AGENT_TYPES, and the only
  // population it must refuse — the checkpoint-writer host — provably cannot
  // present as "no rows" once it holds a message: spawnSubagent registers the row
  // (actor/spawn.ts:731) before forking the work that writes one (:762), the row
  // is ON DELETE CASCADE on the session, and 1302/1302 writer hosts in the live
  // DB carry it. Fail-closed, by contrast, refused all 17 live no-actor-row
  // children, every one of which is a real pre-registry @explore/@general
  // transcript stored under `main`. So the direction of error is deliberate:
  // over-refusing a real transcript is the costlier mistake and the one users hit.
  it.live("a child whose actor rows cannot be read is still rendered — the prohibition fails open", () =>
    Effect.gen(function* () {
      const thrown = yield* Effect.promise(() =>
        verifySessionRenderable({ id: "ses_kid", parentID: "ses_root" }, async () => {
          throw new Error("network")
        }),
      )
      expect(thrown.renderable).toBe(true)
      expect(classifySession({ id: "ses_kid", parentID: "ses_root" }, undefined).renderable).toBe(true)
      expect(classifySession({ id: "ses_kid", parentID: "ses_root" }, []).renderable).toBe(true)
    }),
  )

  it.live("dream and distill are refused for the same reason as checkpoint-writer", () =>
    Effect.sync(() => {
      for (const agent of ["checkpoint-writer", "dream", "distill"]) {
        const verdict = classifySession({ id: "ses_kid", parentID: "ses_root" }, [{ mode: "subagent", agent }])
        expect(verdict.renderable).toBe(false)
        if (!verdict.renderable) expect(verdict.reason).toContain(agent)
      }
    }),
  )

  // Ordering matters, not just membership: a peer child that RAN a system agent
  // must stay renderable, so the peer arm has to be reached before the agent set.
  it.live("a peer row wins over a system-spawned row on the same session", () =>
    Effect.sync(() => {
      expect(
        classifySession({ id: "ses_kid", parentID: "ses_root" }, [
          { mode: "peer", agent: "general" },
          { mode: "subagent", agent: "checkpoint-writer" },
        ]).renderable,
      ).toBe(true)
    }),
  )
})

describe("runtime-spawned agent hosts are never rendered — renderer path", () => {
  it.live("refuses only the checkpoint-writer host; admits root, peer, ask fork and unregistered child", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { root, peer, writerHost, askFork, unregistered, writerRoot } = yield* scaffold
        const actorReg = yield* ActorRegistry.Service

        // The renderer resolves the verdict from the session's own actor rows,
        // which over the SDK is GET /session/:id/actors → listBySession.
        const fetchActors = (sessionID: string) =>
          Effect.runPromise(
            actorReg
              .listBySession(sessionID as SessionID)
              .pipe(Effect.map((rows) => rows.map((r) => ({ mode: r.mode, agent: r.agent })))) as Effect.Effect<
              { mode: string; agent: string }[]
            >,
          )

        const check = (info: { id: string; parentID?: string }) =>
          Effect.promise(() => verifySessionRenderable(info, fetchActors))

        expect((yield* check(root)).renderable).toBe(true)
        expect((yield* check(peer)).renderable).toBe(true)

        const writerVerdict = yield* check(writerHost)
        expect(writerVerdict.renderable).toBe(false)
        if (!writerVerdict.renderable) {
          expect(writerVerdict.reason).toContain(writerHost.id)
          expect(writerVerdict.reason).toContain("checkpoint-writer")
        }

        // The narrowing. Both of these were refused by the previous criterion:
        // neither owns a mode:"peer" row, so neither appeared among its parent's
        // visible children. Both are real transcripts.
        expect((yield* check(askFork)).renderable).toBe(true)
        expect((yield* check(unregistered)).renderable).toBe(true)

        // A root is never classified by its actor rows, so the real conversation
        // that carries a checkpoint-writer row stays renderable.
        expect((yield* check(writerRoot)).renderable).toBe(true)
      }),
    ),
  )

  // There is no Solid render harness for the session route, so the wiring of the
  // guard into the route effect is asserted at the source level. Narrow on
  // purpose: it pins only that the refusal runs, and runs before the transcript
  // is synced. Without it, deleting the guard block in index.tsx would break the
  // prohibition while every behavioural test above still passed.
  it.live("the session route wires the guard in before it syncs the transcript", () =>
    Effect.promise(async () => {
      const src = await Bun.file(
        new URL("../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url).pathname,
      ).text()
      const guardAt = src.indexOf("verifySessionRenderable(")
      const syncAt = src.indexOf("sync.session.sync(route.sessionID)")
      expect(guardAt).toBeGreaterThan(-1)
      expect(syncAt).toBeGreaterThan(-1)
      expect(guardAt).toBeLessThan(syncAt)
    }),
  )
})

describe("runtime-spawned agent hosts are never rendered — session tool switch path", () => {
  it.live("switch refuses a checkpoint-writer host without publishing SessionSelect", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { root, writerHost } = yield* scaffold

        const seen: string[] = []
        const unsub = Bus.subscribe(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ operation: { action: "switch", sessionID: writerHost.id } }, ctx(root.id))

        unsub()
        expect(seen).toEqual([])
        expect(result.title).toContain("Refused")
        expect(result.output).toContain("checkpoint-writer")
        // The refusal must be actionable for the model mid-turn.
        expect(result.output).toContain("session list")
      }),
    ),
  )

  // REWRITTEN, was: "switch refuses an unregistered child fork without
  // publishing", asserting `seen === []` and a "Refused" title. Same criterion
  // change as the fail-open rewrite above — a child with no actor row is no
  // longer machinery by default, so `switch` must now move the UI there. Kept as
  // a test rather than deleted because it is the discriminator for the two
  // enforcement points staying in step: if only the renderer had been narrowed,
  // the model would still be refused here and the UI would still be reachable
  // by -s, which is the split the shared helper exists to prevent.
  it.live("switch now publishes for an unregistered child and for an ask fork", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { root, unregistered, askFork } = yield* scaffold

        const seen: string[] = []
        const unsub = Bus.subscribe(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const info = yield* SessionTool
        const tool = yield* info.init()
        const bare = yield* tool.execute({ operation: { action: "switch", sessionID: unregistered.id } }, ctx(root.id))
        const ask = yield* tool.execute({ operation: { action: "switch", sessionID: askFork.id } }, ctx(root.id))

        unsub()
        expect(seen).toEqual([unregistered.id, askFork.id])
        expect(bare.title).toContain("Switched to")
        expect(ask.title).toContain("Switched to")
      }),
    ),
  )

  it.live("switch refuses an id with no session row without publishing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { root } = yield* scaffold

        const seen: string[] = []
        const unsub = Bus.subscribe(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: { action: "switch", sessionID: "ses_doesnotexist" } },
          ctx(root.id),
        )

        unsub()
        expect(seen).toEqual([])
        expect(result.output).toContain("no such session")
      }),
    ),
  )

  it.live("switch still publishes for a peer child and for a root", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { root, peer } = yield* scaffold

        const seen: string[] = []
        const unsub = Bus.subscribe(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const info = yield* SessionTool
        const tool = yield* info.init()
        const peerResult = yield* tool.execute({ operation: { action: "switch", sessionID: peer.id } }, ctx(root.id))
        const rootResult = yield* tool.execute({ operation: { action: "switch", sessionID: root.id } }, ctx(root.id))

        unsub()
        expect(seen).toEqual([peer.id, root.id])
        expect(peerResult.title).toContain("Switched to")
        expect(rootResult.title).toContain("Switched to")
      }),
    ),
  )

  // The switch path is where classifySession's OWN root guard is load-bearing:
  // it calls the helper unconditionally with listBySession's rows, whereas
  // verifySessionRenderable returns early for a root and never fetches any. So
  // only this test fails if the agent-set check is moved above the root guard —
  // and getting that wrong refuses a real user conversation, which is what the
  // one such root in the live DB is.
  it.live("switch still publishes for a root that carries a checkpoint-writer row", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { root, writerRoot } = yield* scaffold

        const seen: string[] = []
        const unsub = Bus.subscribe(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ operation: { action: "switch", sessionID: writerRoot.id } }, ctx(root.id))

        unsub()
        expect(seen).toEqual([writerRoot.id])
        expect(result.title).toContain("Switched to")
      }),
    ),
  )
})
