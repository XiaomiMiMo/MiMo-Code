import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import os from "node:os"
import { createHash } from "node:crypto"
import { spawnRef } from "@/actor/spawn-ref"
import { workflowRef } from "./runtime-ref"
import { Config } from "@/config"
import { EffectBridge } from "@/effect"
import { Bus } from "@/bus"
import { Inbox } from "@/inbox"
import { Worktree } from "@/worktree"
import { Provider } from "@/provider"
import { InstanceRef } from "@/effect/instance-ref"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import type { SessionID } from "@/session/schema"
import type { ProviderID, ModelID } from "@/provider/schema"
import { parseMeta } from "./meta"
import { evalScript, type HostFn } from "./sandbox"
import { makeFileHooks, resolveInWorkspace } from "./workspace"
import { isInlineScript, resolveWorkflowScript } from "./resolve"
import { WorkflowAgentFailed, WorkflowChildFailed, WorkflowFinished, WorkflowLog, WorkflowPhase, WorkflowStarted } from "./events"
import { WorkflowPersistence, journalKeyBase } from "./persistence"
import type { RunSummary } from "./persistence"
import { Log, Lock } from "@/util"

const log = Log.create({ service: "workflow.runtime" })

/** Default wall-clock budget for a whole workflow script (12h research default). */
const SCRIPT_DEADLINE_MS = 12 * 60 * 60 * 1000
/** Unique sentinel for the per-agent timeout race: a timeout winner can never
 * collide with an agent deliverable (those are object | string | null). */
const STRAGGLER_TIMEOUT = Symbol("straggler-timeout")
/** Hard ceiling on total agents a single run may spawn (lifecycle cap). */
const MAX_LIFECYCLE_AGENTS = 1000
/** Default soft cap on concurrent agents when the caller does not specify one. */
const DEFAULT_MAX_CONCURRENT = 16
/** Marker prefix on errors from STRUCTURAL workflow faults (cycle, over-depth,
 * unknown name) — workflow-wiring bugs that must fail the whole tree loud rather
 * than degrade to the never-throw null that a child's RUNTIME failure yields. The
 * workflow() hook re-propagates any child outcome whose error carries this marker,
 * so the fault surfaces at the root run the user launched. */
const WORKFLOW_STRUCTURAL_ERROR = "WorkflowStructuralError"

type RunStatus = "running" | "completed" | "failed" | "cancelled"

export type RunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string }
  | { status: "cancelled" }

/** One ordered transcript line. The runtime appends these synchronously from the
 * guest's phase()/log() hooks (in-process QuickJS, same thread), so the array is
 * the authoritative program-order record — no bus delivery race, no cross-event
 * reordering. Consumers (the workflow tool's sync path) read it instead of
 * subscribing to WorkflowPhase/WorkflowLog. */
export type WorkflowTranscriptEntry = { kind: "phase" | "log"; text: string }

// Observability-only structure tree for one run, recorded in the agent()/phase()/
// workflow() host hooks. Each agent/workflow node is attributed to the phase
// current at call time (known synchronously inside the hook — no timing guess).
// This NEVER touches journal keys / occ counts / resume: adding or removing it
// changes no run outcome. parallel/pipeline batch grouping is intentionally not
// recorded (pure-guest helpers, no AsyncLocalStorage in QuickJS) — agents are
// siblings under their phase.
export type WorkflowNode =
  | { type: "phase"; id: string; title: string }
  | {
      type: "agent"
      id: string
      phaseId?: string
      label?: string
      agentType: string
      /** The prompt the guest passed to agent() — the call's primary parameter. */
      prompt: string
      /** Resolved-ref model the call requested (undefined = run default). */
      model?: string
      /** Tool allowlist the call passed, if any. */
      tools?: string[]
      /** Whether the call requested structured output (a schema was passed). */
      schema?: boolean
      /** Whether the call ran in an isolated worktree. */
      isolation?: boolean
      /** The spawned child actor id (filled once spawned; absent for cache hits / over-cap). */
      actorID?: string
      /** Wall-clock duration in ms (filled when the call settles). */
      durationMs?: number
      /** Short summary of the agent's deliverable (the value agent() resolved to),
       * so the tree shows what it actually produced — not just that it finished. */
      resultSummary?: string
      status: "running" | "succeeded" | "failed"
    }
  | {
      type: "workflow"
      id: string
      phaseId?: string
      childRunID: string
      name: string
      /** The args the guest passed to workflow() (JSON), for parity with agent params. */
      args?: unknown
      status: "running" | "completed" | "failed" | "cancelled"
    }
export type WorkflowStructure = { nodes: WorkflowNode[] }

// Short, display-only summary of an agent's deliverable for the structure tree.
// A deliverable is a string (prose finalText) or a structured object; a worktree
// deliverable is wrapped as { _worktree, result }. We flatten to one line and cap
// length — purely observability, never fed to the model. Capped generously so the
// card shows a substantial chunk of the response (the full trace is one ↗ away).
const RESULT_SUMMARY_MAX = 600
function summarizeAgentResult(result: unknown): string | undefined {
  if (result === null || result === undefined) return undefined
  const unwrapped =
    typeof result === "object" && result !== null && "_worktree" in result
      ? (result as { result?: unknown }).result ?? result
      : result
  // JSON.stringify can throw (cycles, BigInt). This runs on the host settle path
  // inside markAgentNode, so a throw would escape into the run — guard it: a result
  // we can't summarize just yields no summary, never breaks the agent.
  let text: string
  try {
    text = typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped, null, 2)
  } catch {
    return undefined
  }
  if (!text) return undefined
  // Preserve line breaks (collapse only runs of spaces/tabs) so a multi-paragraph
  // response renders as readable text in the card, then cap total length.
  const trimmed = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
  if (!trimmed) return undefined
  return trimmed.length > RESULT_SUMMARY_MAX ? trimmed.slice(0, RESULT_SUMMARY_MAX - 1) + "…" : trimmed
}

interface RunEntry {
  runID: string
  sessionID: SessionID
  status: RunStatus
  deferred: Deferred.Deferred<RunOutcome>
  fiber: Fiber.Fiber<void> | undefined
  childActorIDs: Set<string>
  worktrees: Set<string> // worktree directories pending disposition, for cancel cleanup
  childRunIDs: Set<string> // child workflow runIDs, for recursive cancel/reclaim
  name: string
  running: number
  succeeded: number
  failed: number
  agentCount: number
  capWarned: boolean
  // Model refs already warned about this run, so an unresolvable ref (e.g. a
  // workflow using "lite" with no model_groups.lite configured) logs ONCE per
  // run instead of once per agent spawn. Per-run, not layer-global, so a later
  // run re-warns. See resolveAgentModel.
  warnedModelRefs: Set<string>
  currentPhase: string | undefined
  // Ordered phase/log transcript, appended synchronously by the guest hooks. The
  // sync workflow-tool path reads this (via the `transcript` accessor) rather than
  // subscribing to the bus, which removes the subscribe-after-start head race, the
  // two-PubSub reordering, the post-wait tail race, and the subscription leak.
  transcript: WorkflowTranscriptEntry[]
  // Observability-only structure nodes (phase/agent/workflow), program-ordered.
  structure: WorkflowNode[]
  // Id of the phase node current at the time of the next agent()/workflow() call.
  currentPhaseId: string | undefined
}

