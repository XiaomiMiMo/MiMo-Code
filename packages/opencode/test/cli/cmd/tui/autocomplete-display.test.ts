import { describe, expect, test } from "bun:test"
import { padAutocompleteDisplay } from "../../../../src/cli/cmd/tui/component/prompt/autocomplete"

describe("padAutocompleteDisplay", () => {
  test("pads CJK labels by terminal display width", () => {
    const result = padAutocompleteDisplay(["/help", "/前端设计"])

    expect(result.map((item) => Bun.stringWidth(item))).toEqual([11, 11])
    expect(result[0]).toBe("/help      ")
    expect(result[1]).toBe("/前端设计  ")
  })
})
