import { describe, expect, test } from "bun:test"
import PROMPT_COMPACTION from "../../src/agent/prompt/compaction.txt"
import { buildSummaryMessage } from "../../src/session/compaction"

// 按规则分别检查关键短语的静态文案检查；断言依赖英文措辞，不做语义等价验证。
describe("compaction date policy", () => {
  test("prompt forbids stating the current date", () => {
    expect(PROMPT_COMPACTION).toMatch(/do not state the current date/i)
  })

  test("prompt keeps calendar dates on events already dated in the conversation", () => {
    expect(PROMPT_COMPACTION).toMatch(/calendar dates only on events/i)
    expect(PROMPT_COMPACTION).toMatch(/explicitly dated in the conversation/i)
    expect(PROMPT_COMPACTION).toMatch(/do not invent dates/i)
  })

  test("prompt describes relative times from compaction without calendar conversion", () => {
    expect(PROMPT_COMPACTION).toMatch(/relative times from the time of compaction/i)
    expect(PROMPT_COMPACTION).toMatch(/without converting them to calendar dates/i)
  })

  test("date policy sits after the summary outline, not before it", () => {
    const outlineEnd = PROMPT_COMPACTION.indexOf("Any promises made to the user")
    const policy = PROMPT_COMPACTION.indexOf("Date policy")
    const concise = PROMPT_COMPACTION.indexOf("Be concise but complete")
    expect(outlineEnd).toBeGreaterThan(-1)
    expect(concise).toBeGreaterThan(-1)
    expect(policy).toBeGreaterThan(outlineEnd)
    expect(policy).toBeLessThan(concise)
  })

  test("summary wrapper stamps compacted-at as the only absolute time anchor", () => {
    const compactedAt = new Date("2026-10-12T07:30:00.000Z")
    const message = buildSummaryMessage("## Goal\nShip it", "manual", false, compactedAt)
    expect(message).toContain('compacted-at="2026-10-12T07:30:00.000Z"')
    // 包装器只允许出现 compacted-at 这一个日历日
    const days = message.match(/\d{4}-\d{2}-\d{2}/g) ?? []
    expect(days.length).toBeGreaterThan(0)
    expect(days.every((day) => day === "2026-10-12")).toBe(true)
    expect(message).not.toMatch(/today is/i)
    expect(message).not.toMatch(/current date is/i)
  })

  test("summary wrapper reminds restore path to resolve today from date or the user", () => {
    const message = buildSummaryMessage("## Goal\nShip it", "automatic", true)
    expect(message).toMatch(/dates in the summary are not "today"/i)
    expect(message).toMatch(/`date`/)
    expect(message).toMatch(/or the user/i)
    expect(message).toMatch(/relative to this compaction timestamp/i)
    expect(message).toContain('trigger="automatic"')
    expect(message).toContain("Complete API rounds")
  })
})