interface StartInput {
  script: string
  sessionID: SessionID
  parentActorID: string
  args?: unknown
  model?: { providerID: ProviderID; modelID: ModelID }
  maxConcurrentAgents?: number
  // Hard ceiling on total agents this run may spawn (lifecycle cap). Defaults to
  // MAX_LIFECYCLE_AGENTS (1000). Over-cap agent() calls return null (graceful
  // degradation, never-throw), NOT throw — so a fan-out that wants more agents
  // than the cap degrades to the cap-limited subset instead of aborting the run.
  // Lowerable for tests; tunable in prod.
  maxLifecycleAgents?: number
  /** Per-agent wall-clock timeout (ms). When an individual agent() call's spawned
   * child produces no terminal outcome within this window, it is gracefully
   * cancelled and agent() resolves to null (the never-throw failure sentinel), so
   * one hung agent (e.g. an LLM TTFT wall) cannot stall a parallel/pipeline barrier
   * indefinitely. Default undefined = OFF (only the global scriptDeadlineMs bounds a
   * run). A per-call agent(prompt,{timeoutMs}) overrides this. */
  agentTimeoutMs?: number
  scriptDeadlineMs?: number
  // Internal (resume-only): when true, launch ignores any persisted journal and
  // truncates the stale `.jsonl` before the run appends. resume() sets this on the
  // script-change path (stored script_sha != current script's sha, MR104 P1-2) so
  // an EDITED script never replays results journaled against the OLD body. start()
  // never sets it (a fresh runID has no prior journal — nothing to invalidate).
  freshJournal?: boolean
  /** Root dir the guest's file primitives (readFile/writeFile/glob/exists) are
   * jailed to. Defaults to the caller's worktree. A child workflow inherits the
   * parent's workspace unless its workflow() opts override it. */
  workspace?: string
  /** Resolved names of ancestor workflows (root = empty). A workflow() whose
   * resolved child name is already here is a cycle → throw. */
  lineage?: readonly string[]
  /** Current nesting depth (root run = 0). */
  depth?: number
  /** Max nesting depth before workflow() throws. Defaults to config (8). */
  maxDepth?: number
  /** When the run reaches a terminal state, send an actor_notification to the
   * parent's inbox (the legacy fire-and-forget contract). Defaults to true. The
   * workflow tool's SYNC path sets this false: it blocks on wait() and returns the
   * result as its own tool output, so a parent inbox notification would surface a
   * DUPLICATE completion (and duplicate error text) on the next turn. */
  notifyOnTerminal?: boolean
}

/** Options the guest may pass to `agent(prompt, opts?)`. */
interface AgentOpts {
  agentType?: string
  tools?: readonly string[]
  /** A model reference resolved host-side via Provider.resolveModelRef: either a
   *  "provider/model" literal or a configured tier/group name (e.g. "lite").
   *  Omitted → the run's default model. Unknown group → falls back to the run
   *  default (never throws to the guest). */
  model?: string
  schema?: Record<string, unknown>
  isolation?: "worktree"
  label?: string
  phase?: string
  /** Per-call override of the run's agentTimeoutMs (ms). */
  timeoutMs?: number
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<{ runID: string }>
  readonly status: (input: {
    runID: string
  }) => Effect.Effect<{
    status: RunStatus | "unknown"
    agentCount: number
    running: number
    succeeded: number
    failed: number
    currentPhase?: string
  }>
  readonly wait: (input: { runID: string; timeoutMs?: number }) => Effect.Effect<RunOutcome>
  readonly transcript: (input: { runID: string }) => Effect.Effect<readonly WorkflowTranscriptEntry[]>
  readonly structure: (input: { runID: string }) => Effect.Effect<WorkflowStructure>
  readonly cancel: (input: { runID: string }) => Effect.Effect<void>
  readonly list: (input?: { sessionID?: SessionID }) => Effect.Effect<RunSummary[]>
  readonly resume: (input: { runID: string; agentTimeoutMs?: number }) => Effect.Effect<{ runID: string; resumed: boolean }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowRuntime") {}

/** A plain promise-based semaphore: at most `max` concurrent `run` callbacks. */
function makeSemaphore(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const release = () => {
    active--
    const next = queue.shift()
    if (next) next()
  }
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const attempt = () => {
          active++
          fn().then(
            (value) => {
              release()
              resolve(value)
            },
            (err) => {
              release()
              reject(err)
            },
          )
        }
        if (active < max) attempt()
        else queue.push(attempt)
      })
    },
  }
}

