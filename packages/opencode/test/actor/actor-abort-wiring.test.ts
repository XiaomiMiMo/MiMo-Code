import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Wiring guard for the subagent hang fix in `src/tool/actor.ts`.
 *
 * The failure mode here is invisible to a runtime test of Effect's primitives:
 * `Deferred.succeed(d, v)` returns an Effect, and a callback that merely *builds*
 * that Effect (e.g. `void Deferred.succeed(...)`) compiles, typechecks, and does
 * absolutely nothing at runtime. The hang would ship anyway.
 *
 * So this asserts on the source text itself. It is deliberately narrow: it pins the
 * two properties the fix depends on, and nothing about styling.
 */

const SOURCE = readFileSync(join(import.meta.dir, "..", "..", "src", "tool", "actor.ts"), "utf8")

describe("actor tool abort wiring", () => {
  test("the blocking run path settles the outcome Deferred on abort", () => {
    // The caller is blocked on Deferred.await(spawnResult.outcome). Something must
    // settle it when ESC fires, or the tool call never returns.
    expect(SOURCE).toContain('ctx.abort.addEventListener("abort", cancelHandler)')
    expect(SOURCE).toMatch(
      /function cancelHandler\(\)[\s\S]{0,600}Deferred\.succeed\(spawnResult\.outcome/,
    )
  })

  test("the run path still cancels the subagent it abandoned", () => {
    // Settling the caller is not the same as stopping the child. Both must happen.
    const handler = SOURCE.match(/function cancelHandler\(\)[\s\S]{0,800}?\n {8}\}/)?.[0] ?? ""
    expect(handler).toMatch(/actor\.cancel\(spawnResult\.sessionID, spawnResult\.actorID, "graceful"\)/)
  })

  test("no abort handler discards a Deferred effect with `void`", () => {
    // The exact bug: `void Deferred.succeed(...)` constructs an Effect and throws it
    // away. It never runs. Any occurrence inside the file is a latent no-op.
    const offenders = SOURCE.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /void\s+Deferred\.(succeed|done|doneUnsafe|fail)\s*\(/.test(line))
      .map(([n, line]) => `${n}: ${line.trim()}`)
    expect(offenders).toEqual([])
  })

  test("every abort listener is removed on the release path", () => {
    // Otherwise a later abort fires against an already-settled call and touches a
    // dead actor.
    const added = (SOURCE.match(/ctx\.abort\.addEventListener\(/g) ?? []).length
    const removed = (SOURCE.match(/ctx\.abort\.removeEventListener\(/g) ?? []).length
    expect(added).toBeGreaterThan(0)
    expect(removed).toBe(added)
  })

  test("the wait path is raced against the abort, not merely awaited", () => {
    // `wait` resolves off the status bus, so it needed no stuck-fiber fix - but it
    // still blocked the session for its full timeout. It must lose the race to ESC.
    expect(SOURCE).toContain('ctx.abort.addEventListener("abort", waitCancelHandler)')
    expect(SOURCE).toMatch(/Effect\.race\(\s*normalWait,\s*onAbort\s*\)/)
  })
})
