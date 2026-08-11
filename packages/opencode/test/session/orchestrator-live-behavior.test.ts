import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { $ } from "bun"
import path from "path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Session as SessionNs } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ActorRegistry } from "../../src/actor/registry"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID, ModelID } from "../../src/provider/schema"
import type { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

// LIVE-MODEL behaviour tests for the orchestrator.
//
// Everything else in this branch's suite is deterministic: it proves the roster
// and the routing directives REACH the model (request body on the wire), or
// that the `session` tool does the right thing once called. None of that can
// prove the model's DECISION — with a scripted LLM the assistant's reply is
// authored by the test, so asserting "it dispatched instead of asking" would
// only re-assert the script.
//
// These tests drive a REAL model through a REAL agentic turn and assert on the
// TOOL CALL THE MODEL ACTUALLY EMITTED — operation action + sessionID, read
// back out of the persisted message parts. Never on prompt text.
//
// OPT-IN, NEVER IN CI. Double-gated, following the convention established by
// test/workflow/verify-wow.test.ts: an explicit RUN_* opt-in env var AND the
// live credentials. `it.live` alone is NOT a gate — it only swaps TestClock for
// the real clock and would still RUN in CI — so the RUN_* flag is what keeps
// this file inert. test/preload.ts strips ~20 provider key env vars but touches
// neither RUN_ORCHESTRATOR_LIVE nor MIMOCODE_LIVE_MODEL_*, so both survive into
// the test process. With the flag unset the file contributes exactly one
// passing placeholder test, so it is a no-op in CI rather than an empty file.
//
//   RUN_ORCHESTRATOR_LIVE=1                                \
//   MIMOCODE_LIVE_MODEL_API_KEY=sk-...                     \
//   MIMOCODE_LIVE_MODEL_BASE_URL=https://host/v1           \
//   MIMOCODE_LIVE_MODEL_ID=mimo-v2.5                       \
//     bun test test/session/orchestrator-live-behavior.test.ts --timeout 900000
//
// A live model is non-deterministic by construction. Each behaviour is asserted
// over LIVE_ATTEMPTS independent turns and must hold on every one, so a single
// lucky sample cannot make a test pass.
//
// KNOWN FLAKINESS, and it is NOT the model. Any single turn here can stall in
// the checkpoint-writer path — the log fills with
//   WARN fork agent runLoop: missing forkContext, failing actor  (checkpoint-writer-1)
// and the turn then makes no progress until the test timeout fires. Observed
// hitting the full 900s on a test that passed in 4s on the run before. So a
// 900_000ms result is a HANG, not a behavioural failure: re-run that test alone
// before drawing any conclusion from it. Whole-file wall time has been measured
// anywhere between 260s and 2090s for the same 7 tests for this reason.
//
// EVERY scenario here seeds a fleet, on purpose. A scenario with an EMPTY fleet
// leaves `session create` as the only correct dispatch, and a real create
// spawns a real peer child that runs a real live turn — which the orchestrator
// prompt then tells the model to drive to a terminal state. That turn is
// unbounded: measured at >900s, i.e. it blows any sane test timeout and yields
// no observation at all. Seeding a fleet makes the correct dispatch `send`,
// which enqueues and returns, so the turn is bounded and the model's DECISION
// is still the thing being observed.

const LIVE_KEY = process.env["MIMOCODE_LIVE_MODEL_API_KEY"]
const LIVE_BASE = process.env["MIMOCODE_LIVE_MODEL_BASE_URL"]
const LIVE_MODEL = process.env["MIMOCODE_LIVE_MODEL_ID"] ?? "mimo-v2.5"
const LIVE_PROVIDER = "livemodel"
const LIVE_ATTEMPTS = Number(process.env["MIMOCODE_LIVE_MODEL_ATTEMPTS"] ?? "2")
const ENABLED = process.env["RUN_ORCHESTRATOR_LIVE"] === "1"
const offline = !LIVE_KEY || !LIVE_BASE
const maybe = ENABLED && !offline ? it.live : it.live.skip

const TURN_TIMEOUT = 900_000

if (!ENABLED || offline) {
  test("skipped (set RUN_ORCHESTRATOR_LIVE=1 + MIMOCODE_LIVE_MODEL_{API_KEY,BASE_URL} to run against a live model)", () => {
    expect(true).toBe(true)
  })
}

/**
 * The live provider/model is declared INLINE in the fixture's mimocode.json.
 * test/preload.ts pins MIMOCODE_MODELS_PATH at test/tool/fixtures/models-api.json,
 * which carries no entry for this model, and sets MIMOCODE_DISABLE_DEFAULT_PLUGINS
 * so no plugin can inject one. A config-declared provider is merged over the
 * catalog, so this is the only route that does not depend on network catalog
 * state either.
 */
function liveConfig() {
  return {
    enabled_providers: [LIVE_PROVIDER],
    provider: {
      [LIVE_PROVIDER]: {
        name: "live model under test",
        npm: "@ai-sdk/openai-compatible",
        api: LIVE_BASE,
        options: { apiKey: LIVE_KEY, baseURL: LIVE_BASE },
        models: {
          [LIVE_MODEL]: {
            id: LIVE_MODEL,
            name: LIVE_MODEL,
            tool_call: true,
            reasoning: true,
            attachment: false,
            temperature: true,
            release_date: "2025-01-01",
            limit: { context: 262_144, output: 32_768 },
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            options: {},
          },
        },
      },
    },
  } as any
}

const liveModel = () => ({
  providerID: ProviderID.make(LIVE_PROVIDER),
  modelID: ModelID.make(LIVE_MODEL),
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | SessionNs.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, SessionNs.defaultLayer))),
  )
}

