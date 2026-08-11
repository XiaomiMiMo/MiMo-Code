import { describe, expect, test } from "bun:test"
import ACTOR_DESCRIPTION from "../../src/tool/actor.txt"
import ACTOR_SHELL_DESCRIPTION from "../../src/tool/actor.shell.txt"

// Agents kept reaching for the BLOCKING `run` action because the tool prompt
// listed it first and used it in nearly every example, which silently killed
// parallelism. These assertions pin the spawn-first steering so it can't
// regress back into a run-first description.
describe("actor tool prompt steers to spawn first", () => {
  for (const [name, prompt] of [
    ["actor.txt", ACTOR_DESCRIPTION],
    ["actor.shell.txt", ACTOR_SHELL_DESCRIPTION],
  ] as const) {
    describe(name, () => {
      test("names spawn as the default", () => {
        expect(prompt).toMatch(/spawn[^\n]*\bDEFAULT\b|\bDEFAULT\b[^\n]*spawn/i)
      })

      test("ties spawn to background + parallel work", () => {
        expect(prompt).toMatch(/background/i)
        expect(prompt).toMatch(/parallel/i)
      })

      test("marks run as blocking and as the exception", () => {
        expect(prompt).toMatch(/\brun\b[^\n]*\bBLOCK/i)
        expect(prompt).toMatch(/exception/i)
      })

      test("mentions the spawned-result collection pattern", () => {
        expect(prompt).toMatch(/wait/i)
        expect(prompt).toMatch(/status/i)
      })

      test("introduces spawn before run", () => {
        const firstSpawn = prompt.search(/\bspawn\b/i)
        const firstRun = prompt.search(/\brun\b/i)
        expect(firstSpawn).toBeGreaterThanOrEqual(0)
        expect(firstSpawn).toBeLessThan(firstRun)
      })

      test("uses spawn for the majority of examples", () => {
        const spawnUses = prompt.match(/\bspawn\b/gi)?.length ?? 0
        const runUses = prompt.match(/\brun\b/gi)?.length ?? 0
        expect(spawnUses).toBeGreaterThan(runUses)
      })
    })
  }

  test("actor.txt keeps at most one run example, labelled as the exception", () => {
    const examples = ACTOR_DESCRIPTION.slice(ACTOR_DESCRIPTION.indexOf("## Examples"))
    expect(examples.length).toBeGreaterThan(0)
    const runExamples = examples.match(/"action":"run"/g)?.length ?? 0
    expect(runExamples).toBeLessThanOrEqual(1)
    if (runExamples === 1) expect(examples).toMatch(/EXCEPTION/)
    const spawnExamples = examples.match(/"action":"spawn"/g)?.length ?? 0
    expect(spawnExamples).toBeGreaterThanOrEqual(3)
  })

  test("actor.shell.txt demonstrates a parallel spawn fan-out", () => {
    const spawnCommands = ACTOR_SHELL_DESCRIPTION.match(/^\s*actor spawn /gm)?.length ?? 0
    const runCommands = ACTOR_SHELL_DESCRIPTION.match(/^\s*actor run /gm)?.length ?? 0
    expect(spawnCommands).toBeGreaterThan(runCommands)
    expect(spawnCommands).toBeGreaterThanOrEqual(3)
  })
})
