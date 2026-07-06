import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"

/**
 * Phase 5 inline error display for grid cells.
 *
 * Distinct from the global `ErrorComponent`: this overlay is rendered inside
 * the cell viewport when a non-fatal error is caught by a local
 * `ErrorBoundary`, so the rest of the grid (and the active cell) keeps
 * working. The overlay shows the cell label, the error message, and a
 * collapsed stack-trace.
 */
export function CellErrorOverlay(props: { error: unknown; cellLabel?: string }) {
  const { theme } = useTheme()
  const message = () => (props.error instanceof Error ? props.error.message : String(props.error))
  const stack = () => (props.error instanceof Error ? (props.error.stack ?? "") : "")

  return (
    <box
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      borderColor={theme.error}
      border={["left", "right"]}
      customBorderChars={{ ...SplitBorder.customBorderChars }}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      flexGrow={1}
    >
      <text fg={theme.error} attributes={TextAttributes.BOLD}>
        <span style={{ fg: theme.error }}>⚠ </span>
        {props.cellLabel ? `${props.cellLabel} crashed` : "Cell crashed"}
      </text>
      <text fg={theme.text} wrapMode="word">
        {message()}
      </text>
      <Show when={stack()}>
        <text fg={theme.textMuted} wrapMode="word">
          {stack().split("\n").slice(0, 3).join("\n")}
        </text>
      </Show>
    </box>
  )
}