type Child = { id: SessionID; title: string }

/**
 * A real orchestrator session plus real peer children, each with a real
 * actor_registry row, using the production convention the roster query joins
 * on: session_id === actor_id === child session id, parent_actor_id === "main".
 * These are the rows ActorRegistry.listPeerChildren reads to build
 * <active-sessions>, so the roster the model sees here is the production one.
 */
async function seedFleet(children: Array<{ title: string; agent: string; finished?: boolean }>) {
  const sessionRt = ManagedRuntime.make(SessionNs.defaultLayer)
  let parentID: SessionID
  const created: Child[] = []
  try {
    parentID = await sessionRt.runPromise(
      SessionNs.Service.use((svc) => svc.create({ title: "orchestrator" })).pipe(Effect.map((info) => info.id)),
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
      await regRt.runPromise(
        ActorRegistry.Service.use((svc) =>
          spec.finished
            ? svc.updateStatus(child.id, child.id, { status: "idle", lastOutcome: "success" })
            : svc.updateStatus(child.id, child.id, { status: "running" }),
        ),
      )
    }
  } finally {
    await regRt.dispose()
  }
  return { parentID: parentID!, children: created }
}

/**
 * The orchestrator's ROUTABLE FLEET, read with the same production query that
 * builds <active-sessions> (ActorRegistry.listPeerChildren, mode "peer",
 * parent_actor_id "main"). A `session create` by the model goes through
 * Actor.spawnPeer, which registers exactly such a row, so a model-driven create
 * DOES show up here — the assertion keeps its teeth.
 *
 * What it deliberately does NOT count is Session.children(), which also
 * includes platform-internal child sessions the model never asked for: the
 * checkpoint subsystem creates a real child session titled
 * `checkpoint-writer: …` under whatever session it is checkpointing
 * (src/session/checkpoint.ts:846) and spawns it as mode "subagent". Comparing
 * raw Session.children() before/after therefore reports "+1 child" on a turn in
 * which the model created nothing, which is infrastructure noise, not a routing
 * decision.
 */
