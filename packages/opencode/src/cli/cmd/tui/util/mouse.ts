import type { TuiConfig } from "@/cli/cmd/tui/config/tui"

export function isMouseEnabled(
  config: Pick<TuiConfig.Info, "mouse">,
  options: { platform: NodeJS.Platform; plainTerminal: boolean; disabled: boolean },
) {
  if (options.plainTerminal || options.disabled) return false
  if (config.mouse !== undefined) return config.mouse
  if (options.platform === "win32") return false
  return true
}
