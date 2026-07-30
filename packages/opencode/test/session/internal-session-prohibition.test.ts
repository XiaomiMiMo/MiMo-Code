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
import { classifySession, classifyUnreadableActors, verifySessionRenderable } from "../../src/session/visibility"
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

  // REWRITTEN (second time). Was, at 0b458f634: "a child whose actor rows cannot
  // be read is still rendered — the prohibition fails open", whose first
  // assertion was `verifySessionRenderable(child, () => { throw }).renderable ===
  // true`. That single test asserted BOTH states at once, because
  // `.catch(() => undefined)` made a failed read arrive at the classifier as "no
  // rows" — so it pinned the collapse it was meant to describe.
  //
  // The fail-open evidence only ever covered rows that are genuinely ABSENT: all
  // 17 no-actor-row children in the live DB are real pre-registry
  // @explore/@general transcripts stored under `main`. It says nothing about rows
  // that exist and could not be READ, where the population is every child — 1304
  // of the 1504 live children carry a system-spawned row. So the two states are
  // now split across this test (absent, still fails open, assertions kept
  // verbatim) and the two that follow (unreadable, fails closed). Nothing was
  // relaxed: the `throw` case moved from asserting `renderable === true` to
  // asserting `renderable === false` plus a distinct reason.
  it.live("absent actor rows still fail open — a child with no rows renders", () =>
    Effect.sync(() => {
      expect(classifySession({ id: "ses_kid", parentID: "ses_root" }, undefined).renderable).toBe(true)
      expect(classifySession({ id: "ses_kid", parentID: "ses_root" }, []).renderable).toBe(true)
    }),
  )

  it.live("an UNREADABLE actor read is refused, and never with the prohibition's reason", () =>
    Effect.sync(() => {
      const verdict = classifyUnreadableActors({ id: "ses_kid", parentID: "ses_root" }, new Error("boom"))
      expect(verdict.renderable).toBe(false)
      if (!verdict.renderable) {
        expect(verdict.reason).toContain("ses_kid")
        // An operator has to be able to tell a broken read from the product
        // prohibition, so these two reasons must never converge.
        expect(verdict.reason).toContain("could not verify")
        expect(verdict.reason).not.toContain("runtime-spawned")
      }
      // A root is decided without reading rows at all, so an unreadable read
      // cannot make one unopenable. This is also what keeps the switch path — which
      // reads rows unconditionally — in step with the renderer, which returns
      // before it ever fetches.
      expect(classifyUnreadableActors({ id: "ses_root" }, new Error("boom")).renderable).toBe(true)
    }),
  )

  it.live("renderer path: a read that keeps failing is refused after exactly one retry", () =>
    Effect.gen(function* () {
      let attempts = 0
      const verdict = yield* Effect.promise(() =>
        verifySessionRenderable({ id: "ses_kid", parentID: "ses_root" }, async () => {
          attempts++
          throw new Error("network")
        }),
      )
      expect(verdict.renderable).toBe(false)
      if (!verdict.renderable) expect(verdict.reason).toContain("could not verify")
      // Bounded: one retry, not a loop. A gate that retries until it succeeds is a
      // gate that never closes.
      expect(attempts).toBe(2)
    }),
  )

  // The other half of the retry decision: failing closed must not punish the
  // transient blip the branch was narrowed to avoid, and the rows recovered by
  // the retry must be classified normally rather than as unverified.
  it.live("renderer path: one transient failure is retried, and the recovered rows decide", () =>
    Effect.gen(function* () {
      let attempts = 0
      const verdict = yield* Effect.promise(() =>
        verifySessionRenderable({ id: "ses_kid", parentID: "ses_root" }, async () => {
          attempts++
          if (attempts === 1) throw new Error("blip")
          return [{ mode: "subagent", agent: "checkpoint-writer" }]
        }),
      )
      expect(attempts).toBe(2)
      expect(verdict.renderable).toBe(false)
      if (!verdict.renderable) {
        expect(verdict.reason).toContain("checkpoint-writer")
        expect(verdict.reason).not.toContain("could not verify")
      }
    }),
  )

  it.live("the refusal is logged with the session id and the underlying error", () =>
    Effect.promise(async () => {
      // Log.init({ print: false }) opens a real file sink and Log.file() names it,
      // so the record is asserted rather than assumed. The swallowed catch this
      // replaced left no trace at all.
      await Log.init({ print: false })
      const logfile = Log.file()
      expect(logfile).not.toBe("")
      await verifySessionRenderable({ id: "ses_logged", parentID: "ses_root" }, async () => {
        throw new Error("actors-endpoint-exploded")
      })
      await Log.flush()
      const written = await Bun.file(logfile).text()
      expect(written).toContain("actor rows unreadable")
      expect(written).toContain("ses_logged")
      expect(written).toContain("actors-endpoint-exploded")
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
  // Source-level for the same reason as the wiring assertion above — no Solid
  // render harness — and additionally because what it pins is a property of the
  // SDK CALL, not of any function under test. Load-bearing: without
  // `throwOnError` this client RESOLVES `{ data: undefined }` on an HTTP error
  // (gen/client/client.gen.ts:167-177), so a 500 from /session/:id/actors reaches
  // classifySession as "this session has no rows" and renders. That reopens the
  // fail-open leak with visibility.ts completely untouched, which is why the
  // separation cannot be enforced in visibility.ts alone.
  it.live("the route's actor fetch rejects on an HTTP error rather than resolving undefined", () =>
    Effect.promise(async () => {
      const src = await Bun.file(
        new URL("../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url).pathname,
      ).text()
      const guardAt = src.indexOf("verifySessionRenderable(")
      expect(guardAt).toBeGreaterThan(-1)
      const call = src.slice(guardAt, src.indexOf("if (!verdict.renderable)", guardAt))
      expect(call).toContain("sdk.client.session")
      expect(call).toContain(".actors({ sessionID }, { throwOnError: true })")
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
  // The discriminator that keeps the two enforcement points in step for the NEW
  // state. `unregistered` is chosen deliberately: the test above publishes it when
  // the rows read cleanly (absent rows fail open), and this one refuses the very
  // same session when the read FAILS. If the two states were ever collapsed
  // again — by restoring a swallowing catch here or by handing the failure to
  // classifySession — this test would publish and go green.
  it.live("switch refuses when the actor rows cannot be READ, with the unverifiable reason", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { root, unregistered } = yield* scaffold
        const real = yield* ActorRegistry.Service
        // listBySession is typed as never-failing, so the only way it breaks is a
        // defect — exactly the shape Effect.catch cannot see and Effect.exit can.
        const broken = Layer.succeed(ActorRegistry.Service, {
          ...real,
          listBySession: () => Effect.die(new Error("actor_registry read failed")),
        })

        const seen: string[] = []
        const unsub = Bus.subscribe(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const result = yield* Effect.gen(function* () {
          const info = yield* SessionTool
          const tool = yield* info.init()
          return yield* tool.execute({ operation: { action: "switch", sessionID: unregistered.id } }, ctx(root.id))
        }).pipe(Effect.provide(broken))

        unsub()
        expect(seen).toEqual([])
        expect(result.title).toContain("Refused")
        expect(result.output).toContain("could not verify")
        // Not the prohibition's wording, so the model is not told a product rule
        // when what happened was a broken read.
        expect(result.output).not.toContain("runtime-spawned")
        // Still model-actionable: a silent no-op or a crashed tool call just makes
        // the model retry blind.
        expect(result.output).toContain("retry the switch")
        expect(result.output).toContain("session list")
      }),
    ),
  )

  // A root's verdict never depends on its rows, so an unreadable read must not make
  // one unopenable — and this path is the only one that can regress it, because
  // verifySessionRenderable returns before it fetches while switch reads rows
  // unconditionally.
  it.live("switch still publishes for a root when the actor rows cannot be read", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { root } = yield* scaffold
        const real = yield* ActorRegistry.Service
        const broken = Layer.succeed(ActorRegistry.Service, {
          ...real,
          listBySession: () => Effect.die(new Error("actor_registry read failed")),
        })

        const seen: string[] = []
        const unsub = Bus.subscribe(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const result = yield* Effect.gen(function* () {
          const info = yield* SessionTool
          const tool = yield* info.init()
          return yield* tool.execute({ operation: { action: "switch", sessionID: root.id } }, ctx(root.id))
        }).pipe(Effect.provide(broken))

        unsub()
        expect(seen).toEqual([root.id])
        expect(result.title).toContain("Switched to")
      }),
    ),
  )

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
