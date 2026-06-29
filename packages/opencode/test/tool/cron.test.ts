import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { CronTool, recoverCronArgs } from "../../src/tool/cron"
import { defaultLayer as SchedulerDefaultLayer } from "../../src/cron/scheduler"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, SchedulerDefaultLayer),
)

async function parse(script: string) {
  const info = await runtime.runPromise(CronTool)
  const def = await runtime.runPromise(info.init())
  if (!def.shell) throw new Error("cron tool has no shell field")
  return runtime.runPromise(def.shell.parse(script))
}

async function parseFail(script: string) {
  const info = await runtime.runPromise(CronTool)
  const def = await runtime.runPromise(info.init())
  const exit = await runtime.runPromise(Effect.exit(def.shell!.parse(script)))
  if (exit._tag !== "Failure") throw new Error("expected failure but got success")
  const cause: any = (exit as any).cause
  const fail = cause.reasons?.find?.((r: any) => r._tag === "Fail") ?? cause
  return fail.error ?? fail
}

describe("cron.shell.parse: schedule", () => {
  test("schedule with cron+prompt", async () => {
    const out = await parse(`cron schedule "*/5 * * * *" "/babysit-prs"`)
    expect(out).toEqual([
      { operation: { action: "schedule", cron: "*/5 * * * *", prompt: "/babysit-prs" } },
    ])
  })

  test("schedule with --one-shot", async () => {
    const out = await parse(`cron schedule "30 14 27 2 *" "remind me" --one-shot`)
    expect(out).toEqual([
      { operation: { action: "schedule", cron: "30 14 27 2 *", prompt: "remind me", one_shot: true } },
    ])
  })

  test("schedule with --durable", async () => {
    const out = await parse(`cron schedule "0 9 * * 1-5" "/standup" --durable`)
    expect(out).toEqual([
      { operation: { action: "schedule", cron: "0 9 * * 1-5", prompt: "/standup", durable: true } },
    ])
  })

  test("schedule with both --one-shot and --durable", async () => {
    const out = await parse(`cron schedule "0 9 1 1 *" "ny resolution" --one-shot --durable`)
    expect(out).toEqual([
      {
        operation: {
          action: "schedule",
          cron: "0 9 1 1 *",
          prompt: "ny resolution",
          one_shot: true,
          durable: true,
        },
      },
    ])
  })

  test("schedule with --session", async () => {
    const out = await parse(`cron schedule "*/5 * * * *" "x" --session ses_abc`)
    expect(out).toEqual([
      { operation: { action: "schedule", cron: "*/5 * * * *", prompt: "x", session_id: "ses_abc" } },
    ])
  })
})

describe("cron.shell.parse: loop", () => {
  test("loop with delay+prompt", async () => {
    const out = await parse(`cron loop 300 "check deploy"`)
    expect(out).toEqual([
      { operation: { action: "loop", delay_seconds: 300, prompt: "check deploy" } },
    ])
  })

  test("loop with --reason", async () => {
    const out = await parse(`cron loop 300 "check deploy" --reason "polling"`)
    expect(out).toEqual([
      { operation: { action: "loop", delay_seconds: 300, prompt: "check deploy", reason: "polling" } },
    ])
  })

  test("loop with --reason and --session", async () => {
    const out = await parse(`cron loop 1500 "heartbeat" --reason "hb" --session ses_xyz`)
    expect(out).toEqual([
      {
        operation: {
          action: "loop",
          delay_seconds: 1500,
          prompt: "heartbeat",
          reason: "hb",
          session_id: "ses_xyz",
        },
      },
    ])
  })

  test("loop non-integer delay fails", async () => {
    const err = await parseFail(`cron loop abc "x"`)
    expect(err.kind).toBe("arity")
  })
})

describe("cron.shell.parse: list", () => {
  test("list with no flags", async () => {
    const out = await parse(`cron list`)
    expect(out).toEqual([{ operation: { action: "list" } }])
  })

  test("list with --kind loop", async () => {
    const out = await parse(`cron list --kind loop`)
    expect(out).toEqual([{ operation: { action: "list", kind: "loop" } }])
  })

  test("list with --kind cron", async () => {
    const out = await parse(`cron list --kind cron`)
    expect(out).toEqual([{ operation: { action: "list", kind: "cron" } }])
  })

  test("list with --durable-only", async () => {
    const out = await parse(`cron list --durable-only`)
    expect(out).toEqual([{ operation: { action: "list", durable_only: true } }])
  })

  test("list with invalid --kind reports flag error", async () => {
    const err = await parseFail(`cron list --kind bogus`)
    expect(err.kind).toBe("flag")
    expect(err.detail).toContain("--kind must be cron|loop")
  })
})

