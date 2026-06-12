import { expect, test } from "bun:test"
import { ConfigKeybinds } from "../../src/config/keybinds"
import { Keybind } from "../../src/util"

test("input paste default includes Shift+Insert for terminal-safe paste", () => {
  const value = ConfigKeybinds.Keybinds.shape.input_paste.parse(undefined)
  expect(value).toBe("ctrl+v,shift+insert")
  expect(Keybind.parse(value).map(Keybind.toString)).toEqual(["ctrl+v", "shift+insert"])
})