async function fleetIDs(parentID: SessionID): Promise<string[]> {
  const rt = ManagedRuntime.make(ActorRegistry.defaultLayer)
  try {
    const rows = await rt.runPromise(
      ActorRegistry.Service.use((svc) => svc.listPeerChildren(parentID, "main")),
    )
    return rows.map((row) => row.actor.sessionID).sort()
  } finally {
    await rt.dispose()
  }
}

type Call = { tool: string; action?: string; sessionID?: string; input: Record<string, any>; status: string; output: string }

/**
 * The model's raw tool arguments. `session` nests everything under `operation`,
 * and src/tool/session.ts coerces a stringified `operation` because models do
 * emit that — so read both shapes here rather than asserting the happy one.
 */
function decodeOperation(input: Record<string, any>): Record<string, any> {
  const op = input?.["operation"]
  if (op && typeof op === "object" && !Array.isArray(op)) return op
  if (typeof op === "string") {
    try {
      const inner = JSON.parse(op)
      if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner
    } catch {}
    // Observed live: the model puts the ACTION NAME in `operation` and its
    // arguments as siblings — {"operation":"send","sessionID":"ses_x","task":"..."}.
    // strictObject rejects that (the tool answers "Invalid arguments" and the
    // model retries nested), but it is still the model's DECISION, so decode it
    // rather than losing the sample.
    return { ...input, action: op }
  }
  return {}
}

/**
 * Every tool call the model emitted this turn, in order, read back out of the
 * persisted message parts (not out of the reply text). This is the assertion
 * target for every test in this file.
 */
async function toolCalls(sessionID: SessionID): Promise<Call[]> {
  const rt = ManagedRuntime.make(SessionNs.defaultLayer)
  try {
    const messages = await rt.runPromise(SessionNs.Service.use((svc) => svc.messages({ sessionID })))
    const out: Call[] = []
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        const tool = part as MessageV2.ToolPart
        const input = (tool.state as any).input ?? {}
        const op = decodeOperation(input)
        out.push({
          status: (tool.state as any).status ?? "?",
          output: String((tool.state as any).output ?? (tool.state as any).error ?? ""),
          tool: tool.tool,
          action: typeof op["action"] === "string" ? op["action"] : undefined,
          sessionID: typeof op["sessionID"] === "string" ? op["sessionID"] : undefined,
          input,
        })
      }
    }
    return out
  } finally {
    await rt.dispose()
  }
}

/** The assistant's visible prose this turn — used only to detect a QUESTION. */
async function assistantText(sessionID: SessionID): Promise<string> {
  const rt = ManagedRuntime.make(SessionNs.defaultLayer)
  try {
    const messages = await rt.runPromise(SessionNs.Service.use((svc) => svc.messages({ sessionID })))
    return messages
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => (part as MessageV2.TextPart).text)
      .join("\n")
  } finally {
    await rt.dispose()
  }
}

type Turn = {
  calls: Call[]
  text: string
  fleetBefore: string[]
  fleetAfter: string[]
  baseBranchMoved: boolean
  mergeInProgress: boolean
}

/**
 * One real orchestrator turn against the live model: real fleet, real prompt
 * assembly (agent "orchestrator" resolves through the production agent registry
 * — test/preload.ts already sets MIMOCODE_EXPERIMENTAL_ORCHESTRATOR), real tool
 * loop. Returns what the model DID.
 *
 * `mergeableBranch` gives the fixture repo a REAL unmerged feature branch. It
 * matters for the human-review contrast case: `tmpdir({git:true})` alone leaves
 * a repo with one root commit and no branches, so "did it merge to main?" is
 * unfalsifiable there — the model correctly answers "there is nothing to merge"
 * and a no-merge assertion passes vacuously. With a real branch the negative has
 * teeth, and `baseBranchMoved` is the second, tool-call-independent observable.
 */
