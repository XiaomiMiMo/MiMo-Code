import { afterEach, test, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import os from "os"
import { mkdtempSync, rmSync } from "fs"
import { provideInstance } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { tmpdir } from "../fixture/fixture"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

// Spawn the agent-list probe in a FRESH process (no test/preload.ts, which
// force-sets MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true for the suite). `Flag` reads
// the env once at import time, so the flag-OFF path is only observable here.
// Returns the list of agent names Agent.list() produced under `flag`.
function listAgentNames(flag: boolean): string[] {
  const root = mkdtempSync(path.join(os.tmpdir(), "orch-gate-"))
  try {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      XDG_DATA_HOME: path.join(root, "share"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      HOME: path.join(root, "home"),
      MIMOCODE_DB: ":memory:",
      MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true",
      MIMOCODE_TEST_TMPDIR_ROOT: path.join(root, "tmp"),
    }
    delete env.MIMOCODE_EXPERIMENTAL
    delete env.MIMOCODE_EXPERIMENTAL_ORCHESTRATOR
    if (flag) env.MIMOCODE_EXPERIMENTAL_ORCHESTRATOR = "true"
    const result = Bun.spawnSync({
      cmd: [process.execPath, path.join(import.meta.dir, "fixtures", "list-agents-probe.ts")],
      cwd: process.cwd(),
      env,
    })
    const out = result.stdout.toString() + result.stderr.toString()
    expect(result.exitCode, `probe failed:\n${out}`).toBe(0)
    const m = out.match(/NAMES=(\[.*\])/)
    expect(m, `probe produced no NAMES line:\n${out}`).not.toBeNull()
    return JSON.parse(m![1]) as string[]
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("agent list gating: Orchestrator absent when the flag is OFF, present when ON", () => {
  // Flag OFF: registration ternary in agent/agent.ts omits orchestrator, so the
  // TUI picker (agents()) and force-switch dialog (list()) — both fed from
  // Agent.list() via sync.data.agent — never surface it, and forceSwitch()
  // validates the name against agents() so it cannot reach it either.
  const off = listAgentNames(false)
  expect(off).not.toContain("orchestrator")
  expect(off).toContain("build")
  expect(off).toContain("plan")
  // Flag ON: orchestrator is registered and therefore selectable.
  const on = listAgentNames(true)
  expect(on).toContain("orchestrator")
}, 60000)

test("orchestrator agent is a native, full-capability primary (no tool restriction)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const orchestrator = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(orchestrator).toBeDefined()
      expect(orchestrator?.name).toBe("orchestrator")
      expect(orchestrator?.mode).toBe("primary")
      expect(orchestrator?.native).toBe(true)
      // Full-capability: NOT restricted by a toolAllowlist (it gets the same
      // tools as build, plus the orchestrator-only `session` tool gated by name).
      expect(orchestrator?.toolAllowlist).toBeUndefined()
      // First-class delegator identity: the orchestrator carries its OWN system
      // prompt (agent.prompt), which REPLACES the base coding prompt — it is not
      // a system-reminder injected into the user message.
      expect(orchestrator?.prompt).toBe(PROMPT_ORCHESTRATOR)
      expect(orchestrator?.prompt).toMatch(/leader|manager|coordinat/i)
    },
  })
})
