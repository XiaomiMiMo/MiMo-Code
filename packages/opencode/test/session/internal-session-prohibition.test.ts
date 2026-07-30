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
 * Builds the three shapes that matter, exactly as they exist in the real DB:
 *   - peer child      → actor row keyed (session_id = child.id, actor_id = child.id), mode "peer"
 *   - writer host     → actor row keyed (session_id = child.id, actor_id = "checkpoint-writer-1"), mode "subagent"
 *   - unregistered    → child session with no actor row at all (ask-tool fork window)
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

  const unregistered = yield* sessions.create({ parentID: root.id as SessionID, title: "ask fork" })

  return { sessions, root, peer, writerHost, unregistered }
})

describe("internal-machinery sessions are never rendered — the rule", () => {
  it.live("a root is renderable without consulting siblings at all", () =>
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

  it.live("an unverifiable child is refused — the prohibition fails closed", () =>
    Effect.gen(function* () {
      const thrown = yield* Effect.promise(() =>
        verifySessionRenderable({ id: "ses_kid", parentID: "ses_root" }, async () => {
          throw new Error("network")
        }),
      )
      expect(thrown.renderable).toBe(false)
      const missing = classifySession({ id: "ses_kid", parentID: "ses_root" }, undefined)
      expect(missing.renderable).toBe(false)
      if (!missing.renderable) expect(missing.reason).toContain("could not verify")
    }),
  )
})

describe("internal-machinery sessions are never rendered — renderer path", () => {
  it.live("refuses a checkpoint-writer host and an unregistered fork, admits root and peer", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { sessions, root, peer, writerHost, unregistered } = yield* scaffold

        // The renderer resolves siblings through exactly the hiding layer the
        // session list uses: Session.children(parentID, { visible: true }).
        const fetchVisible = (parentID: string) =>
          Effect.runPromise(
            sessions
              .children(parentID as SessionID, { visible: true })
              .pipe(Effect.map((rows) => rows.map((r) => ({ id: r.id })))) as Effect.Effect<{ id: string }[]>,
          )

        const check = (info: { id: string; parentID?: string }) =>
          Effect.promise(() => verifySessionRenderable(info, fetchVisible))

        expect((yield* check(root)).renderable).toBe(true)
        expect((yield* check(peer)).renderable).toBe(true)

        const writerVerdict = yield* check(writerHost)
        expect(writerVerdict.renderable).toBe(false)
        if (!writerVerdict.renderable) {
          expect(writerVerdict.reason).toContain(writerHost.id)
          expect(writerVerdict.reason).toContain("internal session")
        }

        expect((yield* check(unregistered)).renderable).toBe(false)
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

describe("internal-machinery sessions are never rendered — session tool switch path", () => {
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
        expect(result.output).toContain("internal session")
        // The refusal must be actionable for the model mid-turn.
        expect(result.output).toContain("session list")
      }),
    ),
  )

  it.live("switch refuses an unregistered child fork without publishing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { root, unregistered } = yield* scaffold

        const seen: string[] = []
        const unsub = Bus.subscribe(TuiEvent.SessionSelect, (event) => seen.push(event.properties.sessionID))

        const info = yield* SessionTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ operation: { action: "switch", sessionID: unregistered.id } }, ctx(root.id))

        unsub()
        expect(seen).toEqual([])
        expect(result.title).toContain("Refused")
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
})
