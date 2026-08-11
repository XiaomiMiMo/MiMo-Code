import z from "zod"
import { SessionID, MessageID } from "@/session/schema"

export const ActorStatus = z.enum(["pending", "running", "idle"])
export type ActorStatus = z.infer<typeof ActorStatus>

export const ActorOutcome = z.enum(["success", "failure", "cancelled"])
export type ActorOutcome = z.infer<typeof ActorOutcome>

export const Lifecycle = z.enum(["ephemeral", "persistent"])
export type Lifecycle = z.infer<typeof Lifecycle>

export const ContextMode = z.enum(["none", "state", "full"])
export type ContextMode = z.infer<typeof ContextMode>

export const SpawnMode = z.enum(["peer", "subagent", "main"])
export type SpawnMode = z.infer<typeof SpawnMode>

export const ToolWhitelist = z.union([z.array(z.string()).readonly(), z.literal("INHERIT")])
export type ToolWhitelist = z.infer<typeof ToolWhitelist>

export const Actor = z
  .object({
    sessionID: SessionID.zod,
    actorID: z.string(),
    mode: SpawnMode,
    parentActorID: z.string().optional(),
    status: ActorStatus,
    lastOutcome: ActorOutcome.optional(),
    lifecycle: Lifecycle,
    agent: z.string(),
    description: z.string(),
    contextMode: ContextMode,
    contextWatermark: MessageID.zod.optional(),
    background: z.boolean(),
    tools: ToolWhitelist.optional(),
    lastTurnTime: z.number(),
    turnCount: z.number(),
    // Last part write for this actor's slice. Optional because the column is
    // nullable — see actor.sql.ts. This is the liveness evidence; lastTurnTime
    // and turnCount are step bookkeeping and are NOT read by deriveLiveness.
    lastActivityTime: z.number().optional(),
    lastError: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
  })
  .meta({ ref: "Actor" })
export type Actor = z.infer<typeof Actor>

// Derived liveness: a pull-side signal computed from an actor row's honest
// registry fields (status, lastOutcome, lastActivityTime). It answers the
// question raw `status` cannot — is a running child PROGRESSING or STALLED?
//
// The evidence is LAST ACTIVITY, not last completed step. `last_activity_time`
// advances on every part write for the actor's slice (session/projectors.ts),
// so a child inside a long tool call, a slow model call or a retry/backoff keeps
// advancing it; only a child where nothing at all is landing goes quiet. The
// previous signal was `last_turn_time`, whose sole writer is the per-step
// heartbeat ActorRegistry.updateTurn — so the finest thing it could see was a
// COMPLETED step, and a child blocked mid-step was indistinguishable from a dead
// one. That coarseness is why the bound below used to be 30 minutes.
//   - progressing: running/pending AND activity within the staleness window.
//   - stalled: running/pending, but nothing has landed for longer than the
//     window. Still routable — it means "quiet", not "dead".
//   - success | failure | cancelled: terminal, taken straight from lastOutcome.
//   - idle: finished with no recorded outcome, an unknown state, OR a row whose
//     claim to be running/pending has outlived DEFAULT_LIVENESS_ABANDON_MS — see
//     that constant for why an unbounded claim is not honest.
// Never fabricates: every value maps 1:1 to fields the engine actually wrote.
export const Liveness = z.enum(["progressing", "stalled", "success", "failure", "cancelled", "idle"])
export type Liveness = z.infer<typeof Liveness>

// Default staleness threshold: a running child with no ACTIVITY for this long is
// reported `stalled` (still routable — a display distinction, not a verdict) and
// is the condition the T40 watchdog notifies the child's parent about.
//
// 6 minutes, not the 90s this was. 90s was picked against the per-step cadence,
// where it meant "no COMPLETED STEP for 90s". Read against activity the same
// number means "no PART WRITE for 90s", a far stronger claim of silence, and the
// measured distribution says that claim is false too often: across 43,120 real
// inter-activity gaps on a 172-child roster the gaps run p50 994ms / p90 6.7s /
// p99 38.0s / p99.9 296.8s, so 90s lands strictly BETWEEN p99 and p99.9 —
// between 0.1% and 1% of gaps produced by perfectly HEALTHY children exceed it.
// That was not hypothetical: two children sitting inside single long steps (`bun
// ci`, a full test suite, `git worktree add`) emitted a dozen-plus "appears
// stalled" notifications at ~90-130s of apparent silence while writing parts
// continuously. A channel that cries wolf teaches its reader to ignore it, which
// costs exactly the true stall the channel exists to surface.
//
// Bounded from below by two measurements, not by taste:
//   - the deepest measured natural silence, p99.9 = 296,811ms. A threshold at or
//     under that fires on healthy children by construction.
//   - plus ACTIVITY_COALESCE_MS (below). Recorded activity lags reality by up to
//     one coalesce interval, so apparent age is the real gap plus up to 5s; the
//     threshold has to clear p99.9 + 5s = 301,811ms or the coalescing lag ALONE
//     can flip a tail-but-healthy row. That is what disqualifies the otherwise
//     tidy 300_000 (== registry.ts STUCK_THRESHOLD_MS): 300,000 < 301,811.
// Bounded from above by DEFAULT_LIVENESS_ABANDON_MS (600s), which must stay the
// larger of the two or `stalled` becomes unreachable.
//
// 360_000 is 1.21x p99.9, clears p99.9 + coalesce by 58.2s (11.6 coalesce
// intervals), is 72x ACTIVITY_COALESCE_MS, and is 0.6x the abandonment bound —
// leaving a 240s `stalled` band, ~5 scans at WATCHDOG_SCAN_INTERVAL_MS (45s).
// The cost is accepted deliberately: a genuine stall now surfaces within ~6
// minutes instead of ~90 seconds. The abandonment bound still catches a row whose
// owner is actually gone, and a signal believed late beats one not believed.
export const DEFAULT_LIVENESS_STALL_MS = 6 * 60_000

