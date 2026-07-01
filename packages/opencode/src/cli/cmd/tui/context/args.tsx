import { createSimpleContext } from "./helper"

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
  neverAsk?: boolean
  /**
   * Phase 6: when true, the TUI launches straight into the grid view. The
   * grid component restores the persisted layout from
   * `~/.mimocode/grid-layout.json` on mount by default; combine with
   * `--session` / `--continue` to seed a single cell on first launch.
   */
  grid?: boolean
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
