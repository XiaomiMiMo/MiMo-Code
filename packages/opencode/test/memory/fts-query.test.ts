import { describe, test, expect } from "bun:test"
import { buildFtsQuery } from "../../src/memory/fts-query"

describe("buildFtsQuery", () => {
  test("tokenizes whitespace-separated words and OR-joins", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"')
  })

  test("treats `_` as part of a token but `-` as a separator", () => {
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" OR "baz" OR "1"')
  })

  test("keeps CJK ideographs as a single token", () => {
    expect(buildFtsQuery("金银价格")).toBe('"金银价格"')
  })

  test("splits Japanese on whitespace boundaries", () => {
    expect(buildFtsQuery("価格 2026年")).toBe('"価格" OR "2026年"')
  })

  test("returns null for empty / whitespace-only query", () => {
    expect(buildFtsQuery("")).toBeNull()
    expect(buildFtsQuery("   ")).toBeNull()
  })

  test("splits identifiers like T5.3 into alphanumeric runs", () => {
    expect(buildFtsQuery("T5.3 closure")).toBe('"T5" OR "3" OR "closure"')
  })

  test("strips arbitrary FTS5 punctuation (parens, stars, slashes)", () => {
    expect(buildFtsQuery("(foo) bar* baz/qux")).toBe('"foo" OR "bar" OR "baz" OR "qux"')
  })

  test("treats embedded quotes inside the original raw input as separators", () => {
    expect(buildFtsQuery('say "hi"')).toBe('"say" OR "hi"')
  })

  test("treats SQL-like keywords as literals after quoting", () => {
    expect(buildFtsQuery("foo and bar")).toBe('"foo" OR "and" OR "bar"')
  })

  test("a stray non-matching word no longer zeroes the query (OR semantics)", () => {
    // The DSN-recall regression: "postgres database port 5433" where the doc
    // lacks "database". Under AND a single absent word zeroed the whole query;
    // under OR every present token still contributes and BM25 ranks by overlap.
    expect(buildFtsQuery("postgres database port 5433")).toBe('"postgres" OR "database" OR "port" OR "5433"')
  })
})
