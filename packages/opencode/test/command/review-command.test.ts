import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Command } from "../../src/command"
import PROMPT_REVIEW from "../../src/command/template/review.txt"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("/review command", () => {
  test("defaults to the general subagent for command subtasks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const commands = yield* Command.Service
            const review = yield* commands.get(Command.Default.REVIEW)
            expect(review?.subtask).toBe(true)
            expect(review?.agent).toBe("general")
          }).pipe(Effect.scoped, Effect.provide(Command.defaultLayer)),
        ),
    })
  })

  test("template uses actor's spawnable subagent vocabulary", () => {
    expect(PROMPT_REVIEW).toMatch(/\bactor\b/)
    expect(PROMPT_REVIEW).toMatch(/subagent_type[` ]+set to [`"]general[`"]/i)
    expect(PROMPT_REVIEW).toMatch(/do not set [`"]?subagent_type[`"]?.*\b(build|plan|compose)\b/is)
  })
})
