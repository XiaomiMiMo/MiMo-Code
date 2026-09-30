import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { CronTool } from "../../src/tool/cron"
import { defaultLayer as SchedulerDefaultLayer } from "../../src/cron/scheduler"
import { provideInstance } from "../fixture/fixture"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, SchedulerDefaultLayer),
)

describe("cron.execute: schedule sanity warnings", () => {
  const runSchedule = async (input: {
    cron: string
    prompt: string
    one_shot?: boolean
    durable?: boolean
  }) => {
    const info = await runtime.runPromise(CronTool)
    const def = await runtime.runPromise(info.init())
    const instanceDir = mkdtempSync(join(tmpdir(), "cron-warn-"))
    try {
      const eff = def.execute(
        { operation: { action: "schedule", ...input } },
        {
          sessionID: "ses_warn_test" as any,
          messageID: "msg_warn_test" as any,
          agent: "build",
          abort: new AbortController().signal,
          extra: {},
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      return await runtime.runPromise(provideInstance(instanceDir)(eff as Effect.Effect<any>))
    } finally {
      rmSync(instanceDir, { recursive: true, force: true })
    }
  }

  test("Feb 30 (never matches) emits a warning even for recurring", async () => {
    const out = await runSchedule({ cron: "0 0 30 2 *", prompt: "impossible" })
    expect(out.output).toMatch(/never matches within a year/)
    expect(out.output).toContain("Feb 30")
  })

  test("one-shot with a next fire > 30 days away emits the rolled-forward warning", async () => {
    // A one-shot 300 days out will trip the > 30d guard regardless of the
    // current wall-clock date. Use a leap-day-of-week combo that pins it.
    // Simpler: a specific date roughly a year out (`0 0 1 1 *` one-shot).
    // On any day of any year, the next Jan 1 midnight is ≤ 1 year away; on
    // Jan 2..Dec 31 it's > 30 days.
    // Skip only if today is Dec 3..Dec 31 (next Jan 1 is < 30 days).
    const today = new Date()
    const nextJan1 = new Date(Date.UTC(today.getUTCFullYear() + (today.getUTCMonth() === 0 && today.getUTCDate() === 1 ? 0 : 1), 0, 1))
    const daysUntil = (nextJan1.getTime() - today.getTime()) / 86_400_000
    if (daysUntil <= 30) return // skip on late December

    const out = await runSchedule({ cron: "0 0 1 1 *", prompt: "ny resolution", one_shot: true })
    expect(out.output).toMatch(/rolled this one-shot to the next matching window/)
  })

  test("recurring yearly (0 0 1 1 *) does NOT trip the warning", async () => {
    // Same expression as above but WITHOUT --one-shot. The user genuinely
    // wants "every Jan 1 at midnight" and next-fire being far away is
    // exactly the point.
    const out = await runSchedule({ cron: "0 0 1 1 *", prompt: "yearly review" })
    expect(out.output).not.toMatch(/rolled this one-shot/)
    expect(out.output).not.toMatch(/never matches/)
  })

  test("recurring 5-minute cron does not warn", async () => {
    const out = await runSchedule({ cron: "*/5 * * * *", prompt: "poll" })
    expect(out.output).not.toMatch(/rolled|never matches/)
  })
})
