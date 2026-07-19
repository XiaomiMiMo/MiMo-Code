import { describe, expect, test } from "bun:test"
import { assembleFleet, renderFleetTable } from "../../src/tool/fleet"
import type { FleetActorInput, WorktreeEntry } from "../../src/tool/fleet"
import type { Actor } from "../../src/actor/schema"
import { DEFAULT_LIVENESS_STALL_MS } from "../../src/actor/schema"

const NOW = 1_000_000_000

// Minimal Actor row factory — only the fields deriveLiveness + assembleFleet
// read matter; the rest are filled with inert defaults.
function actor(patch: Partial<Actor>): Actor {
  return {
    sessionID: "ses_x" as Actor["sessionID"],
    actorID: "ses_x",
    mode: "peer",
    status: "idle",
    lifecycle: "persistent",
    agent: "build",
    description: "",
    contextMode: "none",
    background: true,
    lastTurnTime: NOW,
    turnCount: 0,
    time: { created: NOW, updated: NOW },
    ...patch,
  }
}

function sess(id: string, title: string, directory: string): FleetActorInput["session"] {
  return { id, title, directory }
}

describe("assembleFleet", () => {
  test("correlates liveness, turn telemetry, and worktree mapping into grouped rows", () => {
    const inputs: FleetActorInput[] = [
      // progressing: running, turn advanced just now
      {
        session: sess("ses_a", "port parser", "/wt/a"),
        actor: actor({ agent: "build", status: "running", lastTurnTime: NOW - 1_000, turnCount: 5 }),
      },
      // stalled: running but no turn advance for longer than the window
      {
        session: sess("ses_b", "billing schema", "/wt/b"),
        actor: actor({ agent: "compose", status: "running", lastTurnTime: NOW - DEFAULT_LIVENESS_STALL_MS - 5_000, turnCount: 2 }),
      },
      // terminal success → idle bucket
      {
        session: sess("ses_c", "done thing", "/shared"),
        actor: actor({ agent: "build", status: "idle", lastOutcome: "success", lastTurnTime: NOW - 120_000, turnCount: 9 }),
      },
      // failed
      {
        session: sess("ses_d", "broke", "/shared"),
        actor: actor({ agent: "build", status: "idle", lastOutcome: "failure", turnCount: 1 }),
      },
      // no actor row → plain idle, no telemetry
      { session: sess("ses_e", "never started", "/shared"), actor: null },
    ]
    const worktrees: WorktreeEntry[] = [
      { directory: "/wt/a", branch: "mimocode/port-parser", ahead: 3 },
      { directory: "/wt/b", branch: "mimocode/billing", ahead: 0 },
    ]

    const summary = assembleFleet(inputs, worktrees, NOW)

    expect(summary.total).toBe(5)
    expect(summary.counts).toEqual({ progressing: 1, stalled: 1, idle: 2, failed: 1, cancelled: 0 })

    // Rows are grouped in fixed order: progressing → stalled → idle → failed → cancelled.
    // ses_c and ses_e are both idle (ordered before failed ses_d).
    expect(summary.rows.map((r) => r.sessionID)).toEqual(["ses_a", "ses_b", "ses_c", "ses_e", "ses_d"])

    const byId = (id: string) => summary.rows.find((r) => r.sessionID === id)!

    const a = byId("ses_a")
    expect(a.bucket).toBe("progressing")
    expect(a.liveness).toBe("progressing")
    expect(a.mode).toBe("build")
    expect(a.turnCount).toBe(5)
    expect(a.lastActivityMs).toBe(1_000)
    expect(a.worktreeDir).toBe("/wt/a")
    expect(a.branch).toBe("mimocode/port-parser")
    expect(a.ahead).toBe(3)

    const b = byId("ses_b")
    expect(b.bucket).toBe("stalled")
    expect(b.ahead).toBe(0)

    // Shared-dir children carry no worktree fields.
    const c = byId("ses_c")
    expect(c.bucket).toBe("idle")
    expect(c.worktreeDir).toBeUndefined()
    expect(c.branch).toBeUndefined()

    expect(byId("ses_d").bucket).toBe("failed")

    // No actor row → idle, undefined lastActivity, mode "?".
    const e = byId("ses_e")
    expect(e.bucket).toBe("idle")
    expect(e.mode).toBe("?")
    expect(e.lastActivityMs).toBeUndefined()
  })

  test("empty fleet produces zeroed summary", () => {
    const summary = assembleFleet([], [], NOW)
    expect(summary.total).toBe(0)
    expect(summary.counts).toEqual({ progressing: 0, stalled: 0, idle: 0, failed: 0, cancelled: 0 })
    expect(summary.rows).toEqual([])
  })
})

describe("renderFleetTable", () => {
  test("empty fleet renders the no-children sentinel", () => {
    expect(renderFleetTable(assembleFleet([], [], NOW))).toBe("No child sessions.")
  })

  test("renders grouped headings, worktree cell, and summary line", () => {
    const inputs: FleetActorInput[] = [
      {
        session: sess("ses_a", "port parser", "/wt/a"),
        actor: actor({ agent: "build", status: "running", lastTurnTime: NOW - 2_000, turnCount: 5 }),
      },
      { session: sess("ses_z", "idle one", "/shared"), actor: null },
    ]
    const worktrees: WorktreeEntry[] = [{ directory: "/wt/a", branch: "mimocode/port-parser", ahead: 3 }]

    const out = renderFleetTable(assembleFleet(inputs, worktrees, NOW))

    expect(out).toContain("Fleet: 2 total — 1 running (1 progressing, 0 stalled), 1 idle")
    expect(out).toContain("In progress — progressing (advancing) (1):")
    expect(out).toContain("Finished / idle (1):")
    // Isolated child shows branch (+ahead) @ dir; shared child shows "shared".
    expect(out).toContain("mimocode/port-parser (+3) @ /wt/a")
    expect(out).toContain("shared")
    expect(out).toContain("ses_a")
    expect(out).toContain("2s")
  })

  test("detached / unknown-ahead worktree renders gracefully", () => {
    const inputs: FleetActorInput[] = [
      {
        session: sess("ses_a", "x", "/wt/a"),
        actor: actor({ status: "running", lastTurnTime: NOW }),
      },
    ]
    const worktrees: WorktreeEntry[] = [{ directory: "/wt/a" }]
    const out = renderFleetTable(assembleFleet(inputs, worktrees, NOW))
    expect(out).toContain("detached @ /wt/a")
  })
})
