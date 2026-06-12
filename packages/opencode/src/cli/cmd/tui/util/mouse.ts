import type { TuiConfig } from "../config/tui"

export function mouseEnabledForRenderer(
  config: Pick<TuiConfig.Info, "mouse">,
  input: {
    plainTerminal: boolean
    disableMouse: boolean
    platform?: NodeJS.Platform
  },
) {
  return !input.plainTerminal && !input.disableMouse && (config.mouse ?? (input.platform ?? process.platform) !== "win32")
}
