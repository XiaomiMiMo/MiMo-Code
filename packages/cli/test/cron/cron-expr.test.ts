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

test.each([
  "5abc",
  "5.5",
  "5e1",
  "0x10",
  "+5",
  "*/2abc",
  "*/1.5",
  "*/2/3",
  "*/",
  "1-5/",
  "1-5-9",
  "1-5abc",
  "1//2",
  "1,5abc",
  "1,,5",
  "1,",
])("rejects the entire malformed field %s", (field) => {
  const expression = `${field} * * * *`
  expect(parseCronExpression(expression)).toBeNull()
  expect(computeNextCronRun(expression, new Date("2026-06-29T12:00:00Z"))).toBeNull()
})

test.each(["0 5abc * * *", "0 0 5abc * *", "0 0 * 5abc *", "0 0 * * 5abc"])(
  "validates every cron field in %s",
  (expression) => {
    expect(parseCronExpression(expression)).toBeNull()
  },
)

test.each([
  ["0,15,30,45", [0, 15, 30, 45]],
  ["10-14", [10, 11, 12, 13, 14]],
  ["10-20/4", [10, 14, 18]],
  ["50/3", [50, 53, 56, 59]],
  ["8,1,4-8/2", [1, 4, 6, 8]],
  ["00,05", [0, 5]],
  ["*/30", [0, 30]],
] as const)("preserves valid numeric field %s", (field, expected) => {
  expect(parseCronExpression(`${field} * * * *`)?.minute).toEqual([...expected])
})

test.each(["60", "-1", "5-1", "1-60", "*/0", "1-5/0"])("rejects invalid bounds or step %s", (field) => {
  expect(parseCronExpression(`${field} * * * *`)).toBeNull()
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