function cpuCount(): number {
  const n = os.cpus().length
  return n > 0 ? n : 4
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const inbox = yield* Inbox.Service
    const worktree = yield* Worktree.Service
    const provider = yield* Provider.Service
    // Resolve the Config service handle at layer scope (a legitimate layer dep,
    // satisfied by Config.defaultLayer) so the requirement is discharged here and
    // does NOT leak into start/resume's effect signatures. Only config.get() runs
    // lazily below — it reads the per-instance ALS context and returns Effect<Info>
    // with no requirement, so it stays out of the public method types.
    const config = yield* Config.Service
    const scope = yield* Scope.Scope
    const runs = new Map<string, RunEntry>()

    // Resolve a guest-supplied model ref (a "provider/model" literal OR a
    // tier/group name like "lite") to a concrete {providerID, modelID} via the
    // Provider service — host-side, inside the runtime's own Layer scope (so it
    // survives resume(), which re-reads the script with no fresh StartInput).
    // NEVER throws to the guest: an unknown group (resolveModelRef throwing
    // ModelGroupNotFoundError) falls back to the run default, matching agent()'s
    // never-throw contract. undefined ref → the run default unchanged.
    const resolveAgentModel = (
      ref: string | undefined,
      fallback: { providerID: ProviderID; modelID: ModelID } | undefined,
      warned: Set<string>,
    ): Effect.Effect<{ providerID: ProviderID; modelID: ModelID } | undefined> =>
      ref === undefined
        ? Effect.succeed(fallback)
        : provider.resolveModelRef(ref).pipe(
            Effect.map((m) => ({ providerID: m.providerID, modelID: m.id })),
            Effect.catchCause(() =>
              Effect.sync(() => {
                // Leave a breadcrumb so a bad ref isn't pure silence: an unknown
                // group/tier, a typo, or an out-of-tree script passing the old
                // {providerID, modelID} object (not a string) all land here and
                // silently use the run default. Warn ONCE per unique ref per run
                // (a fan-out like deep-research would otherwise log on every
                // agent spawn). For a non-string ref, log its sorted keys (e.g.
                // "modelID,providerID") so the operator sees it's the legacy
                // object shape — keys are schema names, no user data.
                const shown =
                  typeof ref === "string"
                    ? ref
                    : `{${Object.keys(ref as object)
                        .sort()
                        .join(",")}}`
                if (!warned.has(shown)) {
                  warned.add(shown)
                  log.warn("workflow agent model ref did not resolve — using run default", { ref: shown })
                }
                return fallback
              }),
            ),
          )

    // Process-wide concurrency ceiling: ONE semaphore shared by every run
    // (including nested children), so tree-wide concurrent agents can never
    // exceed it regardless of nesting depth. It is a PURE process/config property,
    // sized SOLELY from config.workflow.maxConcurrentAgents (falling back to the
    // min(16, 2×cores) default) — NEVER seeded or raised by any per-launch
    // maxConcurrentAgents input. A per-run input only ever NARROWS that run's own
    // semaphore (clamped ≤ global, below); it can neither raise the global nor bind
    // a later run to an earlier run's cap. Resolved LAZILY on the first launch
    // (config.get reads the per-instance ALS context, live inside launch but NOT at
    // layer-build time) and memoized at service scope so every subsequent launch() —
    // including nested children — shares the same semaphore. `cfg`/`globalMax`/
    // `globalSem` are reused by later tasks (T12 maxDepth, T14 maxLifecycleAgents).
    let cfg: Config.Info | undefined
    let globalMax = 0
    let globalSem: ReturnType<typeof makeSemaphore> | undefined
    const ensureGlobal = Effect.fn("WorkflowRuntime.ensureGlobal")(function* () {
      if (globalSem) return globalSem
      // Resolve config once (this is the only suspension point). Cached on `cfg`
      // for reuse by later per-run reads (maxDepth, maxLifecycleAgents).
      cfg ??= yield* config.get()
      globalMax = Math.max(
        1,
        cfg.workflow?.maxConcurrentAgents ?? Math.min(DEFAULT_MAX_CONCURRENT, 2 * Math.max(1, cpuCount())),
      )
      // Assign synchronously with ??= so two concurrent first-launches that both
      // passed the guard above (the `config.get()` await is a suspension point)
      // converge on ONE semaphore instead of transiently doubling the ceiling.
      // Frozen for the process lifetime: a later config change to
      // maxConcurrentAgents does NOT rebuild it (acceptable while workflow is
      // experimental — the global ceiling is a process/config property).
      globalSem ??= makeSemaphore(globalMax)
      return globalSem
    })

    // Debounced counter flush: coalesce high-rate running/succeeded/failed updates
    // to at most one DB write per ~250ms per run. flushNow is the synchronous final
    // flush on terminal. All best-effort.
    const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const flushNow = (entry: RunEntry) => {
      const t = flushTimers.get(entry.runID)
      if (t) {
        clearTimeout(t)
        flushTimers.delete(entry.runID)
      }
      return WorkflowPersistence.flushCounters({
        runID: entry.runID,
        running: entry.running,
        succeeded: entry.succeeded,
        failed: entry.failed,
      }).pipe(Effect.ignore)
    }
    const scheduleFlush = (entry: RunEntry) => {
      if (flushTimers.has(entry.runID)) return
      flushTimers.set(
        entry.runID,
        setTimeout(() => {
          flushTimers.delete(entry.runID)
          Effect.runFork(
            WorkflowPersistence.flushCounters({
              runID: entry.runID,
              running: entry.running,
              succeeded: entry.succeeded,
              failed: entry.failed,
            }).pipe(Effect.ignore),
          )
        }, 250),
      )
    }

    // Best-effort cleanup for a NON-SUCCESS terminal (cancel, deadline, script
    // failure): graceful-cancel any in-flight child agents and remove every
    // worktree the run still owns, then clear the set. NEVER throws — a reclaim
    // failure must not mask the original terminal cause. NOT called on success:
    // kept (success+changed) worktrees are the deliverable and must survive.
    const reclaim = (entry: RunEntry) =>
      Effect.gen(function* () {
        const actor = spawnRef.current
        if (actor) {
          yield* Effect.forEach(
            [...entry.childActorIDs],
            (childID) => actor.cancel(entry.sessionID, childID, "graceful").pipe(Effect.ignore),
            { concurrency: "unbounded", discard: true },
          )
        }
        yield* Effect.forEach(
          [...entry.worktrees],
          (directory) => worktree.remove({ directory }).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        )
        entry.worktrees.clear()
        // Recurse into child workflow RUNS (populated by workflow()). Cancelling the
        // orchestrator tears down the whole tree — a child still "running" here is
        // cancelled via cancelEntry (mutually recursive with reclaim).
        // SAFETY: childRunIDs edges are parent→child only (added solely at the
        // workflow() call site with a freshly-minted child runID), so the graph is a
        // tree and this recursion is finite. The status-flip guard alone does NOT stop
        // a cycle (a node's flip is post-order, after its reclaim returns), so
        // acyclicity is load-bearing — the workflow() cycle guard (Task 12) is what
        // keeps it true as the call graph grows.
        yield* Effect.forEach(
          [...entry.childRunIDs],
          (childRunID) =>
            Effect.gen(function* () {
              const child = runs.get(childRunID)
              if (child && child.status === "running") yield* cancelEntry(child)
            }).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        )
      })

    const cancelEntry = (entry: RunEntry): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (entry.status !== "running") return
        yield* reclaim(entry)
        yield* flushNow(entry)
        yield* WorkflowPersistence.recordTerminal({ runID: entry.runID, status: "cancelled" }).pipe(Effect.ignore)
        if (entry.fiber) yield* Fiber.interrupt(entry.fiber)
        entry.status = "cancelled"
        yield* Deferred.succeed(entry.deferred, { status: "cancelled" })
        yield* bus.publish(WorkflowFinished, { sessionID: entry.sessionID, runID: entry.runID, status: "cancelled" })
      })

    const waitFor = (childRunID: string) =>
      Effect.gen(function* () {
        const child = runs.get(childRunID)
        if (!child) return { status: "failed" as const, error: "child run missing" }
        return yield* Deferred.await(child.deferred)
      })

    const launch = Effect.fn("WorkflowRuntime.launch")(function* (input: StartInput, runID: string, name: string) {
      // The guest body is the script with the `meta` literal blanked out (parseMeta
      // preserves line numbers). start already validated meta and resume only loads
      // a previously-validated script, so this parse is purely to extract the body;
      // it never gates here. Fall back to the raw script if parse somehow fails.
      const parsed = parseMeta(input.script)
      const body = parsed.ok ? parsed.body : input.script
      // Resolve the workspace root ONCE at launch (the Instance ALS context is
      // live here — the bridge below captures it). Default = the caller's
      // worktree. Captured in the closure so the file hooks read it synchronously
      // and never touch ALS from inside the forked work fiber.
      const workspaceRoot = input.workspace ?? Instance.worktree
      const fileHooks = makeFileHooks(workspaceRoot)
      const deferred = yield* Deferred.make<RunOutcome>()
      const entry: RunEntry = {
        runID,
        sessionID: input.sessionID,
        status: "running",
        deferred,
        fiber: undefined,
        childActorIDs: new Set<string>(),
        worktrees: new Set<string>(),
        childRunIDs: new Set<string>(),
        name,
        running: 0,
        succeeded: 0,
        failed: 0,
        agentCount: 0,
        capWarned: false,
        warnedModelRefs: new Set<string>(),
        currentPhase: undefined,
        transcript: [],
        structure: [],
        currentPhaseId: undefined,
      }
      runs.set(runID, entry)
      // Stamp a sha256 of the FULL script body (the exact bytes writeScript persists
      // and resume's readScript reads back), so resume can detect a between-cycle
      // edit by comparing this to the current file's sha — apples-to-apples, MR104
      // P1-2. recordStart re-stamps it on every (re)launch, so a changed-script
      // relaunch overwrites the stale sha and a subsequent resume replays correctly.
      const scriptSha = createHash("sha256").update(input.script).digest("hex")
      yield* WorkflowPersistence.recordStart({
        runID,
        sessionID: input.sessionID,
        name,
        parentActorID: input.parentActorID,
        args: input.args,
        scriptSha,
        agentTimeoutMs: input.agentTimeoutMs,
      }).pipe(Effect.ignore)
      yield* WorkflowPersistence.writeScript(runID, input.script).pipe(Effect.ignore)

      // Replay journal: prior agent() results (empty on a fresh run). On resume,
      // a cache hit returns instantly with no spawn; misses spawn + append. The
      // occ counter disambiguates byte-identical calls into distinct slots.
      // freshJournal (resume's script-change path) truncates the stale `.jsonl`
      // FIRST so loadJournal returns empty AND the run's appends don't interleave
      // with results journaled against the old script body — a later resume would
      // otherwise read both and replay the wrong results.
      if (input.freshJournal) yield* WorkflowPersistence.clearJournal(runID).pipe(Effect.ignore)
      const journal = yield* WorkflowPersistence.loadJournal(runID)
      const occ = new Map<string, number>()
      const pass = journal.pass

      // Capture the bridge BEFORE forking so it snapshots the caller's
      // Instance/Workspace context — the quickjs Promise boundary in agent()
      // would otherwise lose it.
      const bridge = yield* EffectBridge.make()

      // Resolve the process-wide ceiling NOW (under the live Instance context) so
      // its semaphore object exists before any spawn site closes over it. Sized
      // PURELY from config (memoized after the first launch); a per-launch
      // maxConcurrentAgents never seeds or raises it — it only narrows this run's
      // own semaphore below.
      const globalSemLocal = yield* ensureGlobal()
      // Nesting safety (T12): carried through every run. lineage = resolved names of
      // ancestor workflows (root = empty); depth = this run's level (root = 0). A
      // workflow() whose child name is already in lineage is a cycle, and a child
      // beyond maxDepth is over-deep — both throw at the call site (workflowHook).
      // maxDepth precedence: explicit per-run input > config > module default 8.
      const lineage = input.lineage ?? []
      const depth = input.depth ?? 0
      const maxDepth = input.maxDepth ?? cfg?.workflow?.maxDepth ?? 8
      // Per-run soft cap: defaults to the global ceiling, clamped to ≤ global so a
      // child can shrink its own concurrency but never exceed the process ceiling.
      // The 2×cores clamp is GONE — the global semaphore is the real throttle.
      const requested = input.maxConcurrentAgents ?? globalMax
      const max = Math.max(1, Math.min(requested, globalMax))
      const sem = makeSemaphore(max)
      // Lifecycle cap (total agents over the run's life). Resolved once here so
      // both spawn paths (shared + isolated) share it; over-cap calls return null.
      const lifecycleCap = input.maxLifecycleAgents ?? cfg?.workflow?.maxLifecycleAgents ?? MAX_LIFECYCLE_AGENTS
      // Over-cap → null (see maxLifecycleAgents doc): warn ONCE per run so the
      // dropped work is visible without spamming a log line per over-cap call.
      const warnCapOnce = () => {
        if (entry.capWarned) return
        entry.capWarned = true
        log.warn("workflow lifecycle agent cap reached — over-cap agents return null", {
          runID,
          cap: lifecycleCap,
        })
      }
      // Per-agent wall-clock timeout. Run-level default (OFF unless set); a per-call
      // opts.timeoutMs overrides it. Resolved per agent() call since opts is per-call.
      const runAgentTimeoutMs = input.agentTimeoutMs
      // Race a child's outcome-await against the effective per-agent timeout. On a
      // TRUE timeout: gracefully cancel that one child (the lever reclaim uses) and
      // yield null — the never-throw sentinel the guest already tolerates, so a hung
      // agent can't stall a parallel/pipeline barrier. A genuine null deliverable
      // (agent failed fast) is NOT a timeout → no cancel. No timeout configured
      // (undefined / <=0) ⇒ await unbounded (current behavior, only scriptDeadline bounds).
      const awaitWithTimeout = <A>(
        actorID: string,
        opts: AgentOpts,
        await_: Effect.Effect<A | null>,
        // Optional side-channel: set when the timeout branch wins, so the caller
        // can distinguish a TRUE timeout (reason="timeout") from a fast actor-error
        // null. Never throws; called once at most. Pure observability.
        onTimeout?: () => void,
      ) => {
        const ms = opts.timeoutMs ?? runAgentTimeoutMs
        if (!ms || ms <= 0) return await_
        return Effect.raceFirst(
          await_,
          Effect.sleep(`${ms} millis`).pipe(Effect.as(STRAGGLER_TIMEOUT as unknown as A | null)),
        ).pipe(
          Effect.flatMap((r) =>
            r === (STRAGGLER_TIMEOUT as unknown)
              ? (spawnRef.current
                  ? spawnRef.current.cancel(input.sessionID, actorID, "graceful").pipe(Effect.ignore)
                  : Effect.void
                ).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      try {
                        onTimeout?.()
                      } catch {
                        /* observability must never escape */
                      }
                    }),
                  ),
                  Effect.as(null),
                )
              : Effect.succeed(r),
          ),
        )
      }

      // Publish a WorkflowAgentFailed event for an agent() call that resolved to
      // null. Pure observability — counters and the agent() return value are
      // unaffected. Wrapped in try/catch so a bus problem can never break a run.
      type FailReason = "over-cap" | "spawn-reject" | "timeout" | "actor-error" | "no-deliverable"
      const publishAgentFailed = (
        o: AgentOpts,
        reason: FailReason,
        info: { actorID?: string; errorMessage?: string } = {},
      ) => {
        try {
          Effect.runFork(
            bus
              .publish(WorkflowAgentFailed, {
                sessionID: input.sessionID,
                runID,
                actorID: info.actorID,
                agentType: o.agentType ?? "general",
                label: o.label,
                phase: o.phase ?? entry.currentPhase,
                reason,
                errorMessage: info.errorMessage,
              })
              .pipe(Effect.ignore),
          )
        } catch {
          /* observability must never escape */
        }
      }

      yield* bus.publish(WorkflowStarted, { sessionID: input.sessionID, runID, name })

      // Observability-only spawn description from label/phase: "[Phase] label",
      // or just one of them, or undefined (then spawn falls back to agentType —
      // see spawn.ts `input.description ?? input.agentType`). label/phase NEVER
      // touch currentPhase/counters/schema — they are purely the per-agent tag
      // the actor registry stores and the /workflows view surfaces.
      const spawnDescription = (o: AgentOpts) =>
        o.label ? (o.phase ? `[${o.phase}] ${o.label}` : o.label) : o.phase ? `[${o.phase}]` : undefined

      // Shared-tree spawn (default): the existing behavior. SUBAGENT mode — the
      // worker shares the run's parent session (cheaper, no per-agent session).
      // Safe since lastAssistant is agent-scoped (fix 59597264): each subagent's
      // result is extracted by its own agentID, so concurrent same-session
      // subagents don't cross-contaminate. context:"none" keeps each worker free
      // of parent history (parallel fan-out is the use case). NEVER throw to the
      // guest for spawn/turn failures — resolve to null so the script continues.
      const spawnShared = async (
        actor: NonNullable<typeof spawnRef.current>,
        prompt: string,
        o: AgentOpts,
        resolvedModel: { providerID: ProviderID; modelID: ModelID } | undefined,
        onActorID?: (id: string) => void,
      ) => {
        // COUNTER INVARIANT: running++ exactly once BEFORE the spawn attempt, and
        // running-- + (succeeded XOR failed)++ exactly once AFTER it settles. The
        // bookkeeping lives OUTSIDE the bridge so it still runs when the bridge
        // result is the spawn-reject sentinel (null). Counters settle on whether a
        // DELIVERABLE was produced (value !== null) — the exact thing the guest
        // observes. An agent whose turn errored finishes with status:"success" but
        // no finalText/structured, so its deliverable is null and the guest sees a
        // failure; the counter must agree. A spawn reject also yields null → failed.
        entry.running++
        scheduleFlush(entry)
        // Failure-reason refs: defaults to "actor-error" (the broad catch-all) and
        // is narrowed at known branch points. Read once at the end, on null return,
        // to publish WorkflowAgentFailed. agent()'s null contract is unchanged.
        let reason: FailReason = "actor-error"
        let actorID: string | undefined
        let errorMessage: string | undefined
        const value = await bridge
          .promise(
            Effect.gen(function* () {
              const spawned = yield* actor.spawn({
                mode: "subagent",
                sessionID: input.sessionID,
                agentType: o.agentType ?? "general",
                description: spawnDescription(o),
                task: prompt,
                context: "none",
                tools: o.tools ? [...o.tools] : "INHERIT",
                background: true,
                parentActorID: input.parentActorID,
                model: resolvedModel,
                // Register the child in the reclaim set the instant the actor
                // exists — synchronously inside the spawn Effect, BEFORE its work
                // fiber detaches. A cancel racing this spawn would otherwise miss
                // it (the child runs detached in the actor scope, so interrupting
                // the workflow fiber can't stop it) and leak an orphan. MR104 #2.
                onActorID: (id) => {
                  entry.childActorIDs.add(id)
                  onActorID?.(id)
                },
                ...(o.schema ? { format: { type: "json_schema" as const, schema: o.schema, retryCount: 2 } } : {}),
              })
              actorID = spawned.actorID
              // Bound the outcome-await by the per-agent timeout: a hung child times
              // out to null (and is cancelled) rather than stalling the barrier. The
              // deliverable is computed inside the awaited Effect so the timeout wraps
              // the whole await→extract. schema requested ⇒ structured ?? null (never
              // prose finalText: prose breaks `r.fields`-style scripts + our pipeline).
              const deliverable = yield* awaitWithTimeout(
                spawned.actorID,
                o,
                Deferred.await(spawned.outcome).pipe(
                  Effect.map((outcome) => {
                    if (outcome.status !== "success") {
                      reason = "actor-error"
                      errorMessage = (outcome as { error?: string }).error
                      return null
                    }
                    const v = o.schema
                      ? (outcome.structured ?? null)
                      : (outcome.structured ?? outcome.finalText ?? null)
                    if (v === null) reason = "no-deliverable"
                    return v
                  }),
                ),
                () => {
                  reason = "timeout"
                },
              )
              entry.childActorIDs.delete(spawned.actorID)
              return deliverable
            }),
          )
          .catch((e) => {
            reason = "spawn-reject"
            errorMessage = e instanceof Error ? e.message : String(e)
            return null
          })
        entry.running--
        if (value !== null) entry.succeeded++
        else {
          entry.failed++
          publishAgentFailed(o, reason, { actorID, errorMessage })
        }
        scheduleFlush(entry)
        return value
      }

      // Isolated spawn: fresh worktree, file tools rebound to it via Instance.provide.
      const spawnIsolated = async (
        actor: NonNullable<typeof spawnRef.current>,
        prompt: string,
        o: AgentOpts,
        resolvedModel: { providerID: ProviderID; modelID: ModelID } | undefined,
        onActorID?: (id: string) => void,
      ) => {
        // Failure-reason refs (parallel to spawnShared); see there for rationale.
        let reason: FailReason = "actor-error"
        let actorIDOut: string | undefined
        let errorMessage: string | undefined
        // 1) Create + fully populate a worktree (createFromInfo awaits boot).
        const info = await bridge
          .promise(
            Effect.gen(function* () {
              const i = yield* worktree.makeWorktreeInfo()
              yield* worktree.createFromInfo(i)
              return i
            }),
          )
          .catch((e) => {
            errorMessage = e instanceof Error ? e.message : String(e)
            return null
          })
        if (!info) {
          publishAgentFailed(o, "spawn-reject", { errorMessage })
          return null
        }
        // Register the worktree for cleanup the moment it exists on disk — BEFORE
        // the spawn attempt. If spawn rejects or the agent fails, cancel-cleanup
        // (and the disposition below) can still reclaim it; nothing orphans.
        entry.worktrees.add(info.directory)
        const base = await bridge.promise(worktree.head(info.directory)).catch(() => "")
        // 2) A bridge bound to the worktree's InstanceContext: provide InstanceRef =
        //    worktree ctx so Effect-side reads resolve there; the Instance.provide
        //    wrap below covers raw-ALS tool reads (the load-bearing part). The outer
        //    Instance.provide is what reroutes the agent's file tools; wtBridge is
        //    defense-in-depth for any Effect-side InstanceRef read during dispatch.
        const wtCtx = await Instance.provide({
          directory: info.directory,
          fn: () => Promise.resolve(Instance.current),
        })
        const wtBridge = await bridge.promise(EffectBridge.make().pipe(Effect.provideService(InstanceRef, wtCtx)))
        // 3) Spawn + await INSIDE Instance.provide({worktree}) — AsyncLocalStorage
        //    propagates the worktree dir across the actor's forked work fiber, so the
        //    agent's read/write/bash resolve to the worktree, not the parent tree.
        // COUNTER INVARIANT (isolated path): running++ here, BEFORE the spawn
        // attempt, so it pairs with the settle below regardless of spawn-reject
        // (spawned === null). The settle (running-- + succeeded/failed++) runs once
        // on every disposition path after `succeeded` is known.
        entry.running++
        scheduleFlush(entry)
        const spawned = await Instance.provide({
          directory: info.directory,
          fn: () =>
            wtBridge
              .promise(
                Effect.gen(function* () {
                  const s = yield* actor.spawn({
                    mode: "subagent",
                    sessionID: input.sessionID,
                    agentType: o.agentType ?? "general",
                    description: spawnDescription(o),
                    task: prompt,
                    context: "none",
                    tools: o.tools ? [...o.tools] : "INHERIT",
                    background: true,
                    parentActorID: input.parentActorID,
                    model: resolvedModel,
                    // Same MR104 #2 fix as spawnShared: register the child in the
                    // reclaim set synchronously inside the spawn Effect, before its
                    // work fiber detaches, so a racing cancel never orphans it.
                    onActorID: (id) => {
                      entry.childActorIDs.add(id)
                      onActorID?.(id)
                    },
                    ...(o.schema ? { format: { type: "json_schema" as const, schema: o.schema, retryCount: 2 } } : {}),
                  })
                  actorIDOut = s.actorID
                  // Bound the await by the per-agent timeout. On timeout the helper
                  // cancels the child and yields null; we surface that as a null
                  // `spawned` so the disposition below takes the same path as a
                  // spawn-reject/failure (worktree reclaimed, value null, failed++) —
                  // a hung isolated agent can't stall the barrier or leak a worktree.
                  const outcome = yield* awaitWithTimeout(s.actorID, o, Deferred.await(s.outcome), () => {
                    reason = "timeout"
                  })
                  entry.childActorIDs.delete(s.actorID)
                  if (outcome === null) return null
                  if (outcome.status !== "success") {
                    reason = "actor-error"
                    errorMessage = (outcome as { error?: string }).error
                  }
                  return { actorID: s.actorID, outcome }
                }),
              )
              .catch((e) => {
                reason = "spawn-reject"
                errorMessage = e instanceof Error ? e.message : String(e)
                return null
              }),
        }).catch((e) => {
          reason = "spawn-reject"
          errorMessage = e instanceof Error ? e.message : String(e)
          return null
        })
        // 4) Disposition. KEEP the worktree only when the agent SUCCEEDED and left
        //    changes (the deliverable, surfaced via _worktree). In every other case
        //    — pristine (untouched), spawn rejected, or agent failed/cancelled —
        //    remove it so nothing leaks on disk. Guard: an empty base means head()
        //    failed at create time; treat as CHANGED (never trust an unreliable
        //    pristine check to authorize a delete).
        const succeeded = !!spawned && spawned.outcome.status === "success"
        // Settle the counter once here — after `succeeded` is known and before any
        // disposition branch — so it runs exactly once on every path (spawn-reject
        // → spawned===null → failed++, keep, remove). Pairs with the running++ above.
        // We REUSE the existing `succeeded` discriminant (read-only; the worktree
        // disposition below owns it) rather than the returned deliverable: in the
        // isolated path a successful agent's work is its worktree, so a status
        // success is a success even when it returned no text.
        entry.running--
        if (succeeded) entry.succeeded++
        else {
          entry.failed++
          publishAgentFailed(o, reason, { actorID: actorIDOut, errorMessage })
        }
        scheduleFlush(entry)
        // The success deliverable. When a schema was requested it MUST be the
        // validated structured object — never prose finalText (see the shared-spawn
        // path above for why: prose breaks `r.fields`-style scripts + our pipeline
        // null-injection). schema requested ⇒ structured ?? null.
        const value =
          spawned && spawned.outcome.status === "success"
            ? o.schema
              ? (spawned.outcome.structured ?? null)
              : (spawned.outcome.structured ?? spawned.outcome.finalText ?? null)
            : null
        const pristine =
          base !== "" && (await bridge.promise(worktree.isPristine(info.directory, base)).catch(() => false))
        const keep = succeeded && !pristine
        if (!keep) {
          await bridge.promise(worktree.remove({ directory: info.directory })).catch(() => undefined)
          entry.worktrees.delete(info.directory)
          return succeeded ? value : null
        }
        // keep: the worktree stays on disk and tracked until an integrate step or
        // cancel reclaims it; surface its branch so the script can act on it.
        const wt = { branch: info.branch, directory: info.directory, changed: true }
        if (value && typeof value === "object" && !Array.isArray(value)) return { ...(value as object), _worktree: wt }
        return { _worktree: wt, result: value }
      }

      // Per-call start times (host wall-clock) for the observability nodes' durationMs.
      // Host-side only — never read by the guest, so it doesn't affect determinism/replay.
      const nodeStart = new Map<string, number>()
      const agentImpl = (prompt: unknown, opts?: unknown, nodeId?: string) => {
        const o = (opts ?? {}) as AgentOpts
        const promptStr = String(prompt)
        // Flip the observability node (if any) recorded by the `agent` wrapper for
        // THIS call. Called at the same points that bump succeeded/failed counters.
        // `result` is the agent's deliverable (string / structured object / null);
        // we stash a short summary on the node so the tree shows what it produced.
        const markAgentNode = (status: "succeeded" | "failed", result?: unknown, actorID?: string) => {
          if (!nodeId) return
          const node = entry.structure.find((n) => n.id === nodeId)
          if (node && node.type === "agent") {
            node.status = status
            const start = nodeStart.get(nodeId)
            if (start !== undefined) node.durationMs = Date.now() - start
            if (actorID && node.actorID === undefined) node.actorID = actorID
            const summary = summarizeAgentResult(result)
            if (summary !== undefined) node.resultSummary = summary
          }
        }
        // Fill the node's actorID the instant the child actor is minted (BEFORE it
        // settles), so the TUI can offer "open this agent" while it's still running.
        const setActorID = (actorID: string) => {
          if (!nodeId) return
          const node = entry.structure.find((n) => n.id === nodeId)
          if (node && node.type === "agent" && node.actorID === undefined) node.actorID = actorID
        }
        // Isolated agents are never journaled in v1 (their deliverable is a
        // worktree the journal can't reconstruct) — always spawn.
        if (o.isolation !== "worktree") {
          const base = journalKeyBase(promptStr, {
            agentType: o.agentType,
            model: o.model,
            schema: o.schema,
            phase: o.phase,
          })
          const n = occ.get(base) ?? 0
          occ.set(base, n + 1)
          const key = base + ":" + n
          if (journal.results.has(key)) {
            // Cache hit: no spawn, no agentCount increment (would hit the 1000
            // cap on replays alone). Outcome counter DOES climb so the live view
            // reflects reality as replay proceeds.
            entry.succeeded++
            markAgentNode("succeeded", journal.results.get(key))
            scheduleFlush(entry)
            return Promise.resolve(journal.results.get(key))
          }
          return (async () => {
            // Spawn UNDER the semaphore (governs concurrency). The journal append
            // happens AFTER the slot is released, so file IO never holds a slot.
            const result = await sem.run(async () =>
              globalSemLocal.run(async () => {
                if (entry.agentCount >= lifecycleCap) {
                  warnCapOnce()
                  publishAgentFailed(o, "over-cap")
                  return null
                }
                entry.agentCount++
                const actor = spawnRef.current
                if (!actor) throw new Error("Actor service unavailable")
                // Resolve the guest's model ref host-side AFTER the journal key was
                // computed above (the key hashes the raw `o.model` ref, NOT the
                // resolved struct, so resume keys stay stable across config changes).
                // Never-throws: an unknown group falls back to input.model.
                const resolvedModel = await bridge.promise(resolveAgentModel(o.model, input.model, entry.warnedModelRefs))
                return spawnShared(actor, promptStr, o, resolvedModel, setActorID)
              }),
            )
            markAgentNode(result === null ? "failed" : "succeeded", result)
            // Cache successful results only (null = failure/spawn-reject/killed →
            // not journaled → re-runs on resume, self-heal). SYNCHRONOUS append so
            // the result is durable the instant it resolves: a mid-run process exit
            // / SIGKILL / deadline leaves a journal with every completed agent, which
            // is the whole point of resume. A sync write (unlike an awaited async
            // Effect.promise(fs)) does NOT starve the quickjs sandbox pump — verified.
            // Effect.ignore'd so a write failure can't break the agent.
            if (result !== null) {
              await Effect.runPromise(
                WorkflowPersistence.appendJournalSync(runID, [{ t: "agent", key, result, pass }]).pipe(Effect.ignore),
              )
            }
            return result
          })()
        }
        return sem.run(async () =>
          globalSemLocal.run(async () => {
            if (entry.agentCount >= lifecycleCap) {
              warnCapOnce()
              publishAgentFailed(o, "over-cap")
              markAgentNode("failed")
              return null
            }
            entry.agentCount++
            const actor = spawnRef.current
            if (!actor) throw new Error("Actor service unavailable")
            // Resolve the guest's model ref host-side (isolated agents aren't
            // journaled, so there's no key to keep stable here). Never-throws.
            const resolvedModel = await bridge.promise(resolveAgentModel(o.model, input.model, entry.warnedModelRefs))
            const value = await spawnIsolated(actor, promptStr, o, resolvedModel, setActorID)
            markAgentNode(value === null ? "failed" : "succeeded", value)
            return value
          }),
        )
      }

      // Observability: record a structure node at agent() call time, attributed to
      // the current phase. Status starts "running" and is flipped to succeeded/failed
      // at the SAME sites that bump the succeeded/failed counters (markAgentNode),
      // keyed by this node id. We deliberately do NOT wrap or tap the returned host
      // promise: the sandbox's asyncify-free sync-promise bridge counts pending jobs
      // to drive its pump, so an extra Promise.resolve().then() perturbs settle timing
      // and corrupts counters. The hook returns the host promise untouched.
      const agent: HostFn = (prompt: unknown, opts?: unknown) => {
        const o = (opts ?? {}) as AgentOpts
        const nodeId = "a" + entry.structure.length
        entry.structure.push({
          type: "agent",
          id: nodeId,
          phaseId: entry.currentPhaseId,
          label: o.label,
          agentType: o.agentType ?? "general",
          prompt: String(prompt),
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.tools ? { tools: [...o.tools] } : {}),
          ...(o.schema ? { schema: true } : {}),
          ...(o.isolation === "worktree" ? { isolation: true } : {}),
          status: "running",
        })
        nodeStart.set(nodeId, Date.now())
        return agentImpl(prompt, opts, nodeId)
      }

      const phase: HostFn = (title: unknown) => {
        entry.currentPhase = String(title)
        entry.transcript.push({ kind: "phase", text: String(title) })
        const phaseId = "p" + entry.structure.length
        entry.structure.push({ type: "phase", id: phaseId, title: String(title) })
        entry.currentPhaseId = phaseId
        Effect.runFork(WorkflowPersistence.recordPhase({ runID, phase: String(title) }).pipe(Effect.ignore))
        Effect.runFork(WorkflowPersistence.appendJournal(runID, { t: "phase", title: String(title), pass }).pipe(Effect.ignore))
        Effect.runFork(bus.publish(WorkflowPhase, { sessionID: input.sessionID, runID, title: String(title) }))
        return undefined
      }

      const logHook: HostFn = (message: unknown) => {
        entry.transcript.push({ kind: "log", text: String(message) })
        Effect.runFork(WorkflowPersistence.appendJournal(runID, { t: "log", msg: String(message), pass }).pipe(Effect.ignore))
        Effect.runFork(bus.publish(WorkflowLog, { sessionID: input.sessionID, runID, message: String(message) }))
        return undefined
      }

      // workflow(nameOrScript, args?, opts?) — schedule a CHILD workflow as its
      // own independent sub-run, awaited inline. Mirrors agent()→Actor.spawn one
      // level up: mint a deterministic child runID (stable across resume so the
      // parent journal can find the child), resolve name→script, launch it, await
      // its RunOutcome. A child that fails resolves to null (never-throw, like
      // agent()) so parallel/pipeline over children degrade gracefully. An unknown
      // name THROWS (Effect.die → the guest call rejects → the run fails loud).
      const workflowOcc = new Map<string, number>()
      const workflowHook: HostFn = (nameOrScript: unknown, childArgs?: unknown, opts?: unknown) => {
        const spec = String(nameOrScript)
        const o = (opts ?? {}) as { workspace?: string; maxConcurrentAgents?: number }
        // Content key over the SEMANTIC inputs that reach the child (spec + args).
        // occ disambiguates byte-identical workflow() calls into distinct slots.
        const base = createHash("sha256")
          .update(JSON.stringify({ spec, args: childArgs ?? null }))
          .digest("hex")
        const n = workflowOcc.get(base) ?? 0
        workflowOcc.set(base, n + 1)
        const key = base + ":" + n
        // Parent-journal hit: a completed child replays its result with NO relaunch
        // (the two-level resume short-circuit — parent journal skips the whole child
        // sub-run; the child's own journal would handle agent-level skip if it were
        // re-run). Counts as a succeeded outcome so the live view reflects replay
        // progress. The "wf:" prefix keeps this slot namespace disjoint from agent() keys.
        if (journal.results.has("wf:" + key)) {
          entry.succeeded++
          scheduleFlush(entry)
          return Promise.resolve(journal.results.get("wf:" + key))
        }
        const childRunID = "wf_" + createHash("sha256").update(runID + key).digest("hex")
        return bridge.promise(
          Effect.gen(function* () {
            const childScript = isInlineScript(spec)
              ? spec
              : yield* Effect.promise(() => resolveWorkflowScript(spec, workspaceRoot, Instance.worktree))
            if (childScript === null)
              return yield* Effect.die(new Error(`${WORKFLOW_STRUCTURAL_ERROR}: unknown workflow: ${JSON.stringify(spec)}`))
            // Nesting guards (T12) — LAUNCH path only (a journal HIT early-returned
            // above without deriving childName/childRunID, and a cached child already
            // completed in a prior pass, so re-validating would be wrong). The child's
            // lineage name is its resolved saved name, or a content-hash label for an
            // inline body so distinct inline children don't collide AND an inline body
            // that re-invokes itself is still caught as a cycle. Over-depth and cycle
            // are SCRIPT-LOGIC errors → Effect.die (fail loud), same posture as the
            // unknown-name die above. The guest await rejects → the orchestrator script
            // throws → the parent run fails with this message.
            // NOTE: saved names key on the name alone (args-independent), so saved
            // A→A with different args IS a cycle; an inline body keys on its content
            // hash WHICH INCLUDES args, so inline A→A with different args is NOT a
            // cycle and is bounded only by maxDepth.
            const childName = isInlineScript(spec) ? "inline:" + base.slice(0, 12) : spec
            if (depth + 1 > maxDepth) {
              return yield* Effect.die(new Error(`${WORKFLOW_STRUCTURAL_ERROR}: workflow nesting exceeds maxDepth (${maxDepth})`))
            }
            if (lineage.includes(childName)) {
              return yield* Effect.die(
                new Error(`${WORKFLOW_STRUCTURAL_ERROR}: workflow cycle detected: ${childName} is already an ancestor`),
              )
            }
            entry.childRunIDs.add(childRunID)
            const wfNodeId = "w" + entry.structure.length
            entry.structure.push({
              type: "workflow",
              id: wfNodeId,
              phaseId: entry.currentPhaseId,
              childRunID,
              name: isInlineScript(spec) ? "inline" : spec,
              ...(childArgs !== undefined ? { args: childArgs } : {}),
              status: "running",
            })
            // The child is an independent sub-run: it gets its own per-run lifecycle
            // cap + per-agent timeout (defaults), deliberately NOT inherited from the
            // parent. Tree-wide concurrency is bounded by the global semaphore,
            // not by propagating these per-run knobs.
            yield* launch(
              {
                script: childScript,
                sessionID: input.sessionID,
                parentActorID: input.parentActorID,
                args: childArgs,
                model: input.model,
                // A child may narrow its workspace to a subdir but never widen it
                // beyond the parent's root — resolveInWorkspace throws on escape
                // (a script-logic error → fail loud), same posture as the jail itself.
                workspace: o.workspace ? resolveInWorkspace(workspaceRoot, String(o.workspace)) : workspaceRoot,
                maxConcurrentAgents: o.maxConcurrentAgents,
                scriptDeadlineMs: input.scriptDeadlineMs,
                // Extend the nesting context for the child (T12): append this child to
                // the ancestor lineage, increment depth, carry the same cap down.
                lineage: [...lineage, childName],
                depth: depth + 1,
                maxDepth,
                // A child is awaited inline here (waitFor below) and its outcome is
                // consumed by the parent script — never deliver a separate inbox
                // notification to the parent actor, regardless of the root run's
                // sync/async mode. Only top-level async runs notify.
                notifyOnTerminal: false,
              },
              childRunID,
              isInlineScript(spec) ? "inline" : spec,
            )
            const childOutcome = yield* waitFor(childRunID)
            const wfNode = entry.structure.find((n) => n.id === wfNodeId)
            if (wfNode && wfNode.type === "workflow") wfNode.status = childOutcome.status
            // Structural faults (cycle / depth / unknown-name) are workflow-wiring
            // BUGS, not runtime conditions — propagate them loud instead of degrading
            // to null like a child's runtime failure, so the fault surfaces at the root
            // run. Each ancestor re-dies in turn; slice from the marker so the message
            // doesn't accrete a "workflow script rejected:" prefix at every level.
            if (childOutcome.status === "failed" && childOutcome.error.includes(WORKFLOW_STRUCTURAL_ERROR)) {
              const idx = childOutcome.error.indexOf(WORKFLOW_STRUCTURAL_ERROR)
              return yield* Effect.die(new Error(childOutcome.error.slice(idx)))
            }
            // Runtime failure (NOT structural — that path re-died above): the child's
            // agents failed, it hit its deadline, or it was cancelled. workflow() still
            // returns null (never-throw); this event records WHY for triage. Mirrors
            // WorkflowAgentFailed. Fire-and-forget so a bus problem can't break the run.
            if (childOutcome.status !== "completed") {
              yield* bus
                .publish(WorkflowChildFailed, {
                  sessionID: input.sessionID,
                  runID,
                  childRunID,
                  name: isInlineScript(spec) ? "inline" : spec,
                  status: childOutcome.status, // "failed" | "cancelled"
                  ...(childOutcome.status === "failed" ? { error: childOutcome.error } : {}),
                })
                .pipe(Effect.ignore)
            }
            const value = childOutcome.status === "completed" ? (childOutcome.result ?? null) : null
            // Journal ONLY a successful child (null = failure → not cached → re-runs
            // on resume, self-heal — same contract as agent()). Synchronous append so
            // it survives a mid-run kill.
            if (value !== null) {
              yield* WorkflowPersistence.appendJournalSync(runID, [
                { t: "agent", key: "wf:" + key, result: value, pass },
              ]).pipe(Effect.ignore)
            }
            return value
          }),
        )
      }

      const hooks: Record<string, HostFn> = {
        agent,
        phase,
        log: logHook,
        workflow: workflowHook,
        readFile: fileHooks.readFile,
        writeFile: fileHooks.writeFile,
        glob: fileHooks.glob,
        exists: fileHooks.exists,
      }

      const work = Effect.gen(function* () {
        // Object-form tryPromise: bare tryPromise wraps any rejection as an
        // UnknownError whose .message is the useless "An error occurred in
        // Effect.tryPromise" (the real error lands in .cause), so the failed-run
        // error field / WorkflowFinished.error below would be opaque. Catching to
        // the raw Error makes result.failure the sandbox Error itself, whose
        // .message already carries the guest {name,message,stack} (vm.dump
        // preserves it through the sandbox throw site) — a script-logic crash is
        // then diagnosable from the run's error alone, no repro needed.
        // Per-run PRNG seed = first 4 bytes of sha1(runID). runID is unique-per-run
        // and persisted, so resume of the SAME run derives the SAME seed → guest
        // Math.random replays identically (the replay invariant). Two UNRELATED runs
        // of the same script get DIFFERENT runIDs → different seeds → different
        // sequences, so sampling-style scripts get fresh coverage instead of
        // repeating the same picks. Bun's lifetime-classify verification sample
        // is the motivating use case.
        const seed = createHash("sha1").update(runID).digest().readUInt32BE(0)
        const result = yield* Effect.tryPromise({
          try: () => evalScript(body, hooks, { deadlineMs: input.scriptDeadlineMs ?? SCRIPT_DEADLINE_MS, args: input.args, seed }),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.result)

        if (result._tag === "Success") {
          entry.status = "completed"
          yield* flushNow(entry)
          yield* WorkflowPersistence.recordTerminal({ runID, status: "completed" }).pipe(Effect.ignore)
          yield* Deferred.succeed(deferred, { status: "completed", result: result.success })
          yield* bus.publish(WorkflowFinished, { sessionID: input.sessionID, runID, status: "completed" })
          // Notify the parent so its next turn drains a completion message, the
          // same way background actors notify on terminal (see actor/spawn.ts
          // forkWork.notify). Fire-and-forget: a notify failure (e.g. parent row
          // gone) must never fail the run, and wait-ers are already unblocked
          // above by Deferred.succeed. Skipped when notifyOnTerminal === false (the
          // tool's sync path returns the result inline; a notify would duplicate it).
          if (input.notifyOnTerminal !== false)
            yield* inbox
              .send({
                receiverSessionID: input.sessionID,
                receiverActorID: input.parentActorID,
                senderSessionID: input.sessionID,
                senderActorID: "workflow",
                type: "actor_notification",
                content: `Workflow completed. run_id: ${runID}\n` + JSON.stringify(result.success ?? null).slice(0, 4000),
              })
              .pipe(Effect.ignore)
          return
        }
        // Non-success terminal: reclaim in-flight agents + worktrees so a
        // deadline-fire / script throw leaves a clean slate for a convergent
        // re-run. Success path does NOT reclaim — kept worktrees are the deliverable.
        yield* reclaim(entry)
        const error = result.failure instanceof Error ? result.failure.message : String(result.failure)
        entry.status = "failed"
        log.warn("workflow run failed", { runID, error })
        yield* flushNow(entry)
        yield* WorkflowPersistence.recordTerminal({ runID, status: "failed", error }).pipe(Effect.ignore)
        yield* Deferred.succeed(deferred, { status: "failed", error })
        yield* bus.publish(WorkflowFinished, { sessionID: input.sessionID, runID, status: "failed", error })
        if (input.notifyOnTerminal !== false)
          yield* inbox
            .send({
              receiverSessionID: input.sessionID,
              receiverActorID: input.parentActorID,
              senderSessionID: input.sessionID,
              senderActorID: "workflow",
              type: "actor_notification",
              content: `Workflow failed. run_id: ${runID}\nerror: ${error}`,
            })
            .pipe(Effect.ignore)
      })

      entry.fiber = yield* work.pipe(Effect.forkIn(scope))
      return { runID }
    })

    const start = Effect.fn("WorkflowRuntime.start")(function* (input: StartInput) {
      const parsed = parseMeta(input.script)
      if (!parsed.ok) return yield* Effect.die(parsed.error)
      const runID = Identifier.descending("workflow")
      return yield* launch(input, runID, parsed.meta.name)
    })

    const status = Effect.fn("WorkflowRuntime.status")(function* (input: { runID: string }) {
      const entry = runs.get(input.runID)
      if (!entry) return { status: "unknown" as const, agentCount: 0, running: 0, succeeded: 0, failed: 0 }
      return {
        status: entry.status,
        agentCount: entry.agentCount,
        running: entry.running,
        succeeded: entry.succeeded,
        failed: entry.failed,
        ...(entry.currentPhase !== undefined ? { currentPhase: entry.currentPhase } : {}),
      }
    })

    const transcript = Effect.fn("WorkflowRuntime.transcript")(function* (input: { runID: string }) {
      const entry = runs.get(input.runID)
      return entry ? entry.transcript.slice() : []
    })

    const structure = Effect.fn("WorkflowRuntime.structure")(function* (input: { runID: string }) {
      const entry = runs.get(input.runID)
      return { nodes: entry ? entry.structure.slice() : [] } satisfies WorkflowStructure
    })

    const wait = Effect.fn("WorkflowRuntime.wait")(function* (input: { runID: string; timeoutMs?: number }) {
      const entry = runs.get(input.runID)
      if (!entry) return { status: "failed" as const, error: `unknown runID ${input.runID}` }
      if (input.timeoutMs === undefined) return yield* Deferred.await(entry.deferred)
      const raced = yield* Deferred.await(entry.deferred).pipe(
        Effect.timeout(input.timeoutMs),
        Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
      )
      if (raced === null) return { status: "failed" as const, error: "workflow wait timed out" }
      return raced
    })

    const cancel = Effect.fn("WorkflowRuntime.cancel")(function* (input: { runID: string }) {
      const entry = runs.get(input.runID)
      if (!entry) return
      yield* cancelEntry(entry)
    })

    const list = Effect.fn("WorkflowRuntime.list")(function* (input?: { sessionID?: SessionID }) {
      return yield* WorkflowPersistence.list(input)
    })

    // Re-launch a persisted run under the SAME runID via the shared launch path.
    // recordStart's onConflictDoUpdate flips the existing row back to "running" and
    // runs.set overwrites the stale terminal entry (its old fiber is already done).
    // model/concurrency/deadline are not persisted in v1 — launch applies defaults.
    const resume = Effect.fn("WorkflowRuntime.resume")(function* (input: { runID: string; agentTimeoutMs?: number }) {
      // SERIALIZE same-runID resume with the repo's in-process reader/writer lock
      // (util/lock.ts: a module-global Map mutex). The live-guard below is a
      // check-then-act (read runs.get → decide → launch) and is NOT atomic on its
      // own: two concurrent resume(sameRunID) of a completed run would BOTH read
      // status !== "running", BOTH pass the guard, and BOTH launch() — and launch
      // does runs.set(runID, entry), so the second clobbers the first (orphaned
      // fiber, raced counter flush) and both append to the same .jsonl journal.
      // Holding the write lock across the guard THROUGH launch closes that window:
      // the first waiter launches and flips the entry to "running" before releasing,
      // so the second waiter sees status "running" at the guard and bails. We do NOT
      // hold it for the whole run (launch forks the work fiber and returns once the
      // entry is "running") — only the resume decision + entry creation is serialized.
      // LIMITATION: this is in-process only. Two SEPARATE processes resuming the same
      // runID against the same DB (e.g. two server instances) are NOT covered — there
      // is no shared/file-lock infra in this repo to reuse, and cross-process resume
      // is out of scope for MR104 P2-1.
      // Acquire as a JS Promise<Disposable> (Lock.write is promise-based; there is no
      // existing Effect-context consumer to mirror, so we bridge via Effect.promise),
      // and release in Effect.ensuring so it ALWAYS releases — even if load /
      // readScript / launch throws — otherwise a failed resume would deadlock every
      // future resume of this runID.
      const lock = yield* Effect.promise(() => Lock.write("workflow-resume:" + input.runID))
      return yield* Effect.gen(function* () {
        // Refuse to resume a run that is still LIVE in this process: launch would
        // runs.set() over the live entry, orphaning the running fiber (double parent
        // notify, raced counter flush, unreclaimable by cancel). The DB row is NOT the
        // signal — a process-exited run still reads "running" there and IS resumable;
        // a live `runs` entry means a fiber is actually executing here.
        const live = runs.get(input.runID)
        if (live && live.status === "running") return { runID: input.runID, resumed: false }
        const row = yield* WorkflowPersistence.load(input.runID)
        if (!row) return { runID: input.runID, resumed: false }
        // readScript is Effect.promise — a missing file rejects as a DEFECT, which
        // Effect.exit captures (Effect.result/option/catchAll do not catch defects in
        // this effect version). Treat a missing or empty script as not-resumable.
        const read = yield* WorkflowPersistence.readScript(input.runID).pipe(Effect.exit)
        const script = Exit.isSuccess(read) ? read.value : ""
        if (!script) return { runID: input.runID, resumed: false }
        // Script-change invalidation (MR104 P1-2): the journal keys results by
        // {prompt,agentType,model,schema,phase}+occ, NOT by the script body — so a
        // between-cycle edit would replay OLD results onto NEW code paths (silent
        // divergence). Compare the persisted sha (stamped at the prior launch) to the
        // CURRENT script's sha; on any mismatch — including a null stored sha (a run
        // recorded before this column existed → "unknown" → treat as changed) — pass
        // freshJournal so launch truncates the stale journal and runs from scratch,
        // re-stamping the new sha for the next resume. A match → normal replay.
        const currentSha = createHash("sha256").update(script).digest("hex")
        const freshJournal = row.scriptSha !== currentSha
        yield* launch(
          {
            script,
            sessionID: row.sessionID,
            parentActorID: row.parentActorID ?? "main",
            args: row.args,
            freshJournal,
            // Per-agent timeout: caller's explicit override > persisted value > undefined (off).
            // The row's agent_timeout_ms was stamped at the original launch (or last resume
            // that supplied an explicit override), so a UI-side resume that doesn't know
            // the original launch params (e.g. TUI's /workflows resume) inherits the
            // original timeout instead of silently dropping to unbounded — which used to
            // let a wedged mimo TTFT stall the resumed run forever.
            agentTimeoutMs: input.agentTimeoutMs ?? row.agentTimeoutMs,
          },
          input.runID,
          row.name,
        )
        return { runID: input.runID, resumed: true }
      }).pipe(Effect.ensuring(Effect.sync(() => lock[Symbol.dispose]())))
    })

    const impl = Service.of({ start, status, wait, transcript, structure, cancel, list, resume })
    // Late-bind the impl so the `workflow` tool can resolve it without forcing a
    // WorkflowRuntime.Service requirement onto ToolRegistry.layer. See
    // runtime-ref.ts for rationale.
    workflowRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (workflowRef.current === impl) workflowRef.current = undefined
      }),
    )
    return impl
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(Inbox.defaultLayer),
  Layer.provide(Worktree.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as WorkflowRuntime from "./runtime"
