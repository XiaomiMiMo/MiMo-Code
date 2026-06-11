import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Bus } from "@/bus"
import { Config } from "@/config"
import { Memory } from "@/memory"
import { MemoryFtsTable } from "@/memory/fts.sql"
import { TaskRegistry } from "@/task/registry"
import { ActorRegistry } from "@/actor/registry"
import type { AgentOutcome, ForkContext } from "@/actor/spawn"
import { spawnRef } from "@/actor/spawn-ref"
import { prefixCaptureRef } from "./prefix-capture-ref"
import { Database, and, eq, or } from "@/storage"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { SessionTable } from "./session.sql"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { Log, Token } from "../util"
import { Effect, Layer, Deferred, Context, Scope } from "effect"
import { makeRuntime } from "@/effect/run-service"
import type { ActorPromptOps } from "@/tool/actor"
import type { ProviderID, ModelID } from "../provider/schema"
import PROMPT_CHECKPOINT_WRITER from "@/agent/prompt/checkpoint-writer.txt"
import { WriterCachePerf } from "@/actor/events"
import {
  metaDir,
  checkpointPath,
  memoryPath,
  notesPath,
  globalMemoryPath,
  migrateProjectMemory,
} from "./checkpoint-paths"
import { readBudgeted, readBudgetedSectionAware } from "./budgeted-read"
import type { LastMessageInfo } from "./last-message-info"
import { CHECKPOINT_TEMPLATE, MEMORY_TEMPLATE, NOTES_TEMPLATE, CHECKPOINT_SECTION_BUDGETS } from "./checkpoint-templates"
import { adjustBoundaryForApiInvariants } from "./boundary"
import { alignToNonToolResultUser } from "./checkpoint-align"
import { loadPriorDiscoveredTitles } from "./checkpoint-retry"
import * as CheckpointContext from "./checkpoint-context"
import { buildProgressDiff } from "./checkpoint-progress-reconcile"

const log = Log.create({ service: "session.checkpoint" })

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 60) + "\n... (truncated, full body at file)"
}

function autonomousLoopReminder(): string {
  return [
    "<system-reminder>",
    "You are mid-loop in an autonomous task. Continue your work loop:",
    "respond to the tool results below and proceed to the next iteration.",
    "</system-reminder>",
  ].join("\n")
}

function stopReminder(focusTaskID: string | undefined): string {
  const taskHint = focusTaskID
    ? `Consult this session's tasks/${focusTaskID}/progress.md head section.`
    : "Consult the most recently active task's progress.md head section."
  return [
    "<system-reminder>",
    "The previous assistant turn ended with a stop. Before stopping again,",
    taskHint,
    "Compare the Task spec to the latest Progress entries. If the task is",
    "incomplete, proceed to the next concrete step. Only stop when the spec",
    "is genuinely satisfied or you need user input you cannot infer.",
    "</system-reminder>",
  ].join("\n")
}

function toolResultContinueReminder(): string {
  return [
    "<system-reminder>",
    "Tool results above are real history from the autonomous loop. Process",
    "them and continue to the next iteration. Do not pause to summarize.",
    "</system-reminder>",
  ].join("\n")
}

async function ensureCheckpointTemplate(checkpointFile: string): Promise<void> {
  if (!(await Bun.file(checkpointFile).exists())) {
    await fs.mkdir(path.dirname(checkpointFile), { recursive: true })
    await Bun.write(checkpointFile, CHECKPOINT_TEMPLATE)
  }
}

async function ensureMemoryTemplate(memoryFile: string): Promise<void> {
  if (!(await Bun.file(memoryFile).exists())) {
    await fs.mkdir(path.dirname(memoryFile), { recursive: true })
    await Bun.write(memoryFile, MEMORY_TEMPLATE)
  }
}

async function ensureNotesTemplate(notesFile: string): Promise<void> {
  if (!(await Bun.file(notesFile).exists())) {
    await fs.mkdir(path.dirname(notesFile), { recursive: true })
    await Bun.write(notesFile, NOTES_TEMPLATE)
  }
}

// Tail preservation budget (token-budgeted boundary).
// Session-memory compact: minimum guarantees the LLM has enough
// recent-context anchor (avoids the agent-Read-loop failure mode from
// v4 → v5 spec rationale); maximum is a SOFT ceiling on backward
// expansion — i.e. when the natural tail is below the floor we expand
// backward UP TO maxTokens, but if the natural tail already exceeds
// maxTokens we leave it alone. Single-message-granularity cap would
// break tool_use/result pairing.
//
// 20K is the empirical sweet spot — observed compact output is ~20K,
// not the 40K nominal default. The 40K appears in source as fallback,
// but the upstream config likely tunes it lower in production.
const TAIL_MIN_TOKENS = 10_000
const TAIL_MAX_TOKENS = 20_000
const TAIL_MIN_TEXT_BLOCK_MESSAGES = 5

// Rebuild-time microcompact (see
// docs/superpowers/specs/2026-06-03-rebuild-tail-microcompact-design.md).
//
// After computing the boundary, msgs strictly newer than the boundary
// survive into the rebuild context. Their tool_use parts are kept (so the
// LLM still sees what action was taken), but for tools in this whitelist
// the tool_result content is replaced with a placeholder. Result is either
// large-and-regeneratable (read/bash/grep/glob/webfetch/websearch) or
// essentially a "done" confirmation (edit/write/multiedit). Tools NOT here
// carry state the LLM references later (actor/task/question/skill/memory).
const COMPACTABLE_TOOL_NAMES = new Set<string>([
  "read",
  "bash",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "edit",
  "write",
  "multiedit",
  "apply_patch",
  "codesearch",
])

function estimateMessageTokens(m: { parts: Array<{ type: string; [k: string]: unknown }> }): number {
  // Same estimator used elsewhere in checkpoint.ts (Token.estimate over JSON).
  // Sum across all parts of the message.
  let sum = 0
  for (const p of m.parts) {
    // JSON.stringify throws on circular structures. Parser-produced parts are
    // plain POJOs, but a plugin-injected part could contain a cycle. Fall back
    // to a conservative NON-ZERO estimate so a bad part is never counted as
    // "free" — a 0 here would let the tail-boundary algorithm swallow the part
    // for nothing and skew the budget. The constant overstates a typical part,
    // which is the safe direction (boundary walks back, never forward).
    try {
      sum += Token.estimate(JSON.stringify(p))
    } catch {
      sum += 1000
    }
  }
  return sum
}

function hasTextBlocks(m: { parts: Array<{ type: string }> }): boolean {
  return m.parts.some((p) => p.type === "text" || p.type === "reasoning")
}

