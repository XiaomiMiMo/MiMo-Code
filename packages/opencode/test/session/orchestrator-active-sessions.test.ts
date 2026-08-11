import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Stream, ManagedRuntime, Layer } from "effect"
import { LLM, ROSTER_HEADER, ROSTER_IDLE_LIMIT } from "../../src/session/llm"
import { ActorRegistry } from "../../src/actor/registry"
import { Session as SessionNs } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

// e2e BEHAVIOR tests for the orchestrator's fleet roster.
//
// These are not prompt-text assertions. Each test drives the REAL LLM layer
// (LLM.defaultLayer) against a local HTTP provider, with real Session rows and
// real ActorRegistry peer rows in the real DB, and then inspects the actual
// request body that was sent to the model. The assertion target is the
// assembled system prompt on the wire — i.e. what the orchestrator model
// actually gets to see and route on — not the contents of orchestrator.txt.
//
// Harness pattern is the one already used by llm-system-prompt.test.ts: a
// Bun.serve provider stub, a queued capture per request, real Instance/DB.

type Capture = { url: URL; headers: Headers; body: Record<string, unknown> }

const queueState = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => (result.resolve = resolve))
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  queueState.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] })}`,
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] })}`,
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, any>>(fixturePath)
  const provider = data[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return { provider, model }
}

beforeAll(() => {
  queueState.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = queueState.queue.shift()
      if (!next) return new Response("unexpected request", { status: 500 })
      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })
      if (!url.pathname.endsWith(next.path)) return new Response("not found", { status: 404 })
      return next.response
    },
  })
})

beforeEach(() => {
  queueState.queue.length = 0
})

afterAll(() => {
  void queueState.server?.stop()
})

const PROVIDER_ID = "alibaba"
const MODEL_ID = "qwen-plus"

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.getModel(providerID, modelID)
    }),
  )
}

function makeBaseUser(sessionID: SessionID, modelID: ModelID): MessageV2.User {
  return {
    id: MessageID.make("user-orch-roster"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "orchestrator",
    model: { providerID: ProviderID.make(PROVIDER_ID), modelID },
  } satisfies MessageV2.User
}

// The real orchestrator Agent.Info: same prompt object the agent registry hands
// out (src/agent/agent.ts imports the identical orchestrator.txt module), so the
// system prompt assembly under test is the production path. Built directly here
// because the registry entry is gated behind MIMOCODE_EXPERIMENTAL_ORCHESTRATOR,
// which is resolved at module load and cannot be flipped from inside the test.
function orchestratorAgent(): Agent.Info {
  return {
    name: "orchestrator",
    mode: "primary",
    prompt: PROMPT_ORCHESTRATOR,
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
}

function plainAgent(name: string): Agent.Info {
  return {
    name,
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
}

function tmpConfig(baseURL: string) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [PROVIDER_ID],
    provider: {
      [PROVIDER_ID]: { options: { apiKey: "test-key", baseURL } },
    },
  })
}

/** A real parent session plus real peer children, each with a real registry row. */
type Child = { id: SessionID; title: string }

// The roster no longer carries an XML envelope (see ROSTER_HEADER in
// session/llm.ts: the literal `<active-sessions>` tag was what users saw echoed
// into the TUI, so it was removed rather than prohibited). ROSTER_HEADER is
// imported from the source of truth so this extractor cannot drift from it, and
// the rows run to the end of the pushed block.
function rosterBlock(sys: string): string {
  const open = sys.lastIndexOf(ROSTER_HEADER)
  if (open === -1) return ""
  return sys.slice(open)
}

