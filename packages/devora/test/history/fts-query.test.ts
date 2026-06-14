import { describe, expect, test } from "bun:test"
import { buildFtsQuery } from "../../src/history/fts-query"

describe("history.buildFtsQuery", () => {
  test("returns null for empty / whitespace input", () => {
    expect(buildFtsQuery("")).toBeNull()
    expect(buildFtsQuery("   ")).toBeNull()
    expect(buildFtsQuery("!!!")).toBeNull()
  })

  test("wraps single token in phrase quotes", () => {
    expect(buildFtsQuery("hello")).toBe('"hello"')
  })

  test("AND-joins multiple tokens", () => {
    expect(buildFtsQuery("git log")).toBe('"git" AND "log"')
  })

  test("splits on punctuation", () => {
    expect(buildFtsQuery("foo.bar/baz")).toBe('"foo" AND "bar" AND "baz"')
  })

  test("keeps CJK tokens", () => {
    expect(buildFtsQuery("搜索 测试")).toBe('"搜索" AND "测试"')
  })

  test("strips embedded quotes within tokens", () => {
    expect(buildFtsQuery('he"llo')).toBe('"he" AND "llo"')
  })
})