/**
 * Token-budgeted, role-aware boundary choice for the preserved tail.
 *
 * Returns the ID of the FIRST message to preserve (boundary message ID;
 * everything strictly before this ID is summarized into checkpoint.md and
 * discarded from the rebuild context).
 *
 * Algorithm (token-budgeted boundary):
 *
 * 1. Start at the last finished assistant index minus 1, take it+successors
 *    as the candidate tail (preserves spec 2 starting point so reasonable
 *    tails are unchanged).
 * 2. If tail tokens already >= TAIL_MAX_TOKENS: leave boundary as-is and
 *    return. Do NOT pull boundary forward — message-granularity truncation
 *    would split tool_use/tool_result pairs (downstream
 *    adjustBoundaryForApiInvariants would just walk back, net no-op + risk
 *    of thinking-block breaks). The cap is a SOFT ceiling on backward
 *    expansion, not a hard upper bound on tail size. If a single
 *    assistant turn legitimately produces 60K of tool_result, the tail
 *    will be 60K and that's fine.
 * 3. Else if tail tokens < TAIL_MIN_TOKENS or text-block messages < min:
 *    walk backward (earlier) one message at a time until both minimums
 *    met OR TAIL_MAX_TOKENS hit OR no more messages.
 *
 * The downstream adjustBoundaryForApiInvariants call (in
 * tryStartCheckpointWriter) handles tool_use/tool_result pairing and
 * thinking-block atomicity — this function does NOT need to.
 *
 * Edge cases:
 * - msgs.length === 0: return "" (matches old behavior).
 * - No finished assistant: return msgs[0].info.id (degenerate; caller should
 *   not be invoking trim here, but stay safe).
 * - lastAsstIdx === 0: return msgs[0].info.id (degenerate tail).
 */
export function computeBoundary(
  msgs: ReadonlyArray<{ info: { id: string; role: "user" | "assistant"; finish?: string }; parts: Array<{ type: string; [k: string]: unknown }> }>,
): string {
  if (msgs.length === 0) return ""
  const lastAsstIdx = msgs.findLastIndex(
    (m) => m.info.role === "assistant" && m.info.finish !== undefined,
  )
  if (lastAsstIdx <= 0) return msgs[lastAsstIdx >= 0 ? lastAsstIdx : 0].info.id

  // Token estimate per message (computed once).
  const tokens = msgs.map((m) => estimateMessageTokens(m))

  // Spec 2 starting point: lastAsstIdx - 1.
  let startIdx = lastAsstIdx - 1
  let tailSum = 0
  let textBlockCount = 0
  for (let i = startIdx; i < msgs.length; i++) {
    tailSum += tokens[i]
    if (hasTextBlocks(msgs[i])) textBlockCount += 1
  }

  // Natural tail already >= cap: leave it alone (soft ceiling; do NOT pull
  // boundary forward — see jsdoc rationale).
  if (tailSum >= TAIL_MAX_TOKENS) {
    return msgs[startIdx].info.id
  }

  // Tail too small — pull boundary earlier (include more history)
  // until both floors met, capped at TAIL_MAX_TOKENS.
  while (
    startIdx > 0 &&
    tailSum < TAIL_MAX_TOKENS &&
    (tailSum < TAIL_MIN_TOKENS || textBlockCount < TAIL_MIN_TEXT_BLOCK_MESSAGES)
  ) {
    startIdx -= 1
    tailSum += tokens[startIdx]
    if (hasTextBlocks(msgs[startIdx])) textBlockCount += 1
  }
  return msgs[startIdx].info.id
}

function renderSectionBudgets(budgets: Record<string, number>): string {
  const entries = Object.entries(budgets)
  if (entries.length === 0) {
    throw new Error("CHECKPOINT_SECTION_BUDGETS is empty — F43 substitution would produce an empty prompt block")
  }
  const cols = 3
  const lines: string[] = ["Section budgets (~tokens):"]
  for (let i = 0; i < entries.length; i += cols) {
    const row = entries
      .slice(i, i + cols)
      .map(([k, v]) => `${k}: ${v}`)
      .join("    ")
    lines.push(`   ${row}`)
  }
  return lines.join("\n")
}

/**
 * Composes the full writer prompt for the checkpoint subagent.
 *
 * The body wraps PROMPT_CHECKPOINT_WRITER with an ABSOLUTE-PATHS preamble
 * that pins CHECKPOINT_PATH/MEMORY_PATH/TASK_MEM_DIR to the current session's
 * dirs — without this, the model frequently invents legacy `/data/checkpoints/`
 * style paths from training-data lookalikes.
 */
function composeWriterPrompt(input: {
  checkpointFile: string
  memoryFile: string
  taskMemDir: string
  notesFile: string
  rangeDesc: string
  progressDiff: string  // Spec ② Chain 2: empty string when nothing to reconcile
}): string {
  return [
    "<system-reminder>",
    "You are now operating in checkpoint-writer mode. Ignore the general coding-assistant framing in the system prompt above. The read, write, edit, glob, grep, and task tools are available; do not invoke others.",
    "",
    "========================================================================",
    "ABSOLUTE PATHS — USE THESE VERBATIM. NEVER COMPUTE, INFER, OR MODIFY.",
    "========================================================================",
    "",
    `CHECKPOINT_PATH = ${input.checkpointFile}`,
    `MEMORY_PATH     = ${input.memoryFile}`,
    `TASK_MEM_DIR    = ${input.taskMemDir}`,
    `NOTES_PATH      = ${input.notesFile}`,
    "",
    "When using the Write tool, the first arg MUST be one of these literal",
    "absolute paths (or for task narrative, TASK_MEM_DIR + '/' + task_id +",
    "'/progress.md' or '/notes.md'). Do NOT abbreviate. Do NOT change",
    "parent directories. Do NOT insert paths from memory of similar projects.",
    "If you find yourself typing '/data/checkpoints/' as a parent, STOP — that",
    "is the legacy v2 layout and is wrong. The current parent for the",
    "checkpoint file is the directory portion of CHECKPOINT_PATH above.",
    "========================================================================",
    "",
    input.progressDiff,
    "",
    PROMPT_CHECKPOINT_WRITER.replace("{{SECTION_BUDGETS}}", renderSectionBudgets(CHECKPOINT_SECTION_BUDGETS)),
    "</system-reminder>",
    "",
    `Write the next checkpoint for this session.`,
    "",
    input.rangeDesc,
    "",
    "Use the `task` tool for ALL task state ops (create / start / progress / done / abandon / approve / rename / block / unblock / batch_create). Use the Write tool for the checkpoint, memory, and task narrative files at the CHECKPOINT_PATH / MEMORY_PATH / TASK_MEM_DIR locations declared above. After all writes and tool calls, stop immediately.",
  ].join("\n")
}