async function seedFleet(
  children: Array<{
    title: string
    agent: string
    /** Finished cleanly (lastOutcome: "success") — idle but still resumable. */
    terminal?: boolean
    /** Explicit terminal outcome; overrides `terminal`. */
    outcome?: "success" | "failure" | "cancelled"
  }>,
) {
  const sessionRt = ManagedRuntime.make(SessionNs.defaultLayer)
  let parentID: SessionID
  const created: Child[] = []
  try {
    parentID = await sessionRt.runPromise(
      SessionNs.Service.use((svc) => svc.create({ title: "orchestrator parent" })).pipe(
        Effect.map((info) => info.id),
      ),
    )
    for (const spec of children) {
      const info = await sessionRt.runPromise(
        SessionNs.Service.use((svc) => svc.create({ parentID, title: spec.title })),
      )
      created.push({ id: info.id, title: info.title })
    }
  } finally {
    await sessionRt.dispose()
  }

  // Register each child as a PEER actor using the production convention:
  // session_id === actor_id === child session id, parent_actor_id === "main".
  const regRt = ManagedRuntime.make(ActorRegistry.defaultLayer)
  try {
    for (const [index, spec] of children.entries()) {
      const child = created[index]!
      await regRt.runPromise(
        ActorRegistry.Service.use((svc) =>
          svc.register({
            sessionID: child.id,
            actorID: child.id,
            mode: "peer",
            parentActorID: "main",
            agent: spec.agent,
            description: spec.title,
            contextMode: "none",
            background: true,
            lifecycle: "persistent",
          }),
        ),
      )
      const outcome = spec.outcome ?? (spec.terminal ? "success" : undefined)
      await regRt.runPromise(
        ActorRegistry.Service.use((svc) =>
          outcome
            ? svc.updateStatus(child.id, child.id, { status: "idle", lastOutcome: outcome })
            : svc.updateStatus(child.id, child.id, { status: "running" }),
        ),
      )
    }
  } finally {
    await regRt.dispose()
  }

  return { parentID: parentID!, children: created }
}

/** Run one real orchestrator turn and return the system prompt that hit the wire. */
async function captureSystemPrompt(input: { sessionID: SessionID; agent: Agent.Info; modelID: string }) {
  const request = waitRequest(
    "/chat/completions",
    new Response(createChatStream("ok"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  )
  const resolved = await getModel(ProviderID.make(PROVIDER_ID), ModelID.make(input.modelID))
  const rt = ManagedRuntime.make(Layer.mergeAll(LLM.defaultLayer))
  try {
    await rt.runPromise(
      LLM.Service.use((svc) =>
        svc
          .stream({
            user: makeBaseUser(input.sessionID, resolved.id),
            sessionID: input.sessionID,
            model: resolved,
            agent: input.agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "CI is red on PR 42." }],
            tools: {},
          })
          .pipe(Stream.runDrain),
      ),
    )
  } finally {
    await rt.dispose()
  }
  const capture = await request
  const messages = capture.body.messages as Array<{ role: string; content: string }>
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n")
}

