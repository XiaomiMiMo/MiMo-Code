import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { Show, createEffect, createSignal, onMount, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Spinner } from "../component/spinner"
import { useLanguage } from "@tui/context/language"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useLanguage().t
  let textarea: TextareaRenderable

  useKeyboard((evt) => {
    if (props.busy) {
      if (evt.name === "escape") return
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "return") {
      props.onConfirm?.(textarea.plainText)
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {t("tui.dialog.close_hint")}
        </text>
      </box>
      <box gap={1}>
        {props.description}
        <textarea
          onSubmit={() => {
            if (props.busy) return
            props.onConfirm?.(textarea.plainText)
          }}
          height={3}
          keyBindings={props.busy ? [] : [{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => {
            textarea = val
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? t("tui.dialog.prompt.placeholder")}
          placeholderColor={theme.textMuted}
          textColor={props.busy ? theme.textMuted : theme.text}
          focusedTextColor={props.busy ? theme.textMuted : theme.text}
          cursorColor={props.busy ? theme.backgroundElement : theme.text}
        />
        <Show when={props.busy}>
          <Spinner color={theme.textMuted}>{props.busyText ?? t("tui.dialog.prompt.busy")}</Spinner>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>{t("tui.dialog.prompt.processing")}</text>}>
          <text
            fg={theme.text}
            onMouseUp={() => {
              props.onConfirm?.(textarea.plainText)
            }}
          >
            {t("tui.dialog.prompt.submit_key")}{" "}
            <span style={{ fg: theme.textMuted }}>{t("tui.dialog.prompt.submit_action")}</span>
          </text>
        </Show>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}

// Prompt for input, then keep the SAME dialog mounted in a busy state while
// `handler` runs against the entered value. Gives immediate pending feedback
// for long async work (e.g. the /btw fork-query) instead of a stale, idle
// dialog. The dialog stays open until `handler` resolves so the caller can
// swap in a result dialog; on empty input or cancel it clears and resolves null.
// The busy signal lives inside an internal component (same pattern as
// DialogMimoLogin) so toggling busy updates props reactively without remounting.
// `handler` receives an `active()` accessor that returns false once the busy
// dialog was dismissed (Escape/click-away), so callers can skip surfacing a
// now-stale answer.
DialogPrompt.ask = <T,>(
  dialog: DialogContext,
  title: string,
  handler: (value: string, active: () => boolean) => Promise<T>,
  options?: Omit<DialogPromptProps, "title" | "busy" | "busyText" | "onConfirm" | "onCancel"> & { busyText?: string },
) => {
  return new Promise<T | null>((resolve) => {
    let dismissed = false
    const active = () => !dismissed
    function Asker() {
      const [busy, setBusy] = createSignal(false)
      return (
        <DialogPrompt
          title={title}
          {...options}
          busy={busy()}
          busyText={options?.busyText}
          onConfirm={(entered) => {
            if (busy()) return
            const trimmed = entered.trim()
            if (!trimmed) {
              dialog.clear()
              resolve(null)
              return
            }
            setBusy(true)
            handler(trimmed, active).then(
              (result) => resolve(result),
              () => resolve(null),
            )
          }}
          onCancel={() => resolve(null)}
        />
      )
    }
    dialog.replace(
      () => <Asker />,
      () => {
        dismissed = true
        resolve(null)
      },
    )
  })
}

// Show a busy/spinner dialog immediately for a pre-known value (no input step)
// while `handler` runs. Used by the inline `/btw <question>` form where the
// question is already typed, so the user still gets instant pending feedback.
// `handler` receives an `active()` accessor (false once dismissed) so a
// now-stale answer can be skipped.
DialogPrompt.busy = <T,>(
  dialog: DialogContext,
  title: string,
  value: string,
  handler: (active: () => boolean) => Promise<T>,
  options?: { busyText?: string },
) => {
  return new Promise<T | null>((resolve) => {
    let dismissed = false
    const active = () => !dismissed
    dialog.replace(
      () => <DialogPrompt title={title} value={value} busy={true} busyText={options?.busyText} />,
      () => {
        dismissed = true
      },
    )
    handler(active).then(
      (result) => resolve(result),
      () => resolve(null),
    )
  })
}
