// Real-LLM end-to-end verification of workflow-of-workflows.
//
// Unlike the mock-LLM suite, this drives WorkflowRuntime against the REAL mimo
// router so genuine model agents run inside nested child workflows. It exercises
// the headline features TOGETHER: saved-name resolution, A→B dataflow hand-off,
// the file primitives (writeFile/glob/readFile/exists), and nested concurrency.
//
// Gated behind RUN_WOW_VERIFY=1 so it never runs in the normal suite (it needs
// the live router + a real key in ~/.config/mimocode/mimocode.json). Run with:
//   RUN_WOW_VERIFY=1 bun test test/workflow/verify-wow.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { readFileSync } from "fs"
import os from "os"
import path from "path"
import { mkdirSync, writeFileSync } from "fs"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { makeLayer } from "./lib"

const ENABLED = process.env["RUN_WOW_VERIFY"] === "1"

// The real mimo provider, read verbatim from the user's config (key included).
function realConfig() {
  const home = path.join(os.homedir(), ".config", "mimocode", "mimocode.json")
  const full = JSON.parse(readFileSync(home, "utf8"))
  const mimo = full.provider?.mimo
  if (!mimo?.options?.apiKey) throw new Error("no mimo provider/key in " + home)
  return { provider: { mimo } }
}

const realRef = { providerID: ProviderID.make("mimo"), modelID: ModelID.make("mimo-v2.5-pro") }

const it = testEffect(makeLayer())
const maybe = ENABLED ? it.live : it.live.skip

describe("workflow-of-workflows real-LLM verification", () => {
  if (!ENABLED) {
    test("skipped (set RUN_WOW_VERIFY=1 to run against the live router)", () => {
      expect(true).toBe(true)
    })
  }

  // The orchestrator resolves two SAVED workflows by name, threads phase A's
  // result into phase B (dataflow), and uses the file primitives as the
  // coordination side-channel — exactly the run-fulltree.ts pattern, in-script.
  maybe(
    "orchestrator runs saved child workflows, threads dataflow, uses file primitives",
    () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const runtime = yield* WorkflowRuntime.Service
            const session = yield* Session.Service
            const parent = yield* session.create({
              title: "wow-verify",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            })

            // Two saved workflows on disk, resolved by name from .mimocode/workflows.
            const wfDir = path.join(dir, ".mimocode", "workflows")
            mkdirSync(wfDir, { recursive: true })
            // classify: a real agent returns a structured list of "units" to process.
            writeFileSync(
              path.join(wfDir, "classify.js"),
              [
                `export const meta = { name: "classify", description: "classify units" }`,
                `const r = await agent("Return exactly three short lowercase tags for a code-migration demo. Reply with ONLY a JSON object.", {`,
                `  schema: { type: "object", additionalProperties: false, properties: { units: { type: "array", items: { type: "string" } } }, required: ["units"] },`,
                `})`,
                `const units = (r && r.units) || []`,
                // Persist to a shared coordination file (the LIFETIMES.tsv analogue).
                `await writeFile("units.txt", units.join("\\n"))`,
                `return { count: units.length }`,
              ].join("\n"),
            )
            // port: reads the shared file, fans out one real agent per unit (nested concurrency).
            writeFileSync(
              path.join(wfDir, "port.js"),
              [
                `export const meta = { name: "port", description: "port each unit" }`,
                `const body = (await readFile("units.txt")) || ""`,
                `const units = body.split("\\n").filter(Boolean)`,
                `const done = await parallel(units.map((u) => () => agent("Reply with the single word: done. (unit " + u + ")")))`,
                `return { ported: done.filter((x) => x !== null).length, expected: units.length }`,
              ].join("\n"),
            )

            const orchestrator = [
              `export const meta = { name: "orchestrate", description: "A->B migration" }`,
              `phase("classify")`,
              `const a = await workflow("classify")`,
              `phase("port")`,
              `const b = await workflow("port", { from: a.count })`,
              // glob proves the file primitive sees what classify wrote.
              `const files = await glob("*.txt")`,
              `return { classified: a.count, ported: b.ported, expected: b.expected, files }`,
            ].join("\n")

            const { runID } = yield* runtime.start({
              script: orchestrator,
              sessionID: parent.id,
              parentActorID: "main",
              model: realRef,
              // Bound it so a wedged agent can't hang the verification.
              agentTimeoutMs: 120_000,
              scriptDeadlineMs: 600_000,
            })
            const outcome = yield* runtime.wait({ runID })

            yield* Effect.sync(() => {
              // eslint-disable-next-line no-console
              console.log("WOW-VERIFY outcome:", JSON.stringify(outcome, null, 2))
            })

            expect(outcome.status).toBe("completed")
            const r = (outcome as { result: { classified: number; ported: number; expected: number; files: string[] } })
              .result
            // classify produced units, port fanned out one agent each, file round-tripped.
            expect(r.classified).toBeGreaterThan(0)
            expect(r.expected).toBe(r.classified) // port read the same units classify wrote
            expect(r.ported).toBe(r.expected) // every nested agent resolved
            expect(r.files).toContain("units.txt") // glob saw the coordination file

            // Two child sub-runs were recorded (classify + port), each its own row.
            const all = yield* runtime.list({ sessionID: parent.id })
            yield* Effect.sync(() => {
              // eslint-disable-next-line no-console
              console.log(
                "WOW-VERIFY runs:",
                all.map((x) => `${x.name}:${x.status}(s${x.succeeded}/f${x.failed})`).join("  "),
              )
            })
            expect(all.length).toBeGreaterThanOrEqual(3) // orchestrate + classify + port
          }),
        { git: true, config: realConfig() },
      ),
    900_000,
  )
})