describe("orchestrator fleet roster — e2e on the wire", () => {
  test("live peer children appear in the roster the orchestrator model receives", async () => {
    const server = queueState.server!
    const fixture = await loadFixture(PROVIDER_ID, MODEL_ID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(`${server.url.origin}/v1`))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fleet = await seedFleet([
          { title: "fix flaky CI", agent: "build" },
          { title: "refactor router", agent: "plan" },
        ])
        const sys = await captureSystemPrompt({
          sessionID: fleet.parentID,
          agent: orchestratorAgent(),
          modelID: fixture.model.id,
        })

        // The roster block is really injected into the request, not just
        // described by the prompt file.
        expect(sys).toContain(ROSTER_HEADER)
        // And the internal-scaffolding tag the model used to echo into the TUI is
        // not in the assembled request at all, so it cannot be echoed.
        expect(sys).not.toContain("<active-sessions>")

        // Every live child is addressable: its session id is on the wire, so
        // `session send <id>` is a route the model can actually take.
        for (const child of fleet.children) expect(sys).toContain(child.id)

        // And the roster carries the routing signal documented in
        // orchestrator.txt: title (what the child owns) + liveness.
        expect(sys).toContain("fix flaky CI")
        expect(sys).toContain("refactor router")
        expect(sys).toMatch(/progressing|stalled|idle/)
      },
    })
  })

  // DEFECT 1 — was: "terminal children are filtered out of the roster", which
  // seeded lastOutcome:"success" and asserted the child was ABSENT. That test
  // encoded the defect: `success` means "its last turn finished cleanly", not
  // "the session is gone", so it dropped every child the moment it did its job.
  // The legitimate half of that intent — genuinely dead children stay out — is
  // preserved below against failure/cancelled, which is what "dead" really is.
  test("failed and cancelled children are excluded from the roster", async () => {
    const server = queueState.server!
    const fixture = await loadFixture(PROVIDER_ID, MODEL_ID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(`${server.url.origin}/v1`))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fleet = await seedFleet([
          { title: "still working", agent: "build" },
          { title: "blew up", agent: "build", outcome: "failure" },
          { title: "torn down", agent: "build", outcome: "cancelled" },
        ])
        const sys = await captureSystemPrompt({
          sessionID: fleet.parentID,
          agent: orchestratorAgent(),
          modelID: fixture.model.id,
        })

        const [live, failed, cancelled] = [fleet.children[0]!, fleet.children[1]!, fleet.children[2]!]
        const block = rosterBlock(sys)
        expect(block).toContain(live.id)
        expect(block).not.toContain(failed.id)
        expect(block).not.toContain(cancelled.id)
      },
    })
  })

  test("DEFECT 1: a child that finished cleanly stays routable, labelled idle", async () => {
    const server = queueState.server!
    const fixture = await loadFixture(PROVIDER_ID, MODEL_ID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(`${server.url.origin}/v1`))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // The exact production shape after a successful turn (actor/turn.ts
        // writes status:"idle" + lastOutcome:"success"). This child is a
        // persistent peer: `session send` resumes it, same id, history intact.
        const fleet = await seedFleet([{ title: "owns the docs topic", agent: "build", terminal: true }])
        const sys = await captureSystemPrompt({
          sessionID: fleet.parentID,
          agent: orchestratorAgent(),
          modelID: fixture.model.id,
        })

        const done = fleet.children[0]!
        expect(sys).toContain(ROSTER_HEADER)
        const block = rosterBlock(sys)
        // Routable: the id the model needs for `session send` is on the wire.
        expect(block).toContain(done.id)
        expect(block).toContain("owns the docs topic")
        // Honest status: reported as idle, never as progressing.
        expect(block).toContain(`${done.id} | owns the docs topic | build | idle`)
        expect(block).not.toContain("progressing")
      },
    })
  })

  test("DEFECT 1: the resumable-idle tail is bounded so the block cannot grow without limit", async () => {
    const server = queueState.server!
    const fixture = await loadFixture(PROVIDER_ID, MODEL_ID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(`${server.url.origin}/v1`))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const finished = Array.from({ length: ROSTER_IDLE_LIMIT + 4 }, (_, i) => ({
          title: `finished ${i}`,
          agent: "build",
          terminal: true,
        }))
        const fleet = await seedFleet([{ title: "still working", agent: "build" }, ...finished])
        const sys = await captureSystemPrompt({
          sessionID: fleet.parentID,
          agent: orchestratorAgent(),
          modelID: fixture.model.id,
        })

        const block = rosterBlock(sys)
        const idleLines = block.split("\n").filter((l) => l.trim().endsWith("| idle"))
        expect(idleLines.length).toBe(ROSTER_IDLE_LIMIT)
        // The running child is never displaced by the idle tail.
        expect(block).toContain(fleet.children[0]!.id)
      },
    })
  })

  test("DEFECT 3: the roster's emitted format matches the format the prompt documents", async () => {
    const server = queueState.server!
    const fixture = await loadFixture(PROVIDER_ID, MODEL_ID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(`${server.url.origin}/v1`))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // agent "plan" is deliberately != the actor MODE, which is always "peer"
        // for a child. Field 3 must be the agent — that is the routing signal —
        // and the documented format must say so, on the SAME request.
        const fleet = await seedFleet([{ title: "refactor router", agent: "plan" }])
        const sys = await captureSystemPrompt({
          sessionID: fleet.parentID,
          agent: orchestratorAgent(),
          modelID: fixture.model.id,
        })

        const child = fleet.children[0]!
        const block = rosterBlock(sys)
        // What the code EMITS: field 3 is the agent, not "peer".
        expect(block).toContain(`${child.id} | refactor router | plan | `)
        expect(block).not.toContain("| peer |")
        // What the prompt DOCUMENTS, in the same assembled system prompt.
        expect(sys).toContain("id | title | agent | status")
        expect(sys).not.toContain("id | title | mode | status")
      },
    })
  })

  // DOCUMENTATION claim, so a text assertion IS the right instrument here (the
  // deliverable is prose). The behaviour it describes is already pinned by
  // "DEFECT 3" above, which reads field 3 off the assembled on-the-wire roster.
  // The shipped design spec was still documenting the pre-fix `mode` while
  // orchestrator.txt and llm.ts had already been corrected to `agent`.
  test("DEFECT 3: the shipped design spec documents the same field-3 as the code emits", async () => {
    const spec = await Bun.file(
      path.join(__dirname, "../../../../docs/compose/specs/2026-07-14-orchestrator-route-first-redesign.md"),
    ).text()
    expect(spec).toContain("id | title | agent | status")
    expect(spec).not.toContain("id | title | mode | status")
    // Calling the build/plan/compose set "mode" is the same drift, one sentence later.
    expect(spec).not.toContain("Which session's mode (build/plan/compose)")
  })

  test("system-spawned agents (checkpoint-writer) stay out of the roster even when idle", async () => {
    const server = queueState.server!
    const fixture = await loadFixture(PROVIDER_ID, MODEL_ID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(`${server.url.origin}/v1`))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Guards the DEFECT-1 widening: now that finished-clean children are
        // KEPT, a finished checkpoint-writer must not leak in with them.
        const fleet = await seedFleet([
          { title: "real work", agent: "build" },
          { title: "checkpoint-writer: memory", agent: "checkpoint-writer", terminal: true },
        ])
        const sys = await captureSystemPrompt({
          sessionID: fleet.parentID,
          agent: orchestratorAgent(),
          modelID: fixture.model.id,
        })

        const block = rosterBlock(sys)
        expect(block).toContain(fleet.children[0]!.id)
        expect(block).not.toContain(fleet.children[1]!.id)
        expect(block).not.toContain("checkpoint-writer")
      },
    })
  })

  test("a non-orchestrator agent gets no roster even with live children", async () => {
    const server = queueState.server!
    const fixture = await loadFixture(PROVIDER_ID, MODEL_ID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(`${server.url.origin}/v1`))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fleet = await seedFleet([{ title: "some child", agent: "build" }])
        const sys = await captureSystemPrompt({
          sessionID: fleet.parentID,
          agent: plainAgent("build"),
          modelID: fixture.model.id,
        })
        // orchestrator.txt no longer names the roster with a literal tag, so
        // absence can be asserted directly on the injected header.
        expect(sys).not.toContain(ROSTER_HEADER)
      },
    })
  })

  test("no children — no empty roster block is injected", async () => {
    const server = queueState.server!
    const fixture = await loadFixture(PROVIDER_ID, MODEL_ID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(`${server.url.origin}/v1`))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fleet = await seedFleet([])
        const sys = await captureSystemPrompt({
          sessionID: fleet.parentID,
          agent: orchestratorAgent(),
          modelID: fixture.model.id,
        })
        // orchestrator.txt no longer names the roster with a literal tag, so
        // absence can be asserted directly on the injected header.
        expect(sys).not.toContain(ROSTER_HEADER)
      },
    })
  })

  test("orchestrator.txt's route-first directives actually reach the model", async () => {
    const server = queueState.server!
    const fixture = await loadFixture(PROVIDER_ID, MODEL_ID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(`${server.url.origin}/v1`))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fleet = await seedFleet([{ title: "fix flaky CI", agent: "build" }])
        const sys = await captureSystemPrompt({
          sessionID: fleet.parentID,
          agent: orchestratorAgent(),
          modelID: fixture.model.id,
        })
        // The redesign is only real if the assembled request carries both the
        // instruction ("route to an existing session first") AND the data the
        // instruction refers to (the roster). Prompt-file tests can only prove
        // the former; this proves they arrive together on one request.
        expect(sys).toContain(ROSTER_HEADER)
        expect(sys).toContain("session send")
        expect(sys.indexOf("session send")).toBeGreaterThan(-1)
        expect(sys).toContain(fleet.children[0]!.id)
      },
    })
  })
})
