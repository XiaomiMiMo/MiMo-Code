import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { PulseSpinner } from "./enhanced-spinner"
import { isPlainTerminal } from "../util/terminal"
import { SlideIn } from "./message-appear"

export function StartupLoading(props: { ready: () => boolean }) {
  const theme = useTheme().theme
  const plainTerminal = isPlainTerminal()
  const [show, setShow] = createSignal(false)
  const text = createMemo(() => (props.ready() ? "Finishing startup..." : "Loading plugins..."))
  let wait: NodeJS.Timeout | undefined
  let hold: NodeJS.Timeout | undefined
  let stamp = 0

  createEffect(() => {
    if (props.ready()) {
      if (wait) {
        clearTimeout(wait)
        wait = undefined
      }
      if (!show()) return
      if (hold) return

      const left = 3000 - (Date.now() - stamp)
      if (left <= 0) {
        setShow(false)
        return
      }

      hold = setTimeout(() => {
        hold = undefined
        setShow(false)
      }, left).unref()
      return
    }

    if (hold) {
      clearTimeout(hold)
      hold = undefined
    }
    if (show()) return
    if (wait) return

    wait = setTimeout(() => {
      wait = undefined
      stamp = Date.now()
      setShow(true)
    }, 500).unref()
  })

  onCleanup(() => {
    if (wait) clearTimeout(wait)
    if (hold) clearTimeout(hold)
  })

  return (
    <Show when={show()}>
      <SlideIn direction="up" duration={200}>
        <box position="absolute" zIndex={5000} left={0} right={0} bottom={1} justifyContent="center" alignItems="center">
          <box backgroundColor={plainTerminal ? undefined : theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
            <Show when={plainTerminal} fallback={<PulseSpinner color={theme.textMuted}>{text()}</PulseSpinner>}>
              <text fg={theme.textMuted}>{text()}</text>
            </Show>
          </box>
        </box>
      </SlideIn>
    </Show>
  )
}