function aggregateWriterCacheMetrics(
  sessions: Session.Interface,
  sessionID: SessionID,
  actorID: string,
) {
  return Effect.gen(function* () {
    const msgs = yield* sessions.messages({ sessionID, agentID: "*" })
    let totalInput = 0
    let cacheRead = 0
    let cacheWrite = 0
    let assistantCount = 0
    for (const m of msgs) {
      if (m.info.role !== "assistant") continue
      if (m.info.agentID !== actorID) continue
      // Count every assistant LLM call in the slice, even ones without
      // billing-token data (errors / mid-stream interrupts). Token sums
      // skip the no-data rows; the call count includes them so downstream
      // consumers can distinguish "low cache hit" from "few calls".
      assistantCount += 1
      const t = m.info.tokens
      if (!t) continue
      totalInput += (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
      cacheRead += t.cache?.read ?? 0
      cacheWrite += t.cache?.write ?? 0
    }
    const billable = totalInput - cacheRead - cacheWrite
    const denom = cacheRead + Math.max(billable, 0)
    const hitRate = denom > 0 ? cacheRead / denom : 0
    return {
      total_input_tokens: totalInput,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cache_hit_rate: hitRate,
      num_llm_calls: assistantCount,
    }
  })
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type TryStartCheckpointWriterInput = {
  sessionID: SessionID
  model: { providerID: string; modelID: string }
  promptOps: ActorPromptOps
}

/**
 * Outcome of a tryStartCheckpointWriter call:
 * - "started": no writer was running for this session, a fresh one was forked.
 * - "queued":  a writer is already running. The new request is held in the
 *              1-slot pending queue and will fire once the current writer
 *              settles. If a pending request already exists it's evicted —
 *              newest wins because its range is a strict superset of the
 *              older pending range, so the older one would just duplicate
 *              work. (F40)
 * - "skipped": the request was rejected outright — empty session, system-
 *              spawned subagent, or Actor service unavailable. No writer
 *              will fire for this request now or later.
 */
export type TryStartCheckpointWriterResult = "started" | "queued" | "skipped"

export interface Interface {
  readonly tryStartCheckpointWriter: (
    input: TryStartCheckpointWriterInput,
  ) => Effect.Effect<TryStartCheckpointWriterResult>

  readonly waitForWriter: (sessionID: SessionID) => Effect.Effect<WriterOutcome | "no-writer">

  /**
   * Await all in-flight writers across sessions up to `timeoutMs`. Used by
   * the CLI shutdown path so headless `mimo run` invocations don't exit
   * while a forked checkpoint writer is still waiting on its LLM round-trip.
   * Returns the count of writers that completed vs. still pending when the
   * timeout fired.
   */
  readonly drainWriters: (input?: { timeoutMs?: number }) => Effect.Effect<{
    drained: number
    timedOut: number
  }>

  readonly hasCheckpoint: (sessionID: SessionID) => Effect.Effect<boolean>

  /**
   * Returns true when the session has any memory artifacts:
   * either a populated `<data>/memory/sessions/<sid>/` directory, or
   * any tasks recorded in the task registry. Used by the per-user-message
   * recall reminder so it fires whenever there is anything to recall —
   * not only when classic v2 checkpoints exist.
   */
  readonly hasMemoryOrTasks: (sessionID: SessionID) => Effect.Effect<boolean>

  /** Returns the content of the latest checkpoint file, or undefined if none exists. */
  readonly loadLatest: (sessionID: SessionID) => Effect.Effect<string | undefined>

  /** Returns the content of the last N checkpoint files, ordered oldest to newest. */
  readonly loadCheckpoints: (sessionID: SessionID, count: number) => Effect.Effect<string[]>

  /** Returns a human-readable index overview for injection into rebuild context. */
  readonly renderIndex: (sessionID: SessionID) => Effect.Effect<string>

  /**
   * Returns the rebuild-time context that should be injected after trim.
   * Format:
   *   <system-reminder>Verify-before-act note...</system-reminder>
   *   ## Accumulated learnings (chronological)
   *   ### From checkpoint #1 (<topic>)
   *   <Learning body>
   *   ...
   *   ## Current snapshot (as of checkpoint #N)
   *   <Snapshot body>
   *
   * Stale Snapshots from older checkpoints are intentionally dropped. Returns
   * an empty string if no checkpoints exist. When checkpoints exist but all
   * Learning sections are empty, emits "(no prior learnings)" placeholder;
   * when the latest checkpoint has no Snapshot section, emits
   * "(latest checkpoint has no Snapshot section)" placeholder — the full
   * structure is always produced so the verify-before-act reminder is
   * consistently visible.
   */
  readonly renderRebuildContext: (
    sessionID: SessionID,
    opts?: { lastMessageInfo?: LastMessageInfo; agentID?: string },
  ) => Effect.Effect<string>

  readonly lastBoundary: (sessionID: SessionID) => Effect.Effect<MessageID | undefined>

  readonly isWriterRunning: (sessionID: SessionID) => Effect.Effect<boolean>

  /**
   * Insert a synthetic checkpoint-boundary user message (boundary marker +
   * index overview + rebuild context + active-actors text) just after the
   * given boundary. Inserts nothing and returns false when rebuild context is
   * empty. Never deletes DB messages.
   */
  readonly insertRebuildBoundary: (input: {
    sessionID: SessionID
    boundary: MessageID
    lastMessageInfo?: LastMessageInfo
    agentID?: string
    agent: string
    model: { providerID: string; modelID: string }
    boundaryCreatedAt?: number
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCheckpoint") {}

// ---------------------------------------------------------------------------
// Writer state per session
// ---------------------------------------------------------------------------

export type WriterOutcome = "success" | "failure"

interface WriterState {
  // Holds the AgentOutcome Deferred returned by Actor.spawn so callers can
  // await writer settlement (waitForWriter / drainWriters). The public
  // WriterOutcome translation happens in waitForWriter.
  writing: Deferred.Deferred<AgentOutcome>
  // F40: 1-slot pending queue. When set, holds the input for a writer that
  // should fire as soon as `writing` settles. Newer requests evict older
  // pending values — the newest range is always a strict superset of the
  // older one, so older pending checkpoints would only duplicate work.
  pending?: TryStartCheckpointWriterInput
}

// ---------------------------------------------------------------------------
// Layer implementation
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<
  Service,
  never,
  Session.Service | Bus.Service | Config.Service | Memory.Service | TaskRegistry.Service | ActorRegistry.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const memory = yield* Memory.Service
    const taskRegistry = yield* TaskRegistry.Service
    const actorRegistry = yield* ActorRegistry.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    // Plain Map in the layer closure — same approach as compaction.ts
    const writers = new Map<SessionID, WriterState>()

    const tryStartCheckpointWriter: (
      input: TryStartCheckpointWriterInput,
    ) => Effect.Effect<TryStartCheckpointWriterResult> = Effect.fn("SessionCheckpoint.tryStartCheckpointWriter")(function* (
      input: TryStartCheckpointWriterInput,
    ) {
      // F40: writer1 still running. Evict any prior pending and queue this
      // request — newest wins because its range is a strict superset of the
      // older pending range, so older pending checkpoints would only
      // duplicate the work.
      const existing = writers.get(input.sessionID)
      if (existing) {
        if (existing.pending) {
          log.info("writer pending evicted (newer range arrived)", { sessionID: input.sessionID })
        } else {
          log.info("writer already running, queueing", { sessionID: input.sessionID })
        }
        existing.pending = input
        return "queued" as const
      }

      // Defensive: skip if called for a system-spawned session. With Task 27's
      // writer-as-subagent migration this becomes mostly impossible, but the
      // guard stays so future paths that fold a system-spawn actor into the
      // main loop don't accidentally re-enter the writer.
      if (yield* actorRegistry.isSystemSpawned(input.sessionID, "main")) {
        log.info("tryStartCheckpointWriter skipping system-spawned session")
        return "skipped" as const
      }

      // Mirror parent runLoop's view (prompt.ts:2036-2040) so the writer's
      // ForkContext is byte-equal at the watermark moment. Reading the
      // unfiltered session stream would let computeBoundary land on a
      // subagent/prior-writer assistant turn and misalign the prefix cache.
      const sessionInfo = yield* session.get(input.sessionID)
      const msgs = yield* MessageV2.filterCompactedEffect(input.sessionID, {
        contextFrom: sessionInfo.contextFrom,
        contextWatermark: sessionInfo.contextWatermark,
        agentID: "main",
      })
      if (msgs.length === 0) {
        log.info("no messages, skipping checkpoint", { sessionID: input.sessionID })
        return "skipped" as const
      }

      // Compute boundary for last_checkpoint_message_id bookkeeping. Layer 6
      // (Task 16): role-aware adjustment to ensure tool_use/tool_result pairs
      // and same-message.id thinking blocks aren't split. OpenCode's ToolPart
      // carries both use (input) and result (output) on the SAME message, so
      // we project each ToolPart to both a tool_use and a tool_result block —
      // pairing is intrinsically satisfied today and the algorithm acts as a
      // no-op. Wiring is in place so future tool_result extraction
      // (separate user message) will walk the boundary correctly
      // without further changes here.
      const candidateID = computeBoundary(msgs)
      const candidateIdx = msgs.findIndex((m) => m.info.id === candidateID)
      const adjustedIdx = adjustBoundaryForApiInvariants(
        msgs.map((m) => ({
          role: m.info.role,
          id: m.info.id,
          content: m.parts.flatMap((p) =>
            p.type === "tool"
              ? [
                  { type: "tool_use", id: p.callID },
                  { type: "tool_result", tool_use_id: p.callID },
                ]
              : [],
          ),
        })),
        Math.max(candidateIdx, 0),
      )
      const endMessageID = msgs[adjustedIdx]?.info.id ?? candidateID

      // v5 paths: single checkpoint.md per session, single memory.md per
      // project (carries across sessions in the same repo), task narrative
      // under <sid>/tasks/<id>/. Resolve projectID once HERE — Instance.current
      // is ALS-bound and lost once the writer subagent fiber detaches.
      const projectID =
        (yield* Effect.try({
          try: () => Instance.current?.project?.id as ProjectID | undefined,
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))) ?? ProjectID.global
      const sessMemDir = metaDir(input.sessionID)
      const projectMemDir = path.join(Global.Path.data, "memory", "projects", projectID)
      const checkpointFile = checkpointPath(input.sessionID)
      const memoryFile = memoryPath(projectID)
      const taskMemDir = path.join(sessMemDir, "tasks")
      const notesFile = notesPath(input.sessionID)

      // Ensure dirs exist before writer fires
      yield* Effect.promise(() => fs.mkdir(sessMemDir, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(taskMemDir, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(projectMemDir, { recursive: true }))

      // Migrate legacy lowercase memory.md → MEMORY.md before templating/reading.
      yield* Effect.promise(() => migrateProjectMemory(projectID))

      // Bootstrap checkpoint.md, memory.md, and notes.md from templates if missing.
      // Self-contained helpers also mkdir parent so they're safe in isolation.
      yield* Effect.promise(() => ensureCheckpointTemplate(checkpointFile))
      yield* Effect.promise(() => ensureMemoryTemplate(memoryFile))
      yield* Effect.promise(() => ensureNotesTemplate(notesFile))

      // v5: single-file checkpoint, check if prior content exists
      const checkpointExists = yield* Effect.promise(() => Bun.file(checkpointFile).exists())
      const memoryExists = yield* Effect.promise(() => Bun.file(memoryFile).exists())
      const rangeDesc = checkpointExists
        ? [
            `Previous checkpoint: ${checkpointFile}`,
            memoryExists ? `Previous memory: ${memoryFile}` : "",
            "Read BOTH the prior checkpoint (to dedupe Discovered/Dead-end titles AND to carry forward Live Resources, Execution-context frames, and Session-metadata fields that are still alive) AND the prior memory (project memory) before writing yours.",
          ]
            .filter((s) => s.length > 0)
            .join("\n")
        : "This is the first checkpoint of this session. No prior checkpoint exists; MEMORY.md and the task narrative directory likely don't exist yet either."

      const progressDiff = yield* Effect.promise(() => buildProgressDiff(input.sessionID))
      const promptText = composeWriterPrompt({ checkpointFile, memoryFile, taskMemDir, notesFile, rangeDesc, progressDiff })

      // v6: spawn writer as subagent — shared sessionID, automatic
      // ActorRegistry registration, automatic tool whitelist enforcement
      // via permission system. Replaces the legacy session.create + manual
      // forkDetach + WriterState tracking that lived here pre-Task-27.
      //
      // Resolved via spawnRef rather than `yield* Actor.Service` to break the
      // (Actor → SessionPrompt → SessionCheckpoint → Actor) layer cycle.
      const actor = spawnRef.current
      if (!actor) {
        log.warn("tryStartCheckpointWriter skipping — Actor service unavailable", { sessionID: input.sessionID })
        return "skipped" as const
      }

      // Axis B: branch forkContext shape on config.checkpoint.fork.
      // - true  → preserve existing prefix-cache parent-fork behavior
      //          (parent agent's system + tools, full slice up to watermark).
      // - false → cold-start: writer's own system + tools, delta slice since
      //          last_checkpoint_message_id (aligned past tool_use/tool_result).
      // See spec 2026-06-09-checkpoint-writer-child-session-and-no-fork-fallback-design.md §3.
      //
      // Default-behavior change at this PR: previously the writer always forked
      // the parent's full prefix (effectively fork: true). The default is now
      // false (no-fork delta-only). Users on cache-breakpoint providers
      // (Anthropic) who want to retain the prefix-cache benefit must set
      // `checkpoint.fork: true` in their config. See the spec at
      // docs/superpowers/specs/2026-06-09-checkpoint-writer-child-session-and-no-fork-fallback-design.md §4.5.
      const cfg = yield* config.get()
      const forkMode = cfg.checkpoint?.fork ?? false

      const parentRow = yield* Effect.sync(() =>
        Database.use((d) =>
          d.select({ last: SessionTable.last_checkpoint_message_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.sessionID))
            .get(),
        ),
      ).pipe(Effect.catch(() => Effect.succeed(undefined as { last: MessageID | null } | undefined)))
      const lastCheckpointMessageID = parentRow?.last ?? undefined

      // Hoisted watermark + delta computation: must run BEFORE session.create
      // so an empty-delta fork:false call short-circuits to "skipped" without
      // creating a child session or invoking actor.spawn. Pre-fix, the
      // empty-delta path fell through to spawn → runLoop's
      // `isForkAgent && !forkCtx → break` → settle watcher resolved success →
      // parent's last_checkpoint_message_id advanced silently (stale checkpoint).
      const watermarkIdx = msgs.findIndex((m) => m.info.id === endMessageID)
      if (watermarkIdx < 0) {
        log.warn("tryStartCheckpointWriter: watermark message not found, skipping", {
          sessionID: input.sessionID,
          endMessageID,
        })
        return "skipped" as const
      }

      // For fork:false only: precompute the aligned delta and bail if empty.
      // fork:true uses msgs.slice(0, watermarkIdx + 1) which is never empty
      // given msgs.length > 0 and watermarkIdx >= 0.
      const lastIdx = lastCheckpointMessageID
        ? msgs.findIndex((m) => m.info.id === lastCheckpointMessageID)
        : -1
      const rawDeltaStart = lastIdx >= 0 ? lastIdx + 1 : 0
      const alignedStart = alignToNonToolResultUser(
        msgs.map((m) => ({ info: { role: m.info.role }, parts: m.parts })),
        rawDeltaStart,
      )
      const delta = forkMode ? [] : msgs.slice(alignedStart, watermarkIdx + 1)
      if (!forkMode && delta.length === 0) {
        // Empty delta under fork:false signals either (a) a degenerate
        // session, or (b) a bug elsewhere advanced last_checkpoint_message_id
        // past the watermark. Either way, spawning a writer would be a
        // silent no-op that would still advance the watermark on settle —
        // skip visibly so it's observable in logs.
        log.warn("tryStartCheckpointWriter: empty delta under fork:false, skipping", {
          sessionID: input.sessionID,
          endMessageID,
          lastCheckpointMessageID,
        })
        return "skipped" as const
      }

      // Capture parent's view at the watermark for prefix-cache alignment.
      // See docs/superpowers/specs/2026-05-26-fork-agent-prefix-cache-design.md
      //
      // prefixCaptureRef is populated by SessionPrompt.layer to break the
      // (ToolRegistry → SessionCheckpoint → ToolRegistry) layer cycle.
      const buildPrefix = prefixCaptureRef.current
      if (!buildPrefix) {
        log.warn("tryStartCheckpointWriter: prefixCaptureRef not set, spawning without forkContext", {
          sessionID: input.sessionID,
        })
      }
      const forkCtx: ForkContext | undefined = yield* (buildPrefix
        ? Effect.gen(function* () {
            const watermarkMsg = msgs[watermarkIdx]
            const parentAgentName = (watermarkMsg.info as { agent?: string }).agent
            // NOTE: parentAgentName guard is scoped to the forkMode:true branch only —
            // fork:false is agent-name-independent (always passes "checkpoint-writer"
            // to buildPrefix), so a missing parent agent field must not gate it.

            if (forkMode) {
              if (!parentAgentName) {
                log.warn(
                  "tryStartCheckpointWriter: watermark has no agent, fork:true requires parent agent — falling back to no forkContext",
                  { sessionID: input.sessionID, endMessageID },
                )
                return undefined as ForkContext | undefined
              }
              // fork:true — preserve existing prefix-cache parent-fork behavior.
              // Build system + tools + inheritedMessages snapshot via capture ref
              // using the parent agent's identity and the full slice up to watermark.
              // The closure inside SessionPrompt.layer resolves Agent.Info and Provider.Model.
              const msgsAtWatermark = msgs.slice(0, watermarkIdx + 1)
              const prefix = yield* buildPrefix({
                sessionID: input.sessionID,
                agentName: parentAgentName,
                providerID: input.model.providerID,
                modelID: input.model.modelID,
                msgs: msgsAtWatermark,
              })
              return {
                system: prefix.system,
                tools: prefix.tools,
                inheritedMessages: prefix.inheritedMessages,
                parentPermission: prefix.parentPermission,
                watermarkMsgID: endMessageID as MessageID,
                model: {
                  providerID: input.model.providerID as ProviderID,
                  modelID: input.model.modelID as ModelID,
                },
              } satisfies ForkContext
            }

            // fork:false — cold-start: use the writer's own system + tools and
            // a delta slice since the last checkpoint. capture() resolves the
            // checkpoint-writer agent's own definition when agentName is
            // "checkpoint-writer", so a single call returns:
            //   - system + tools = writer's (because agentName === "checkpoint-writer"),
            //   - inheritedMessages = the delta we pass in, converted to ModelMessage[],
            //   - parentPermission = writer's own permission (used for tool-availability filter).
            // Earlier draft considered two buildPrefix calls (one with msgs:[] for
            // system+tools, one with msgs:delta for messages); rejected because
            // buildLLMRequestPrefix `Effect.die`s if msgs has no user message.
            // Delta is precomputed (and the empty-delta case is short-circuited)
            // above, before session.create.
            const writerPrefix = yield* buildPrefix({
              sessionID: input.sessionID,
              agentName: "checkpoint-writer",
              providerID: input.model.providerID,
              modelID: input.model.modelID,
              msgs: delta,
            })

            return {
              system: writerPrefix.system,
              tools: writerPrefix.tools,
              inheritedMessages: writerPrefix.inheritedMessages,
              parentPermission: writerPrefix.parentPermission,
              watermarkMsgID: endMessageID as MessageID,
              model: {
                providerID: input.model.providerID as ProviderID,
                modelID: input.model.modelID as ModelID,
              },
            } satisfies ForkContext
          })
        : Effect.succeed(undefined as ForkContext | undefined))

      // Axis A: writer always runs in a fresh child session. This isolates the
      // writer's messages and actor registration from the parent so:
      //   - parent's message table sees zero new rows,
      //   - parent's `sync.data.actor[parent]` does not include the writer,
      //   - Ctrl+X subagent cycle / SubagentFooter / DialogSubagent / etc. are
      //     all naturally clean (they all key on sessionID).
      // The writer's checkpoint.md / memory.md / progress paths are absolute and
      // computed from input.sessionID (parent) above, so file writes still target
      // the parent's artifacts. Settle watcher below also targets parent.
      // See spec 2026-06-09-checkpoint-writer-child-session-and-no-fork-fallback-design.md §2.
      const writerChildSession = yield* session.create({
        parentID: input.sessionID,
        title: `checkpoint-writer: ${rangeDesc}`,
      })

      // Estimate delta tokens for observability. forkCtx.inheritedMessages is
      // ModelMessage[]; an exact count requires the tokenizer, but a rough
      // length heuristic is sufficient for the log line.
      const deltaApproxBytes = JSON.stringify(forkCtx?.inheritedMessages ?? []).length
      log.info("tryStartCheckpointWriter spawning", {
        sessionID: input.sessionID,
        childSessionID: writerChildSession.id,
        mode: forkMode ? "fork" : "no-fork",
        deltaApproxBytes,
        rangeDesc,
      })

      const result = yield* actor.spawn({
        mode: "subagent",
        sessionID: writerChildSession.id,
        // Axis A: writer runs under child session, but its checkpoint.md /
        // memory.md / progress paths AND CheckpointContext entries are keyed
        // on the PARENT. The splitover plugin reads these via actor.preStop
        // and must see parentSessionID to re-derive the right paths — without
        // it, checkpointPath(child) returns an empty file and the plugin
        // emits a false topic-missing reflection that loops the writer up to
        // MAX_PRE_REACT.
        parentSessionID: input.sessionID,
        agentType: "checkpoint-writer",
        description: `checkpoint writer for session ${input.sessionID} covering ${rangeDesc}`,
        task: promptText,
        context: "full",
        tools: ["read", "write", "edit", "apply_patch", "glob", "grep", "task"],
        model: {
          providerID: input.model.providerID as ProviderID,
          modelID: input.model.modelID as ModelID,
        },
        background: true,
        forkContext: forkCtx,
      })

      const actorID = result.actorID

      // Capture priorTitles (from checkpoint.md as it stood at the watermark)
      // and register the per-actor context entry BEFORE the writer's first
      // turn so the splitover plugin's preStop hook can read it. The set
      // runs in microseconds; the writer's first LLM round-trip takes
      // seconds — no race in practice. See spec §6.1.
      const priorTitles = yield* Effect.promise(() => loadPriorDiscoveredTitles(input.sessionID))
      CheckpointContext.set(input.sessionID, actorID, {
        priorTitles,
        expectedRevisions: [],
      })

      writers.set(input.sessionID, { writing: result.outcome })

      // Bookkeeping: the parent's last_checkpoint_message_id advances when the
      // writer settles. Fork into the layer's scope so the watcher survives
      // tryStartCheckpointWriter returning (background: true semantics) but is still tied
      // to the layer's lifetime — no orphan fiber on shutdown.
      yield* Effect.gen(function* () {
        const outcome = yield* Deferred.await(result.outcome)
        yield* Effect.sync(() =>
          Database.use((d) =>
            d.update(SessionTable)
              .set({ last_checkpoint_message_id: endMessageID as MessageID })
              .where(eq(SessionTable.id, input.sessionID))
              .run(),
          ),
        )

        // F40: capture pending before deleting the slot so a queued writer
        // (held while writer1 was running) can fire as a fresh writer.
        const pending = writers.get(input.sessionID)?.pending
        writers.delete(input.sessionID)

        // F44: aggregate writer slice tokens and emit cache-perf metric so
        // prefix-cache reuse is empirically observable. Degrades to zeros if
        // aggregation fails (e.g. session messages unavailable post-shutdown).
        const stats = yield* aggregateWriterCacheMetrics(session, input.sessionID, result.actorID).pipe(
          Effect.catch(() =>
            Effect.succeed({
              total_input_tokens: 0,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              cache_hit_rate: 0,
              num_llm_calls: 0,
            }),
          ),
        )
        yield* bus
          .publish(WriterCachePerf, {
            sessionID: input.sessionID,
            writerActorID: result.actorID,
            status: outcome.status === "success" ? ("completed" as const) : ("failed" as const),
            ...stats,
          })
          .pipe(Effect.ignore)

        // F40: drain pending. If a queued request exists, fire a fresh writer
        // for it. Errors are swallowed — the queued writer's failure should
        // not interrupt the original writer's settlement watcher.
        if (pending) {
          log.info("draining pending writer", { sessionID: input.sessionID })
          yield* tryStartCheckpointWriter(pending).pipe(Effect.ignore)
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => CheckpointContext.remove(input.sessionID, actorID)),
        ),
        Effect.forkIn(scope),
      )

      return "started" as const
    })

    const waitForWriter = Effect.fn("SessionCheckpoint.waitForWriter")(function* (sessionID: SessionID) {
      const state = writers.get(sessionID)
      if (!state) return "no-writer" as const

      // v2 writers manage 3 file types and frequently take 60-180s; pad to
      // 5min so a long-but-honest writer is not mistaken for a failure by
      // the prune retry watcher. AgentOutcome → WriterOutcome translation:
      // success → "success", failure / cancelled → "failure".
      const outcome = yield* Deferred.await(state.writing).pipe(
        Effect.timeout(300_000),
        Effect.catch(() => Effect.succeed<AgentOutcome>({ status: "failure", error: "timeout" })),
      )
      return outcome.status === "success" ? ("success" as const) : ("failure" as const)
    })

    const drainWriters = Effect.fn("SessionCheckpoint.drainWriters")(function* (input?: { timeoutMs?: number }) {
      const timeoutMs = input?.timeoutMs ?? 120_000
      const pending = [...writers.values()]
      if (pending.length === 0) return { drained: 0, timedOut: 0 }
      log.info("draining checkpoint writers before shutdown", {
        count: pending.length,
        timeoutMs,
      })

      // Deferred.await ignores fiber interruption during shutdown because
      // it resolves via Deferred.succeed in the detached writer. We only
      // need a collective upper bound so a stuck writer doesn't block exit.
      yield* Effect.all(
        pending.map((state) => Deferred.await(state.writing)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.timeout(timeoutMs),
        Effect.catch(() => Effect.succeed(undefined)),
      )

      // Writers delete themselves from the map on success/failure, so anything
      // still present after the timeout is a writer that didn't settle in time.
      const timedOut = writers.size
      const drained = pending.length - timedOut
      if (timedOut > 0) log.warn("drain timed out, writers still pending", { drained, timedOut })
      else log.info("drain complete", { drained })
      return { drained, timedOut }
    })

    const hasCheckpoint = Effect.fn("SessionCheckpoint.hasCheckpoint")(function* (sessionID: SessionID) {
      return yield* Effect.promise(() => Bun.file(checkpointPath(sessionID)).exists())
    })

    const hasMemoryOrTasks = Effect.fn("SessionCheckpoint.hasMemoryOrTasks")(function* (sessionID: SessionID) {
      const memoryRoot = yield* memory.root()
      const sessMemDir = path.join(memoryRoot, "sessions", sessionID)
      const memEntries = yield* Effect.promise(() =>
        fs.readdir(sessMemDir).catch(() => [] as string[]),
      )
      if (memEntries.length > 0) return true
      const tasks = yield* taskRegistry.list({ session_id: sessionID, include_terminal: true })
      return tasks.length > 0
    })

    const loadLatest = Effect.fn("SessionCheckpoint.loadLatest")(function* (sessionID: SessionID) {
      const content = yield* Effect.promise(() =>
        Bun.file(checkpointPath(sessionID)).text().catch(() => ""),
      )
      return content || undefined
    })

    const loadCheckpoints = Effect.fn("SessionCheckpoint.loadCheckpoints")(function* (
      sessionID: SessionID,
      _count: number,
    ) {
      const content = yield* Effect.promise(() =>
        Bun.file(checkpointPath(sessionID)).text().catch(() => ""),
      )
      return content ? [content] : []
    })

    const renderIndex = Effect.fn("SessionCheckpoint.renderIndex")(function* (sessionID: SessionID) {
      const snapFile = checkpointPath(sessionID)
      const exists = yield* Effect.promise(() => Bun.file(snapFile).exists())
      if (!exists) return "No checkpoints yet for this session."

      const content = yield* Effect.promise(() => Bun.file(snapFile).text().catch(() => ""))
      const topicMatch = content.match(/^Topic:\s*(.+)$/m)
      const topic = topicMatch ? topicMatch[1].trim() : "(unknown)"

      const dir = metaDir(sessionID)
      const lines: string[] = []
      lines.push("## Checkpoint")
      lines.push("")
      lines.push(`Directory: ${dir}/`)
      lines.push("")
      lines.push(`Current checkpoint (${topic}): checkpoint.md [shown below]`)
      lines.push("")
      lines.push(`Use read("${snapFile}") to access the full checkpoint.`)

      return lines.join("\n")
    })

    const renderRebuildContext = Effect.fn("SessionCheckpoint.renderRebuildContext")(function* (
      sessionID: SessionID,
      opts?: { lastMessageInfo?: LastMessageInfo; agentID?: string },
    ) {
      // renderRebuildContext is for the user-facing main agent's context rebuild.
      // Subagent-mode actors (system-spawned writers, model-spawned subagents)
      // share the parent's session but don't have their own checkpoint state to
      // render — return empty so the rebuild path is a no-op for them.
      // Note: agentID === "main" must pass through. After F49+F50 the main
      // agent's lastUser.agentID is "main" (DB row→info reconstruction in
      // message-v2.ts populates info.agentID from agent_id column), and the
      // runLoop calls this with that value. Treating "main" as subagent here
      // would skip rebuild → fall through to F39 compaction → context loss.
      if (opts?.agentID && opts.agentID !== "main") return ""

      const inFlight = writers.get(sessionID)
      if (inFlight) {
        log.info("rebuild waiting for in-flight writer", { sessionID })
        yield* Effect.race(
          Deferred.await(inFlight.writing).pipe(Effect.as("done" as const)),
          Effect.sleep("60 seconds").pipe(
            Effect.tap(() => Effect.sync(() => log.warn("writer wait timeout — using on-disk checkpoint", { sessionID }))),
            Effect.as("timeout" as const),
          ),
        ).pipe(Effect.catch(() => Effect.succeed("error" as const)))
      }

      const cfg = yield* config.get()
      const caps = cfg.checkpoint?.push_caps ?? {}
      const memoryRoot = yield* memory.root()

      const sessMemDir = path.join(memoryRoot, "sessions", sessionID)

      // Resolve current project ID once. Used by Section 7 (project memory
      // read) and Section 8 (FTS scope filter). ALS-bound — must be resolved
      // before any deferred work.
      const currentProjectID = yield* Effect.try({
        try: () => Instance.current?.project?.id as ProjectID | undefined,
        catch: () => undefined as ProjectID | undefined,
      }).pipe(Effect.catch(() => Effect.succeed<ProjectID | undefined>(undefined)))
      const projectID = currentProjectID ?? ProjectID.global

      // Section data: tasks (SQL), session checkpoint (file), project memory (file).
      const tasks = yield* taskRegistry.list({ session_id: sessionID, include_terminal: true })

      const checkpointResult = yield* Effect.promise(() =>
        readBudgetedSectionAware(checkpointPath(sessionID), caps.checkpoint ?? 11_000),
      )
      const checkpointText = checkpointResult?.text ?? ""

      yield* Effect.promise(() => migrateProjectMemory(projectID))
      const memoryResult = yield* Effect.promise(() =>
        readBudgetedSectionAware(memoryPath(projectID), caps.memory ?? 10_000),
      )
      const memoryText = memoryResult?.text ?? ""

      const notesResult = yield* Effect.promise(() =>
        readBudgeted(notesPath(sessionID), caps.notes ?? 6000),
      )
      const notesText = notesResult?.text ?? ""

      const globalResult = yield* Effect.promise(() =>
        readBudgetedSectionAware(globalMemoryPath(), caps.global ?? 6000),
      )
      const globalText = globalResult?.text ?? ""

      const actors = yield* actorRegistry.listActive()

      // Bail early if absolutely nothing to push: no tasks, no memory content, no live actors.
      if (
        tasks.length === 0 &&
        !checkpointText.trim() &&
        !memoryText.trim() &&
        !globalText.trim() &&
        actors.length === 0
      ) {
        return ""
      }

      const lines: string[] = []

      // F17: Explicit "already loaded" header. Anchors the active recall
      // protocol's "look for this header" instruction in buildMemoryInstructions.
      lines.push(
        "The following blocks are auto-loaded from your session memory. They are already in your context — do not Read them as whole files. Use Grep for specific facts instead.",
      )
      lines.push("")

      // Section 3: tasks ledger (hierarchical with subtasks).
      lines.push("## Tasks ledger")
      if (tasks.length === 0) {
        lines.push("(none)")
      } else {
        const topLevel = tasks.filter((t) => !t.parent_task_id)
        const byParent = new Map<string, typeof tasks>()
        for (const t of tasks) {
          if (!t.parent_task_id) continue
          const bucket = byParent.get(t.parent_task_id) ?? []
          bucket.push(t)
          byParent.set(t.parent_task_id, bucket)
        }
        const statusIcon = (s: string) =>
          ({ open: "🔵", in_progress: "🔄", blocked: "🟡", done: "✅", abandoned: "❌" })[s] ?? s
        const ledgerLines: string[] = []
        for (const t of topLevel) {
          ledgerLines.push(`- ${t.id} ${t.status} — ${t.summary}`)
          const subs = byParent.get(t.id) ?? []
          if (subs.length === 0) continue
          const sublist = subs
            .map((s) => `${statusIcon(s.status)}${s.id}`)
            .join(" / ")
          ledgerLines.push(`  Subtasks: ${sublist}`)
        }
        lines.push(truncate(ledgerLines.join("\n"), caps.tasks_ledger ?? 2000))
      }
      lines.push("")

      // Section 5: session checkpoint (full body, capped).
      if (checkpointText.trim()) {
        lines.push("## Session checkpoint")
        lines.push(checkpointText.trim())
        lines.push("")
      }

      // Section 6: active actors ledger (one line per running actor).
      if (actors.length > 0) {
        lines.push("## Active actors")
        let actorBudget = caps.actor_ledger ?? 500
        for (const a of actors) {
          const line = `- ${a.actorID} — ${a.status}, "${a.description}" (agent=${a.agent})`
          const cost = Token.estimate(line)
          if (actorBudget - cost < 0) break
          lines.push(line)
          actorBudget -= cost
        }
        lines.push("")
      }

      // Section 7: project memory (full body, capped).
      if (memoryText.trim()) {
        lines.push("## Project memory")
        lines.push(memoryText.trim())
        lines.push("")
      }

      // Section 7.4: global memory (full body, capped). User-level cross-project
      // preferences. Placed after project memory (more actionable) and before
      // session notes (more volatile).
      if (globalText.trim()) {
        lines.push("## Global memory")
        lines.push(globalText.trim())
        lines.push("")
      }

      // F14 Section 7.5: session notes (full body, capped). Skip if empty.
      if (notesText.trim()) {
        lines.push("## Session notes")
        lines.push(notesText.trim())
        lines.push("")
      }

      // Section 8: memory keys index (paths only, omit already-pushed).
      // SQL-scoped to the current session/project + global so other
      // sessions' files are not leaked. Falls back to skipping the projects
      // scope when the current project is the global/non-git fallback.
      // Reconcile first so files written off-tool (e.g. by the checkpoint
      // writer subagent) are visible in the FTS index here.
      yield* memory.reconcile().pipe(Effect.ignore)
      const pushedPaths = new Set(
        [
          memoryPath(projectID),
          checkpointPath(sessionID),
          globalMemoryPath(),
        ].filter((p) => p.length > 0),
      )

      const scopeFilter =
        currentProjectID && currentProjectID !== ProjectID.global
          ? or(
              eq(MemoryFtsTable.scope, "global"),
              and(eq(MemoryFtsTable.scope, "sessions"), eq(MemoryFtsTable.scope_id, sessionID as string)),
              and(eq(MemoryFtsTable.scope, "projects"), eq(MemoryFtsTable.scope_id, currentProjectID)),
            )
          : or(
              eq(MemoryFtsTable.scope, "global"),
              and(eq(MemoryFtsTable.scope, "sessions"), eq(MemoryFtsTable.scope_id, sessionID as string)),
            )
      const scopedPaths = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select({ path: MemoryFtsTable.path }).from(MemoryFtsTable).where(scopeFilter).all(),
        ),
      )
      const keyEntries = scopedPaths
        .map((r) => r.path)
        .filter((p) => !pushedPaths.has(p) && !p.includes(`${path.sep}checkpoint${path.sep}learning-`))
        .map((p) => p.replace(memoryRoot + path.sep, ""))
      if (keyEntries.length > 0) {
        lines.push("## Memory keys index")
        let kBudget = caps.memory_titles ?? 500
        for (const entry of keyEntries) {
          const cost = Token.estimate(entry)
          if (kBudget - cost < 0) break
          lines.push(`- ${entry}`)
          kBudget -= cost
        }
        lines.push("")
      }

      // Section 10: explicit seam framing for LLM continuity post-rebuild.
      // Compaction-summary pattern: tells the model
      // that preserved messages below are real history, not pseudo-content,
      // so it resumes mid-loop instead of asking "what would you like me
      // to do".
      lines.push("")
      lines.push(
        "This session is being continued from a previous conversation that hit a checkpoint. The session checkpoint and project memory above cover the earlier portion of the conversation.",
      )
      lines.push("")
      lines.push(
        "Recent messages are preserved verbatim below — the assistant turn (and any tool results) you'll see is real history, not pseudo-content. Continue your task by responding to the most recent state.",
      )
      lines.push("")
      lines.push(
        "Resume directly. Do not acknowledge this memory dump, do not recap, do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened.",
      )

      // Section 11: tail-aware system reminder. Picks the appropriate nudge
      // based on how the preserved tail ends: tool-calls → continue loop,
      // stop → check task spec before stopping again, tool → process results,
      // user → no addendum needed.
      const info = opts?.lastMessageInfo
      if (info) {
        const reminder = (() => {
          switch (info.role) {
            case "assistant":
              if (info.finish === "tool-calls") return autonomousLoopReminder()
              return stopReminder(undefined)
            case "tool":
              return toolResultContinueReminder()
            case "user":
              return ""
          }
        })()
        if (reminder) {
          lines.push("")
          lines.push(reminder)
        }
      }

      return lines.join("\n")
    })

    const lastBoundary = Effect.fn("SessionCheckpoint.lastBoundary")(function* (sessionID: SessionID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select({ last_checkpoint_message_id: SessionTable.last_checkpoint_message_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get(),
        ),
      )
      return row?.last_checkpoint_message_id as MessageID | undefined
    })

    const isWriterRunning = Effect.fn("SessionCheckpoint.isWriterRunning")(function* (sessionID: SessionID) {
      return writers.has(sessionID)
    })

    const insertRebuildBoundary = Effect.fn("SessionCheckpoint.insertRebuildBoundary")(function* (input: {
      sessionID: SessionID
      boundary: MessageID
      lastMessageInfo?: LastMessageInfo
      agentID?: string
      agent: string
      model: { providerID: string; modelID: string }
      boundaryCreatedAt?: number
    }) {
      const rebuildContext = yield* renderRebuildContext(input.sessionID, {
        lastMessageInfo: input.lastMessageInfo,
        agentID: input.agentID,
      }).pipe(Effect.catch(() => Effect.succeed("")))
      if (!rebuildContext) return false

      const indexText = yield* renderIndex(input.sessionID).pipe(Effect.catch(() => Effect.succeed("")))

      const syntheticTime = (input.boundaryCreatedAt ?? Date.now()) + 1
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user" as const,
        model: { providerID: input.model.providerID as ProviderID, modelID: input.model.modelID as ModelID },
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: syntheticTime },
      })

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "checkpoint",
        checkpointDir: "",
        checkpointNumber: 0,
        coveredUpTo: input.boundary,
      })

      if (indexText) {
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: indexText,
        })
      }

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: rebuildContext,
      })

      const actorsText = yield* actorRegistry
        .renderForAgent(input.sessionID)
        .pipe(Effect.catch(() => Effect.succeed("")))
      if (actorsText) {
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: actorsText,
        })
      }

      // Microcompact: messages strictly newer than the boundary will survive
      // into the rebuild context. Clear tool_result content for compactable
      // tools so the first uncached request after rebuild is smaller. tool_use
      // is preserved — LLM still sees what action was taken; result body
      // becomes "[Old tool result content cleared]" via the converter at
      // message-v2.ts (ToolStateCompleted → output).
      // See docs/superpowers/specs/2026-06-03-rebuild-tail-microcompact-design.md.
      //
      // boundaryTime resolution (fail-closed):
      // 1. Prefer explicit input.boundaryCreatedAt (production callers
      //    compute it but may pass undefined if the boundary message is no
      //    longer in their filterCompactedEffect slice).
      // 2. Else look up input.boundary in allMsgs (full DB, includes
      //    pre-marker history).
      // 3. Else SKIP — the previous fallback of 0 would clear EVERY
      //    completed compactable tool result in the entire session,
      //    corrupting future checkpoint writer input. Log a warning.
      const allMsgs = yield* session.messages({ sessionID: input.sessionID, agentID: "*" })
      const boundaryTime =
        input.boundaryCreatedAt ??
        allMsgs.find((m) => m.info.id === input.boundary)?.info.time.created
      if (boundaryTime === undefined) {
        log.warn("microcompact skipped: no boundary timestamp available", {
          sessionID: input.sessionID,
          boundary: input.boundary,
        })
        return true
      }
      let cleared = 0
      for (const m of allMsgs) {
        if (m.info.id === msg.id) continue
        if (m.info.time.created <= boundaryTime) continue
        for (const part of m.parts) {
          if (part.type !== "tool") continue
          if (!COMPACTABLE_TOOL_NAMES.has(part.tool)) continue
          if (part.state.status !== "completed") continue
          if (part.state.time.compacted) continue
          part.state.time.compacted = Date.now()
          yield* session.updatePart(part)
          cleared += 1
        }
      }
      if (cleared > 0) {
        log.info("rebuild microcompact", { sessionID: input.sessionID, cleared })
      }

      return true
    })

    return Service.of({
      tryStartCheckpointWriter,
      waitForWriter,
      drainWriters,
      hasCheckpoint,
      hasMemoryOrTasks,
      loadLatest,
      loadCheckpoints,
      renderIndex,
      renderRebuildContext,
      lastBoundary,
      isWriterRunning,
      insertRebuildBoundary,
    })
  }),
)