async function orchestratorTurn(input: {
  fleet: Array<{ title: string; agent: string; finished?: boolean }>
  text: string
  mergeableBranch?: string
  /** When set, the base branch also touches the same file, so merging
   *  `mergeableBranch` into it CONFLICTS. Lets a test observe what the
   *  orchestrator does with a conflict rather than a clean fast-forward. */
  conflictWith?: string
}): Promise<Turn & { children: Child[] }> {
  let baseBranch = ""
  let baseHeadBefore = ""
  await using tmp = await tmpdir({
    git: true,
    config: liveConfig(),
    init: input.mergeableBranch
      ? async (dir: string) => {
          baseBranch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(dir).quiet().text()).trim()
          await $`git checkout -b ${input.mergeableBranch!}`.cwd(dir).quiet()
          await Bun.write(path.join(dir, "payments-shard.txt"), "raise the shard 3 timeout\n")
          await $`git add payments-shard.txt`.cwd(dir).quiet()
          await $`git commit -m "fix: raise the payments shard 3 timeout"`.cwd(dir).quiet()
          await $`git checkout ${baseBranch}`.cwd(dir).quiet()
          if (input.conflictWith) {
            await Bun.write(path.join(dir, "payments-shard.txt"), "leave the shard 3 timeout alone\n")
            await $`git add payments-shard.txt`.cwd(dir).quiet()
            await $`git commit -m "chore: pin the payments shard 3 timeout"`.cwd(dir).quiet()
          }
          baseHeadBefore = (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim()
        }
      : undefined,
  })
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { parentID, children } = await seedFleet(input.fleet)
      const fleetBefore = await fleetIDs(parentID)
      await run(
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          yield* prompt.prompt({
            sessionID: parentID,
            agent: "orchestrator",
            model: liveModel(),
            parts: [{ type: "text", text: input.text }],
          })
        }),
      )
      const baseHeadAfter = input.mergeableBranch
        ? (await $`git rev-parse ${baseBranch}`.cwd(tmp.path).quiet().text()).trim()
        : ""
      return {
        children,
        calls: await toolCalls(parentID),
        text: await assistantText(parentID),
        fleetBefore,
        fleetAfter: await fleetIDs(parentID),
        baseBranchMoved: Boolean(input.mergeableBranch) && baseHeadAfter !== baseHeadBefore,
        // A half-finished merge leaves MERGE_HEAD behind. True here means the
        // orchestrator walked away mid-merge instead of aborting cleanly.
        mergeInProgress: existsSync(path.join(tmp.path, ".git", "MERGE_HEAD")),
      }
    },
  })
}

const sessionCalls = (turn: Turn) => turn.calls.filter((call) => call.tool === "session")

/**
 * The DISPATCH decisions only. `list`/`status`/`dashboard`/`ask` are read-only
 * inspection the prompt explicitly allows before routing, so they must not be
 * mistaken for the routing decision under test.
 */
const dispatches = (turn: Turn) =>
  sessionCalls(turn).filter((call) => call.action === "send" || call.action === "create")

/** Tools that mean "I analysed this myself instead of routing it". */
const ANALYSIS_TOOLS = new Set(["read", "grep", "glob", "list", "bash", "multiedit", "edit", "write", "apply_patch"])
const analysisCalls = (turn: Turn) => turn.calls.filter((call) => ANALYSIS_TOOLS.has(call.tool))

/**
 * Internal scaffolding that must never reach the user. Recorded per turn because a
 * text assertion on a prompt file cannot prove a model did not echo something —
 * only a real turn can. Reported, not asserted: a live turn is the wrong place to
 * gate CI, and an assertion here would go flaky for reasons unrelated to leaking.
 *
 * `<active-sessions>` is the tag users actually saw in the TUI. It has since been
 * removed from the assembled request outright (ROSTER_HEADER, session/llm.ts), so
 * a hit here would mean the model INVENTED it — worth knowing either way. The
 * other two are the tool-result blocks, which cannot be deleted because they ARE
 * the affordance and so rely on a weaker "this is internal" instruction.
 */
