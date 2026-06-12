import { describe, expect, test } from "bun:test"
import { numpadInputText } from "./numpad"

describe("numpadInputText", () => {
  test("returns printable numpad digits and operators", () => {
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "Numpad1", key: "1" }))).toBe("1")
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "NumpadDecimal", key: "." }))).toBe(".")
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "NumpadAdd", key: "+" }))).toBe("+")
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "NumpadSubtract", key: "-" }))).toBe("-")
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "NumpadMultiply", key: "*" }))).toBe("*")
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "NumpadDivide", key: "/" }))).toBe("/")
  })

  test("falls back when webviews report named or unidentified numpad keys", () => {
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "NumpadDecimal", key: "Decimal" }))).toBe(".")
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "NumpadAdd", key: "Add" }))).toBe("+")
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "Numpad2", key: "Unidentified" }))).toBe("2")
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "Numpad3", key: "Process" }))).toBe("3")
  })

  test("ignores shortcuts and numlock navigation keys", () => {
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "Digit1", key: "1" }))).toBeUndefined()
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "Numpad1", key: "1", ctrlKey: true }))).toBeUndefined()
    expect(numpadInputText(new KeyboardEvent("keydown", { code: "Numpad1", key: "End" }))).toBeUndefined()
  })
})