// Abandonment bound: how long a row may keep CLAIMING `running`/`pending` before
// we stop believing it. `progressing` and `stalled` both read as "in progress" to
// every consumer (the orchestrator roster, `session list`, the fleet table) — they
// mark a child as routable and imply something is already in flight. That claim
// needs an upper bound, because the only repair for a row whose owner died is
// ActorRegistry's orphan sweep, and that sweep runs ONCE at process init and only
// for rows carrying a DIFFERENT instance_id; until it runs — and for any row it
// cannot reach — the row asserts progress with nothing behind it.
//
// 10 minutes. This replaces a 30-minute bound that existed only because the old
// signal was step-grained: a single legitimate step in this repo can run 20+
// minutes (a live test run ~1225s), so any bound had to clear that. Activity
// granularity removes that constraint, and the number is anchored to measurement
// rather than to the longest possible step:
//   - 2x STUCK_THRESHOLD_MS (registry.ts) — the repo's own existing "stuck" cutoff
//     — rather than a fresh magic number;
//   - ~16x the measured p99 inter-activity gap (38.0s) and ~2x p99.9 (296.8s) over
//     43,120 real gaps across a 172-child roster;
//   - ~345x the worst measured first-activity latency after spawn (1735ms, n=172,
//     p50 194ms), which is what licensed deleting the old turnCount === 0 case:
//     the "slow first turn queued behind the concurrency gate" it protected is
//     empirically under two seconds, not minutes, because the user message that
//     starts the turn is itself persisted as a part.
// Direction of error is unchanged and deliberate: prefer a duplicate child
// (wasteful) over routing into a corpse with re-dispatch suppressed
// (unrecoverable). Past the bound we report `idle` — "finished with no recorded
// outcome (or an unknown state)", the honest reading and the only non-routable
// bucket.
export const DEFAULT_LIVENESS_ABANDON_MS = 10 * 60_000

// Write-coalescing interval for the `last_activity_time` heartbeat, applied as a
// staleness guard in the PartUpdated projector's WHERE (session/projectors.ts):
// the row is touched only when it records no activity yet, or when the activity
// it records is already older than this. At most one UPDATE per actor per
// interval. The column's meaning is unchanged — only its resolution is capped.
//
// Needed because the heartbeat rides the part-write path, which is unthrottled.
// `ctx.metadata` in the bash tool (tool/bash.ts, per decoded stdout chunk)
// reaches Session.updatePart via SessionProcessor.updateToolCall
// (session/processor.ts) with no interval check anywhere on the way, so a chatty
// command drove a measured 539-867 registry UPDATEs/sec — each carrying a
// correlated subquery over `message` — strictly 1:1 with part upserts.
//
// 5 seconds, derived from the two consumers of the column, both of which are
// three orders of magnitude coarser than that write rate:
//   - DEFAULT_LIVENESS_STALL_MS (360s, above): the progressing/stalled display.
//     An actively-writing actor's recorded activity now lags reality by at most
//     this interval, so worst-case apparent age is 5s against a 360s threshold —
//     72x of margin, and the flip is unreachable by coalescing alone.
//   - DEFAULT_LIVENESS_ABANDON_MS (600s, above): the routable/idle bound. 120x
//     of margin.
// Also sits above the measured p50 inter-activity gap (994ms) so it actually
// coalesces the dense traffic it targets, while staying below p90 (6.7s) so an
// ordinarily-paced child still records very nearly every activity it has.
// Updating more often than this buys no consumer anything: nothing reads the
// column at a finer resolution than tens of seconds.
export const ACTIVITY_COALESCE_MS = 5_000

export function deriveLiveness(
  actor: Pick<Actor, "status" | "lastOutcome" | "lastActivityTime" | "time">,
  now: number = Date.now(),
  stallMs: number = DEFAULT_LIVENESS_STALL_MS,
  abandonMs: number = DEFAULT_LIVENESS_ABANDON_MS,
): Liveness {
  if (actor.status === "running" || actor.status === "pending") {
    // One reference for every row, no per-row special case: the last thing that
    // landed, or — when nothing has landed yet — the spawn time. `?? ` (not
    // `=== undefined`) because the column is nullable, so this value arrives as
    // `null` for pre-migration rows and a `!== undefined` guard would silently
    // pass them through. See AGENTS.md "Reading a nullable column".
    const since = actor.lastActivityTime ?? actor.time.created
    if (now - since > abandonMs) return "idle"
    return now - since <= stallMs ? "progressing" : "stalled"
  }
  if (actor.lastOutcome === "success") return "success"
  if (actor.lastOutcome === "failure") return "failure"
  if (actor.lastOutcome === "cancelled") return "cancelled"
  return "idle"
}