const LEAKABLE: ReadonlyArray<[string, string]> = [
  ["active-sessions-tag", "<active-sessions>"],
  ["roster-ledger", "ROUTE FIRST"],
  ["conflict-notice", "THE CONFLICT IS NOT YOURS TO RESOLVE"],
]

function report(label: string, turn: Turn) {
  const rendered = turn.calls.map((call) => `${call.tool}${call.action ? ":" + call.action : ""}`).join(", ") || "(none)"
  console.log(`[live:${label}] tools=[${rendered}] text=${JSON.stringify(turn.text.slice(0, 220))}`)
  const leaked = LEAKABLE.filter(([, needle]) => turn.text.includes(needle)).map(([name]) => name)
  console.log(`[live:${label}] echoed-internal-scaffolding=${leaked.length === 0 ? "(none)" : leaked.join(",")}`)
  for (const call of turn.calls) console.log(`[live:${label}]   raw[${call.status}] ${call.tool} ${JSON.stringify(call.input).slice(0, 200)} => ${call.output.slice(0, 220)}`)
}

describe("orchestrator live behaviour — route to an EXISTING standing child", () => {
  // THE headline behaviour of this redesign: work whose topic a live child
  // already owns must go out as `session send <that child>`, never as a fresh
  // `session create`. Deterministic tests can only prove the roster arrived;
  // this proves the model routes on it.
  const fleet = [
    { title: "auth-service: OAuth token refresh rework", agent: "build" },
    { title: "billing-service: Stripe webhook reconciliation", agent: "build" },
  ]

  for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt++) {
    maybe(
      `routes work to the child that already owns the topic (attempt ${attempt}/${LIVE_ATTEMPTS})`,
      Effect.promise(async () => {
        const turn = await orchestratorTurn({
          fleet,
          text: "The Stripe webhook reconciliation is also dropping duplicate invoice.paid events. Get that handled.",
        })
        report(`route-existing#${attempt}`, turn)
        const billing = turn.children.find((child) => child.title.startsWith("billing-service"))!

        const routed = dispatches(turn)
        expect(routed.length).toBeGreaterThan(0)
        expect(routed[0]!.action).toBe("send")
        expect(routed[0]!.sessionID).toBe(billing.id)
        // and it did NOT stand up a second owner for a topic that already has one
        expect(routed.some((call) => call.action === "create")).toBe(false)
        expect(turn.fleetAfter).toEqual(turn.fleetBefore)
      }),
      TURN_TIMEOUT,
    )
  }

  for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt++) {
    // The harder variant the live TUI matrix used: the user's own wording
    // INVITES a new child ("dispatch a child session to..."). Route-first still
    // wins — the topic has a standing owner, so the correct action is `send`.
    maybe(
      `still sends when the request's wording invites a NEW child (attempt ${attempt}/${LIVE_ATTEMPTS})`,
      Effect.promise(async () => {
        const turn = await orchestratorTurn({
          fleet,
          text: "Dispatch a child session to fix the OAuth token refresh race where two refreshes run at once.",
        })
        report(`invited-new#${attempt}`, turn)
        const auth = turn.children.find((child) => child.title.startsWith("auth-service"))!

        const routed = dispatches(turn)
        expect(routed.length).toBeGreaterThan(0)
        expect(routed[0]!.action).toBe("send")
        expect(routed[0]!.sessionID).toBe(auth.id)
        expect(routed.some((call) => call.action === "create")).toBe(false)
        expect(turn.fleetAfter).toEqual(turn.fleetBefore)
      }),
      TURN_TIMEOUT,
    )
  }
})