describe("cron.shell.parse: get / delete / cancel / rename", () => {
  test("get by id", async () => {
    const out = await parse(`cron get a1b2c3d4`)
    expect(out).toEqual([{ operation: { action: "get", id: "a1b2c3d4" } }])
  })

  test("delete by id", async () => {
    const out = await parse(`cron delete a1b2c3d4`)
    expect(out).toEqual([{ operation: { action: "delete", id: "a1b2c3d4" } }])
  })

  test("cancel is an alias for delete", async () => {
    const out = await parse(`cron cancel abc123`)
    expect(out).toEqual([{ operation: { action: "delete", id: "abc123" } }])
  })

  test("rename with new prompt", async () => {
    const out = await parse(`cron rename abc123 "new body"`)
    expect(out).toEqual([{ operation: { action: "rename", id: "abc123", prompt: "new body" } }])
  })
})

describe("cron.shell.parse: dispatch errors", () => {
  test("levenshtein suggests 'schedule' for 'scheule'", async () => {
    const err = await parseFail(`cron scheule "*/5 * * * *" "x"`)
    expect(err.kind).toBe("unknown-verb")
    expect(err.detail).toContain("did you mean: schedule")
  })

  test("schedule with one arg errors with arity", async () => {
    const err = await parseFail(`cron schedule "*/5 * * * *"`)
    expect(err.kind).toBe("arity")
  })

  test("schedule with zero positional args errors with arity", async () => {
    const err = await parseFail(`cron schedule`)
    expect(err.kind).toBe("arity")
  })

  test("dangling --reason errors", async () => {
    const err = await parseFail(`cron loop 300 "x" --reason`)
    expect(err.kind).toBe("flag")
    expect(err.detail).toContain("--reason requires a value")
  })

  test("dangling --session errors", async () => {
    const err = await parseFail(`cron get abc --session`)
    expect(err.kind).toBe("flag")
    expect(err.detail).toContain("--session requires a value")
  })

  test("empty --session= errors", async () => {
    const err = await parseFail(`cron get abc --session=`)
    expect(err.kind).toBe("flag")
    expect(err.detail).toContain("--session requires a value")
  })

  test("unknown verb with no close match reports just the unknown", async () => {
    const err = await parseFail(`cron frobnicate xyz`)
    expect(err.kind).toBe("unknown-verb")
    expect(err.detail).toContain('unknown verb "frobnicate"')
  })

  test("non-cron head command errors", async () => {
    const err = await parseFail(`task list`)
    expect(err.kind).toBe("unknown-verb")
    expect(err.detail).toContain("every command must start with 'cron'")
  })
})

describe("cron.shell.parse: multi-command", () => {
  test("two schedules via newlines", async () => {
    const out = await parse(`cron schedule "*/5 * * * *" "A"\ncron schedule "*/10 * * * *" "B"`)
    expect(out).toEqual([
      { operation: { action: "schedule", cron: "*/5 * * * *", prompt: "A" } },
      { operation: { action: "schedule", cron: "*/10 * * * *", prompt: "B" } },
    ])
  })
})

describe("recoverCronArgs", () => {
  test("bare {cron, prompt} → schedule operation", () => {
    expect(recoverCronArgs({ cron: "*/5 * * * *", prompt: "x" })).toEqual({
      operation: { action: "schedule", cron: "*/5 * * * *", prompt: "x" },
    })
  })

  test("bare {cron, prompt, one_shot} carries one_shot", () => {
    expect(recoverCronArgs({ cron: "30 14 * * *", prompt: "x", one_shot: true })).toEqual({
      operation: { action: "schedule", cron: "30 14 * * *", prompt: "x", one_shot: true },
    })
  })

  test("bare {cron, prompt, durable} carries durable", () => {
    expect(recoverCronArgs({ cron: "0 9 * * 1-5", prompt: "x", durable: true })).toEqual({
      operation: { action: "schedule", cron: "0 9 * * 1-5", prompt: "x", durable: true },
    })
  })

  test("stringified operation → parsed nested", () => {
    expect(recoverCronArgs({ operation: '{"action":"list"}' })).toEqual({
      operation: { action: "list" },
    })
  })

  test("already-nested operation → passthrough", () => {
    const op = { operation: { action: "get", id: "a1b2c3d4" } } as const
    expect(recoverCronArgs(op)).toEqual(op)
  })

  test("ambiguous / non-object → undefined", () => {
    expect(recoverCronArgs({ id: "abc" })).toBeUndefined()
    expect(recoverCronArgs({ cron: "x" })).toBeUndefined() // cron without prompt
    expect(recoverCronArgs({ prompt: "x" })).toBeUndefined() // prompt without cron
    expect(recoverCronArgs(null)).toBeUndefined()
    expect(recoverCronArgs(undefined)).toBeUndefined()
  })

  test("array operation is not mistaken for an envelope → undefined", () => {
    expect(recoverCronArgs({ operation: [1, 2] })).toBeUndefined()
    expect(recoverCronArgs({ operation: "[1,2]" })).toBeUndefined()
  })
})