// ---------------------------------------------------------------------------
// Default layer
// ---------------------------------------------------------------------------

// `defaultLayer` no longer requires `Actor.Service`: SessionCheckpoint reaches
// the Actor implementation through the late-bound `spawnRef` (see
// `actor/spawn-ref.ts`). This deliberately breaks the otherwise-unresolvable
// layer cycle Actor → SessionPrompt → SessionCheckpoint → Actor. The AppLayer
// constructs `Actor.defaultLayer` separately; its initialiser populates
// `spawnRef`, which `tryStartCheckpointWriter` reads at call time.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Memory.defaultLayer),
    Layer.provide(TaskRegistry.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
  ),
)

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function hasCheckpoint(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.hasCheckpoint(input.sessionID))
}

export async function loadLatest(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.loadLatest(input.sessionID))
}

export async function loadCheckpoints(input: { sessionID: SessionID; count: number }) {
  return runPromise((svc) => svc.loadCheckpoints(input.sessionID, input.count))
}

export async function renderIndex(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.renderIndex(input.sessionID))
}

export async function renderRebuildContext(input: {
  sessionID: SessionID
  lastMessageInfo?: LastMessageInfo
  agentID?: string
}) {
  return runPromise((svc) =>
    svc.renderRebuildContext(input.sessionID, { lastMessageInfo: input.lastMessageInfo, agentID: input.agentID }),
  )
}

export async function lastBoundary(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.lastBoundary(input.sessionID))
}

export async function isWriterRunning(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.isWriterRunning(input.sessionID))
}

export * as SessionCheckpoint from "./checkpoint"

// Test-only re-export so test code can call composeWriterPrompt without
// triggering the full SessionCheckpoint Service stack.
export { composeWriterPrompt as composeWriterPromptForTest }
