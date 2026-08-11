// Real-model verification that the actor tool's spawn-first affordance actually
// changes what the model EMITS. The sibling wording tests (actor-prompt-spawn-first)
// only assert the text of actor.txt; a text assertion can never show that an agent
// prefers `spawn`. This drives the real headless CLI against the live mimo router
// and reads the emitted operation out of the structured tool part.
//
// Measured 2026-07-28, mimo/mimo-v2.5, 6 trials per prompt per arm, actor denied by
// permission so the call is recorded but no subagent is actually launched. The arms
// differ only in the four files #1942 touches; "neither" means the agent did the work
// inline instead of delegating at all:
//                     spawn-first (this branch)      run-first (pre-#1942 main)
//   clear delegation  6/6 spawn,  0 run              0/6 spawn, 3/6 run, 3/6 neither
//   parallel fan-out  6/6 emitted 3 parallel spawns  6/6 emitted 3 sequential runs
//   blocking lookup   2/6 run (correct), 4 neither   1/6 run, 5 neither
// So the affordance moved the choice, and it did NOT over-correct into "never run".
// Hence the assertions below: zero `run` on a clear-delegation prompt, and spawn on
// at least half the trials. The looser second bound is deliberate — a later spot check
// saw one clear-delegation trial answered inline with no actor call at all, so
// "delegates every single time" is not a safe assertion; "never reaches for the
// blocking path" is.
//
// Gated behind RUN_ACTOR_SPAWN_AB=1 so it never runs in the normal suite (it needs
// the live router + a real key in ~/.config/mimocode/mimocode.json). Run with:
//   RUN_ACTOR_SPAWN_AB=1 bun test test/tool/actor-spawn-preference.test.ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import os from "os"
import path from "path"

const ENABLED = process.env["RUN_ACTOR_SPAWN_AB"] === "1"
const TRIALS = Number(process.env["RUN_ACTOR_SPAWN_AB_TRIALS"] ?? "4")
const PKG = path.resolve(import.meta.dirname, "..", "..")

const DELEGATION_PROMPT =
  "Investigate how session compaction is triggered in this repo and report back " +
  "a written summary of the trigger conditions."

// A scratch MIMOCODE_HOME: the real mimo provider (test/preload.ts strips provider
// keys from the environment, so the key has to be read from the user's config the
// way verify-wow.test.ts does it) plus a deny rule that keeps the actor tool
// advertised to the model while refusing to actually launch the subagent.
// `**` matters: a bare `*` deny makes Permission.disabled() strip the tool entirely.
function scratchHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "actor-ab-home-"))
  mkdirSync(path.join(home, "config"), { recursive: true })
  const user = JSON.parse(readFileSync(path.join(os.homedir(), ".config", "mimocode", "mimocode.json"), "utf8"))
  if (!user.provider?.mimo?.options?.apiKey) throw new Error("no mimo provider/key in ~/.config/mimocode/mimocode.json")
  writeFileSync(
    path.join(home, "config", "config.json"),
    JSON.stringify({
      model: "mimo/mimo-v2.5",
      permission: { actor: { "**": "deny" } },
      provider: { mimo: user.provider.mimo },
    }),
  )
  return home
}

// The emitted operation, taken from the tool part's structured input only. mimo
// sometimes serializes `operation` as a JSON string, and that string can carry raw
// newlines inside the nested prompt (so JSON.parse rejects it) — hence the regex
// fallback. Still structure, never prose.
function emittedOperation(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = (input as Record<string, unknown>)["operation"]
  if (typeof raw === "string") return raw.match(/"action"\s*:\s*"(\w+)"/)?.[1] ?? raw.trim()
  const action = (raw as Record<string, unknown> | undefined)?.["action"]
  return typeof action === "string" ? action : undefined
}

async function trial(home: string, prompt: string) {
  const proc = Bun.spawn(
    ["bun", "run", "--conditions=browser", "./src/index.ts", "run", "--model", "mimo/mimo-v2.5", "--format", "json", prompt],
    { cwd: PKG, env: { ...process.env, MIMOCODE_HOME: home }, stdout: "pipe", stderr: "ignore" },
  )
  const ops: string[] = []
  const reader = proc.stdout.getReader()
  let buffered = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += new TextDecoder().decode(value)
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as { type?: string; part?: { tool?: string; state?: { input?: unknown } } }
      if (event.type === "tool_use" && event.part?.tool === "actor") {
        ops.push(emittedOperation(event.part.state?.input) ?? "UNPARSEABLE")
      }
      // stop as soon as the assistant step carrying the actor batch closes, so the
      // trial does not pay for the rest of the turn
      if (event.type === "step_finish" && ops.length > 0) {
        proc.kill()
        return ops
      }
    }
  }
  return ops
}

describe("actor tool: the model's actual spawn-vs-run choice (live router)", () => {
  if (!ENABLED) {
    test("skipped (set RUN_ACTOR_SPAWN_AB=1 to run against the live router)", () => {
      expect(true).toBe(true)
    })
  }

  const maybe = ENABLED ? test : test.skip

  maybe(
    "a clear-delegation prompt is delegated with spawn, never with the blocking run",
    async () => {
      const home = scratchHome()
      const results: string[][] = []
      for (let i = 0; i < TRIALS; i++) results.push(await trial(home, DELEGATION_PROMPT))
      console.log("emitted actor operations per trial:", JSON.stringify(results))
      expect(results.flat()).not.toContain("run")
      expect(results.filter((ops) => ops.length > 0 && ops.every((op) => op === "spawn")).length).toBeGreaterThanOrEqual(
        Math.ceil(TRIALS / 2),
      )
    },
    900_000,
  )
})
