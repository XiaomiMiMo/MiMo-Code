import { describe, expect, test } from "bun:test"
import { rendererConfig } from "../../../src/cli/cmd/tui/app"
import { TuiInfo } from "../../../src/cli/cmd/tui/config/tui-schema"

describe("rendererConfig", () => {
  test("allows main screen mode for terminal scrollback", () => {
    const config = TuiInfo.parse({ screen_mode: "main-screen" })

    expect(rendererConfig(config, false).screenMode).toBe("main-screen")
  })

  test("keeps alternate screen as the default renderer behavior", () => {
    expect(rendererConfig(TuiInfo.parse({}), false).screenMode).toBeUndefined()
  })

  test("plain terminal still forces main screen mode", () => {
    expect(rendererConfig(TuiInfo.parse({}), true).screenMode).toBe("main-screen")
  })
})