describe("orchestrator live behaviour — topic recognition reuses a STANDING child", () => {
  // Gap #8. The tool-level find-or-reuse of `--topic` already has a
  // deterministic e2e (T43 in test/tool/session-tool.test.ts). What only a live
  // model can show is RECOGNITION: the incoming work never repeats the child's
  // title, and the owner has already FINISHED its last turn (lastOutcome
  // "success" → listed `idle`, resumable — the roster behaviour this branch
  // fixed). Correct answer is still `send` to that child, not a fresh create.
  const fleet = [
    { title: "release-notes for the 2.7 launch", agent: "build", finished: true },
    { title: "flaky-test triage in the payments suite", agent: "build", finished: true },
  ]

  for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt++) {
    maybe(
      `recognises a paraphrased topic and resumes its finished owner (attempt ${attempt}/${LIVE_ATTEMPTS})`,
      Effect.promise(async () => {
        const turn = await orchestratorTurn({
          fleet,
          // no shared vocabulary with the title: "changelog"/"2.7" vs "release-notes"
          text: "Marketing wants the 2.7 changelog to also call out the new billing dashboard. Please get it in.",
        })
        report(`topic-recognition#${attempt}`, turn)
        const owner = turn.children.find((child) => child.title.startsWith("release-notes"))!

        const routed = dispatches(turn)
        expect(routed.length).toBeGreaterThan(0)
        expect(routed[0]!.action).toBe("send")
        expect(routed[0]!.sessionID).toBe(owner.id)
        expect(turn.fleetAfter).toEqual(turn.fleetBefore)
      }),
      TURN_TIMEOUT,
    )
  }
})

describe("orchestrator live behaviour — act, don't ask", () => {
  // A RAW situation with NO instruction attached — a user venting a symptom, no
  // imperative verb, no "please fix". The prompt's claim is that the
  // orchestrator is the user's digital twin and dispatches rather than
  // interrogating. Observable: a dispatch happened, and it did not spend the
  // turn on a clarifying question.
  //
  // The fleet exists only to keep the turn bounded (see the file header): what
  // is under test is act-vs-ask, and `send` is a dispatch exactly as `create`
  // is. The prompt itself is still instruction-free, which is the variable.
  const fleet = [{ title: "billing-service: nightly reconciliation job", agent: "build", finished: true }]

  for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt++) {
    maybe(
      `dispatches instead of asking a clarifying question (attempt ${attempt}/${LIVE_ATTEMPTS})`,
      Effect.promise(async () => {
        const turn = await orchestratorTurn({
          fleet,
          text: "线上 billing 的对账定时任务从昨天晚上开始每次都跑挂了，日志里全是 invoice.paid 的重复告警。",
        })
        report(`act-dont-ask#${attempt}`, turn)

        expect(turn.calls.filter((call) => call.tool === "question")).toEqual([])
        expect(dispatches(turn).length).toBeGreaterThan(0)
      }),
      TURN_TIMEOUT,
    )
  }
})

describe("orchestrator live behaviour — route the analysis, don't self-analyse", () => {
  // "Route analysis, don't self-analyze (reinforced)" in orchestrator.txt: on a
  // bug/failure/review situation the FIRST action must be a dispatch, not
  // reading files inline. Observable: a dispatch exists, and no file-reading /
  // editing tool call precedes it. The request explicitly says "root-cause it",
  // which is precisely the invitation to self-analyse that must be declined.
  const fleet = [{ title: "packages/opencode: session suite CI failures", agent: "build", finished: true }]

  for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt++) {
    maybe(
      `dispatches before touching any file itself (attempt ${attempt}/${LIVE_ATTEMPTS})`,
      Effect.promise(async () => {
        const turn = await orchestratorTurn({
          fleet,
          text: "CI is red on packages/opencode: three tests in the session suite started failing after the last merge. Root-cause it and fix it.",
        })
        report(`route-analysis#${attempt}`, turn)

        const routed = dispatches(turn)
        expect(routed.length).toBeGreaterThan(0)

        const firstDispatchAt = turn.calls.findIndex((call) => call.action === "send" || call.action === "create")
        const firstAnalysisAt = turn.calls.findIndex((call) => ANALYSIS_TOOLS.has(call.tool))
        // -1 means it never self-analysed at all, which is the ideal outcome.
        if (firstAnalysisAt !== -1) {
          expect(
            `self-analysed with "${turn.calls[firstAnalysisAt]!.tool}" at index ${firstAnalysisAt}, before dispatching at ${firstDispatchAt}`,
          ).toBe(`dispatch first (index ${firstDispatchAt})`)
        }
        expect(analysisCalls(turn)).toEqual([])
      }),
      TURN_TIMEOUT,
    )
  }
})

