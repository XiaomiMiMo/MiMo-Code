import { describe, expect, test } from "bun:test"
import { titlecase } from "../../src/util/locale"

/**
 * The pre-guard implementation, kept here so the claim "every genuine string
 * still renders byte-identically" stays pinned instead of assumed.
 */
const unguarded = (str: string) => str.replace(/\b\w/g, (c) => c.toUpperCase())

/**
 * Stands in for a value read out of tool-part storage. `ToolState.input` is
 * `z.record(z.string(), z.any())`, so nothing guarantees a string reaches the
 * renderer even where the static type claims one.
 */
const untyped = (value: unknown) => value as any

describe("util.locale", () => {
  describe("titlecase", () => {
    test("capitalises every word start", () => {
      expect(titlecase("build")).toBe("Build")
      expect(titlecase("multi word label")).toBe("Multi Word Label")
      expect(titlecase("plan")).toBe("Plan")
    })

    test("is idempotent on already-capitalised input", () => {
      expect(titlecase("Already Capitalised")).toBe("Already Capitalised")
      expect(titlecase(unguarded("Already Capitalised"))).toBe("Already Capitalised")
    })

    test("splits on hyphens and other non-word characters", () => {
      expect(titlecase("multi-word-hyphenated")).toBe("Multi-Word-Hyphenated")
      expect(titlecase("a/b c.d")).toBe("A/B C.D")
    })

    test("returns the empty string unchanged", () => {
      expect(titlecase("")).toBe("")
    })

    test("capitalises through leading and trailing spaces", () => {
      expect(titlecase(" leading and trailing ")).toBe(" Leading And Trailing ")
    })

    test("a leading digit suppresses the boundary for the letter after it", () => {
      // \b only sits between a word and a non-word char, so "a1b" has one
      // boundary (index 0) and "123abc" has one, both at the start.
      expect(titlecase("a1b")).toBe("A1b")
      expect(titlecase("123abc")).toBe("123abc")
    })

    test("matches the unguarded implementation on every string shape", () => {
      const corpus = [
        "",
        " ",
        "  ",
        "a",
        "A",
        "z",
        "hello world",
        "HELLO WORLD",
        "MiXeD cAsE",
        "with-dashes-here",
        "with_underscores_here",
        "  padded  ",
        "trailing space ",
        " leading space",
        "tabs\tand\nnewlines",
        "punctuation! and? more.",
        "emoji 🙂 and text",
        "中文字符 test",
        "a1b2c3",
        "1 2 3",
        "already",
      ]
      for (const value of corpus) {
        expect(titlecase(value)).toBe(unguarded(value))
      }
    })

    // A missing type guard takes down the whole TUI: these run inside Solid
    // memos, so throwing leaves the ErrorBoundary with only "Reset TUI"/"Exit"
    // and no auto-retry. String() keeps the bad value visible instead of
    // blanking the label, so the upstream defect stays diagnosable.
    test("renders a non-string instead of throwing", () => {
      expect(titlecase(untyped(undefined))).toBe("undefined")
      expect(titlecase(untyped(null))).toBe("null")
      expect(titlecase(untyped(42))).toBe("42")
      expect(titlecase(untyped({}))).toBe("[object Object]")
      expect(titlecase(untyped(true))).toBe("true")
      expect(titlecase(untyped(["general", "general"]))).toBe("general,general")
    })

    test("survives the exact expression that crashed the session transcript", () => {
      // The model emitted `subagent_type` as the array ["general","general"]
      // where the tool schema declares an enum. `??` only falls through on
      // nullish, so the array reached `.replace` and killed the render.
      // `untyped` stands in for the storage read: ToolState.input is
      // `z.record(z.string(), z.any())`, so the renderer's declared `string`
      // type is an assertion the data does not honour.
      expect(() => titlecase(untyped(["general", "general"]) ?? "General")).not.toThrow()
      expect(titlecase(untyped(["general", "general"]) ?? "General")).toBe("general,general")

      // The persisted actor-tool shape, including the nested `operation`
      // wrapper the session store actually wrote.
      const persisted = { operation: { subagent_type: ["general", "general"] } }
      expect(() => titlecase(untyped(persisted.operation.subagent_type) ?? untyped(undefined) ?? "General")).not.toThrow()

      const actor = { agent: ["general", "general"] }
      expect(() => titlecase(untyped(undefined) ?? actor.agent ?? "General")).not.toThrow()
      expect(titlecase(untyped(undefined) ?? actor.agent ?? "General")).toBe("general,general")
    })

    test("still honours ?? fall-through for genuinely absent values", () => {
      expect(titlecase(untyped(undefined) ?? "General")).toBe("General")
      expect(titlecase(untyped(null) ?? "General")).toBe("General")
      expect(titlecase(untyped("explore") ?? "General")).toBe("Explore")
    })
  })
})
