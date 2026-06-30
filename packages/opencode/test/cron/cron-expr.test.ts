import { test, expect } from "bun:test"
import { parseCronExpression, computeNextCronRun, cronToHuman } from "@/cron/cron-expr"

test("parses '*/5 * * * *'", () => {
  const f = parseCronExpression("*/5 * * * *")
  expect(f?.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
  expect(f?.hour.length).toBe(24)
})

test("rejects malformed", () => {
  expect(parseCronExpression("bad")).toBeNull()
  expect(parseCronExpression("* * * *")).toBeNull() // 4 fields
  expect(parseCronExpression("* * * * * *")).toBeNull() // 6 fields
})

test("nextRun for '*/5 * * * *' at 12:03 returns 12:05", () => {
  const next = computeNextCronRun("*/5 * * * *", new Date("2026-06-29T12:03:00Z"))
  expect(next?.toISOString()).toBe("2026-06-29T12:05:00.000Z")
})

test("nextRun for pinned '30 14 27 2 *' from June returns next Feb 27", () => {
  const next = computeNextCronRun("30 14 27 2 *", new Date("2026-06-29T00:00:00Z"))
  expect(next?.toISOString()).toBe("2027-02-27T14:30:00.000Z")
})

test("cronToHuman labels common patterns", () => {
  expect(cronToHuman("*/5 * * * *")).toBe("every 5 minutes")
  expect(cronToHuman("0 9 * * 1-5")).toBe("weekdays at 9:00")
  expect(cronToHuman("30 14 27 2 *")).toContain("Feb 27")
})

// Regression for PR #1479 finding #3: Vixie cron OR-semantics on dom/dow.
// When BOTH day-of-month AND day-of-week are restricted, real cron fires
// on either match. When one is `*`, only the restricted side narrows fires.
test("dom and dow OR when both restricted (Vixie semantics)", () => {
  // "0 0 13 * 5" = midnight on the 13th OR any Friday.
  // June 5 2026 is a Friday → from June 4 noon the next fire is June 5.
  const fri = computeNextCronRun("0 0 13 * 5", new Date("2026-06-04T12:00:00Z"))
  expect(fri?.toISOString()).toBe("2026-06-05T00:00:00.000Z")
})

test("dom and dow AND when one is star (only restricted side narrows)", () => {
  // "0 0 * * 1-5" = midnight on weekdays. dom is *, so it's pure dow.
  // June 6 2026 is a Saturday → next fire is Monday June 8.
  const mon = computeNextCronRun("0 0 * * 1-5", new Date("2026-06-06T00:00:00Z"))
  expect(mon?.toISOString()).toBe("2026-06-08T00:00:00.000Z")
})
