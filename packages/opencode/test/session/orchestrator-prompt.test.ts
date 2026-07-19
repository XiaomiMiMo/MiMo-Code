import { describe, expect, test } from "bun:test"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

describe("orchestrator prompt", () => {
  test("is non-empty and mentions the session tool", () => {
    expect(PROMPT_ORCHESTRATOR.length).toBeGreaterThan(0)
    expect(PROMPT_ORCHESTRATOR).toContain("`session` tool")
  })

  test("establishes a positive leader/delegator identity", () => {
    // The defining trait of this mode: it leads/coordinates and delegates the
    // work rather than doing it itself. Pin the POSITIVE identity so it can't
    // regress into a coder prompt.
    expect(PROMPT_ORCHESTRATOR).toMatch(/leader|manager|coordinat/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/delegat/i)
  })

  test("states identity positively without the 'NOT a coding agent' negation", () => {
    // T2 acceptance: the identity must be POSITIVE. The redundant negation
    // "You are NOT a coding agent" must not reappear.
    expect(PROMPT_ORCHESTRATOR).not.toContain("NOT a coding agent")
  })

  test("frames BOTH plan and review as DELEGATED jobs, not the orchestrator's own", () => {
    // T2 acceptance: planning HOW to implement and reviewing quality are jobs the
    // orchestrator DELEGATES (to plan/compose and reviewer/compose children), not
    // work it does inline. Pin that both are present and routed to children.
    expect(PROMPT_ORCHESTRATOR).toMatch(/plan/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/review/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/reviewer child|compose/i)
    // The delegation framing: these are things you delegate rather than do yourself.
    expect(PROMPT_ORCHESTRATOR).toMatch(/delegat/i)
  })

  test("teaches the per-task dir/isolate model (S13)", () => {
    // Pin the S13 guidance so it can't be silently dropped: the prompt must tell
    // the orchestrator about choosing a child's directory and isolation per task.
    expect(PROMPT_ORCHESTRATOR).toContain("dir")
    expect(PROMPT_ORCHESTRATOR).toContain("isolate")
  })

  test("teaches no-poll + interrupt/resume lifecycle (session-lifecycle spec)", () => {
    // Pin so the lifecycle guidance can't be silently dropped.
    expect(PROMPT_ORCHESTRATOR).toContain("don't poll")
    expect(PROMPT_ORCHESTRATOR).toContain("session cancel")
    expect(PROMPT_ORCHESTRATOR).toContain("resume")
  })

  test("draws the actor-vs-session line and forbids blocking on real work", () => {
    // The orchestrator must never do real work via a BLOCKING actor subagent
    // (`actor run`/`spawn`), and must never block its turn on any tool action.
    // Pin the distinction + the never-block discipline so they can't regress.
    expect(PROMPT_ORCHESTRATOR).toContain("actor")
    expect(PROMPT_ORCHESTRATOR).toMatch(/never block|MUST NEVER block|non-blocking/i)
    // The blocking subagent actions must be named and forbidden for real work.
    expect(PROMPT_ORCHESTRATOR).toMatch(/actor run|actor spawn|`actor run`/i)
    // The legitimate non-blocking relay/nudge action must be endorsed.
    expect(PROMPT_ORCHESTRATOR).toMatch(/actor send|actor status/i)
  })

  test("makes isolation the default for git-repo editing children", () => {
    // isolate:true must be the DEFAULT for children that edit files in a git
    // repo (isolation-first), not a soft per-task judgement call.
    expect(PROMPT_ORCHESTRATOR).toContain("isolate")
    expect(PROMPT_ORCHESTRATOR).toMatch(/isolation-first|DEFAULT|MUST/i)
  })

  test("makes requirement auto-capture a first-class reflex before acting (T45)", () => {
    // The orchestrator must capture every user-stated requirement/bug/criticism/
    // new problem into the task ledger as a reflex BEFORE acting, so 'talking'
    // always becomes 'recording' — not left to self-discipline.
    expect(PROMPT_ORCHESTRATOR).toContain("Capture requirements before acting")
    expect(PROMPT_ORCHESTRATOR).toMatch(/talking.*recording|recording.*talking/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/reflex/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/bug|criticism|requirement/i)
  })

  test("warns about idle-without-notification and detached-commit faults on resume", () => {
    // A child can go idle without sending a completion notification; and a
    // committed change can be detached from its branch ref. Pin the guidance to
    // verify via git and merge by commit hash when the branch ref lags.
    expect(PROMPT_ORCHESTRATOR).toMatch(/idle/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/notification/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/detached|commit hash|branch ref/i)
  })

  test("aligns to shipped primitives: session send/status/join, --topic, event-driven stall (T44)", () => {
    // T44: the prompt documents the primitives that actually landed on this
    // branch — the reliable relay verb, derived liveness, fan-in, per-theme
    // reuse, and event-driven stall notifications.
    expect(PROMPT_ORCHESTRATOR).toContain("session send")
    expect(PROMPT_ORCHESTRATOR).toContain("session status")
    expect(PROMPT_ORCHESTRATOR).toContain("--topic")
    expect(PROMPT_ORCHESTRATOR).toContain("join")
    expect(PROMPT_ORCHESTRATOR).toMatch(/stalled/i)
    // Stall detection is event-driven now: the orchestrator is NOTIFIED when a
    // child stalls, rather than being told to poll for it.
    expect(PROMPT_ORCHESTRATOR).toMatch(/watchdog|actor_notification\{stalled\}|told when a child|wait event-driven/i)
  })

  test("drops the stale relay + KNOWN-LIMITATION guidance that shipped primitives obsoleted (T44)", () => {
    // The idle-relay-is-unreliable caveat (fixed by T25/T42) and the
    // resume-via-actor-send relay must be gone: relaying is now `session send`.
    expect(PROMPT_ORCHESTRATOR).not.toContain("KNOWN LIMITATION")
    expect(PROMPT_ORCHESTRATOR).not.toContain("receiver not found")
    // The old resume text drove relay via the actor send action; resume is now
    // `list` + `session send`.
    expect(PROMPT_ORCHESTRATOR).not.toContain("`actor` send action")
  })

  test("finished sessions stay resumable — cancel is destroy-only, never the way to finish (T60)", () => {
    // Governing principle: the orchestrator↔session interaction must mirror
    // human↔session — a finished child goes idle and resumable, it is NOT
    // cancelled on completion. Pin the principle vocabulary so it can't regress.
    expect(PROMPT_ORCHESTRATOR).toMatch(/resumable/i)
    // The human-mirroring rationale must be stated.
    expect(PROMPT_ORCHESTRATOR).toMatch(/human/i)
    // Cancel is reframed as a rare DESTROY action, not a completion step.
    expect(PROMPT_ORCHESTRATOR).toMatch(/DESTROY|destroy/)
    // Read-only query over a finished child's preserved knowledge.
    expect(PROMPT_ORCHESTRATOR).toContain("session ask")
    // Explicit resume-first / do-not-cancel-on-completion instruction.
    expect(PROMPT_ORCHESTRATOR).toMatch(/do NOT cancel|never cancel|not cancel/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/resume-first|Prefer keeping sessions resumable|Prefer resume/i)
  })

  test("no longer trains 'completed → cancel' as a routine completion step (T60)", () => {
    // The defect: cancel must NOT be presented as the default way to finish a
    // task. These 'completed → cancel' phrasings must be absent.
    expect(PROMPT_ORCHESTRATOR).not.toMatch(/completed\s*→\s*cancel/i)
    expect(PROMPT_ORCHESTRATOR).not.toContain("cancel + task done")
    // "Completed" never means "cancel" — the explicit disavowal must be present.
    expect(PROMPT_ORCHESTRATOR).toMatch(/"Completed" never means "cancel"|Completed.{0,20}never.{0,20}cancel/i)
  })
})
