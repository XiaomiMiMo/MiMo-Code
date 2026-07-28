import { createContext, useContext, type ParentProps, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../component/border"
import { TextAttributes } from "@opentui/core"
import z from "zod"
import { type TuiEvent } from "../event"
import { useLanguage } from "@tui/context/language"

export type ToastOptions = z.infer<typeof TuiEvent.ToastShow.properties>

/**
 * Each toast REPLACES the one on screen, so it is authoritative for the whole
 * object — including `title`, which is optional.
 *
 * Solid's store setter merges plain objects into the existing node
 * (`mergeStoreNode` only writes `Object.keys(next)`). A second toast raised
 * before the first one's timer fires therefore lands on a non-null previous
 * toast and inherits its `title`: `toast.error(err)` passes only
 * `{ variant, message }`, so it used to render under whatever headline the
 * preceding success toast had set, attributing a failure to unrelated work.
 */
export function nextToast(options: Omit<ToastOptions, "duration">) {
  return reconcile(options)
}

export function Toast() {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={toast.currentToast}>
      {(current) => (
        <box
          position="absolute"
          zIndex={4000}
          justifyContent="center"
          alignItems="flex-start"
          top={2}
          right={2}
          maxWidth={Math.min(60, dimensions().width - 6)}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.backgroundPanel}
          borderColor={theme[current().variant]}
          border={["left", "right"]}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <Show when={current().title}>
            <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme.text}>
              {current().title}
            </text>
          </Show>
          <text fg={theme.text} wrapMode="word" width="100%">
            {current().message}
          </text>
        </box>
      )}
    </Show>
  )
}

function init() {
  const [store, setStore] = createStore({
    currentToast: null as ToastOptions | null,
  })
  const t = useLanguage().t

  let timeoutHandle: NodeJS.Timeout | null = null

  const toast = {
    show(options: ToastOptions) {
      const { duration = 5000, ...currentToast } = options
      setStore("currentToast", nextToast(currentToast))
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => {
        setStore("currentToast", null)
      }, duration).unref()
    },
    error: (err: any) => {
      if (err instanceof Error)
        return toast.show({
          variant: "error",
          message: err.message,
        })
      toast.show({
        variant: "error",
        message: t("tui.toast.unknown_error"),
      })
    },
    get currentToast(): ToastOptions | null {
      return store.currentToast
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