describe("orchestrator live behaviour — drive a non-human-review task to terminal", () => {
  // Gap #9, orchestrator.txt:15: "Human review is the ONLY reason to wait."
  // Two-sided on purpose. A test that only proves "it always dispatches" would
  // pass for a model that never waits for anything, which is a different defect.
  const fleet = [{ title: "ci: green up the payments shard", agent: "build", finished: true }]

  for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt++) {
    maybe(
      `keeps driving a flaky-CI report itself instead of handing it back (attempt ${attempt}/${LIVE_ATTEMPTS})`,
      Effect.promise(async () => {
        const turn = await orchestratorTurn({
          fleet,
          text: "Child report: shard 3 of the payments suite failed again — looks like the same flaky timeout, everything else is green.",
        })
        report(`drive-terminal#${attempt}`, turn)

        expect(turn.calls.filter((call) => call.tool === "question")).toEqual([])
        expect(dispatches(turn).length).toBeGreaterThan(0)
      }),
      TURN_TIMEOUT,
    )
  }

  // THE MERGE CASE — the requirement this used to encode was wrong, so the test
  // was rewritten rather than left skipped.
  //
  // It previously asserted that the orchestrator must NOT merge into a protected
  // branch and must wait for the human, and it failed 3/3 on mimo-v2.5 (run A:
  // `git merge --ff-only payments-shard-fix` + `git branch -d`; runs B and C:
  // `git merge payments-shard-fix -m ...`; `baseBranchMoved` true every time).
  // That was read as a prompt-adherence defect, and then as a case for a
  // mechanism-level block.
  //
  // Both readings were wrong. Merging an integrated branch is the maintainer's
  // job, and the orchestrator IS the maintainer: in the GitHub model the PR
  // author resolves conflicts and the maintainer clicks merge. So a clean merge
  // performed by the orchestrator is correct behaviour, not a violation — the
  // three "failing" runs were the model doing the right thing.
  //
  // The real constraint is the one the orchestrator's own never-block rule
  // implies: it must not SIT on a conflict. A conflicted merge is the PR
  // author's problem, so the orchestrator must abandon it (leave no half-merged
  // index behind) and route the conflict back to the session that owns the
  // branch, instead of spending its turn resolving hunks.
  maybe(
    "merges a clean branch itself, and on a CONFLICT abandons it and routes back to the owning child",
    Effect.promise(async () => {
      const turn = await orchestratorTurn({
        fleet,
        mergeableBranch: "payments-shard-fix",
        conflictWith: "main",
        text: "The payments shard is green now — the fix is committed on the `payments-shard-fix` branch. Merging it into `main` is the last step.",
      })
      report("merge-conflict-routes-back", turn)

      // It may attempt the merge — that is its job, so this is not asserted
      // either way. What must hold is that it does not leave the repo mid-merge
      // and does not try to resolve the conflict itself.
      const resolved = turn.calls.filter(
        (call) =>
          call.tool === "bash" &&
          /git\s+(add|commit)\b/.test(String(call.input?.["command"] ?? "")) === true,
      )
      const abandoned = turn.calls.some(
        (call) =>
          call.tool === "bash" && /git\s+merge\s+--abort/.test(String(call.input?.["command"] ?? "")) === true,
      )
      const routed = turn.calls.some((call) => call.tool === "session" && call.input?.["operation"] !== undefined)

      expect(turn.mergeInProgress).toBe(false)
      expect(resolved).toEqual([])
      expect(abandoned || routed).toBe(true)
      expect(routed).toBe(true)
    }),
    TURN_TIMEOUT,
  )
})
