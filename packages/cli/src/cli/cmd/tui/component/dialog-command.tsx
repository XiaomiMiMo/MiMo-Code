import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import { isEditBufferRenderable } from "@opentui/core"
import {
  createContext,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { useLanguage } from "@tui/context/language"

const CATEGORY_KEYS: Record<string, string> = {
  session: "tui.command.category.session",
  agent: "tui.command.category.agent",
  provider: "tui.command.category.provider",
  system: "tui.command.category.system",
  prompt: "tui.command.category.prompt",
  internal: "tui.command.category.internal",
  external: "tui.command.category.external",
}

type Context = ReturnType<typeof init>
const ctx = createContext<Context>()

export type Slash = {
  name: string
  aliases?: string[]
}

export type CommandOption = DialogSelectOption<string> & {
  keybind?: string
  suggested?: boolean
  slash?: Slash
  hidden?: boolean
  enabled?: boolean
}

function init() {
  const root = getOwner()
  const [registrations, setRegistrations] = createSignal<Accessor<CommandOption[]>[]>([])
  const [suspendCount, setSuspendCount] = createSignal(0)
  const dialog = useDialog()
  const keybind = useKeybind()
  const lang = useLanguage()
  const renderer = useRenderer()

  const localizeCategory = (category: string | undefined) => {
    if (!category) return category
    const key = CATEGORY_KEYS[category]
    if (key) return lang.t(key)
    return category
  }

  // The command value (e.g. "session.list") and slash names are stable English
  // identifiers. Expose them as latin search keywords so users in a non-English
  // locale can still find commands by typing "session", "model", "theme", etc.
  // without switching input method, even though the visible title is localized.
  const deriveKeywords = (option: CommandOption) => {
    const tokens = [option.value, ...option.value.split(/[.\-_:]/)]
    if (option.slash) tokens.push(option.slash.name, ...(option.slash.aliases ?? []))
    return [...new Set([...(option.keywords ?? []), ...tokens].filter(Boolean))]
  }

  const entries = createMemo(() => {
    const all = registrations().flatMap((x) => x())
    return all.map((x) => ({
      ...x,
      category: localizeCategory(x.category),
      keywords: deriveKeywords(x),
      footer: x.keybind ? keybind.print(x.keybind) : undefined,
    }))
  })

  const isEnabled = (option: CommandOption) => option.enabled !== false
  const isVisible = (option: CommandOption) => isEnabled(option) && !option.hidden

  const visibleOptions = createMemo(() => entries().filter((option) => isVisible(option)))
  const suggestedOptions = createMemo(() =>
    visibleOptions()
      .filter((option) => option.suggested)
      .map((option) => ({
        ...option,
        value: `suggested:${option.value}`,
        category: lang.t("tui.command.palette.suggested"),
      })),
  )
  const suspended = () => suspendCount() > 0
  const isTextEditingKey = (evt: Parameters<typeof keybind.match>[1]) =>
    Object.keys(keybind.all).some(
      (name) =>
        (name.startsWith("input_") || name === "history_previous" || name === "history_next") &&
        keybind.match(name, evt),
    )

  useKeyboard((evt) => {
    if (suspended()) return
    if (dialog.stack.length > 0) return
    if (evt.defaultPrevented) return
    const textInputFocused = isEditBufferRenderable(renderer.currentFocusedRenderable)
    const textEditingKey = textInputFocused && isTextEditingKey(evt)
    for (const option of entries()) {
      if (!isEnabled(option)) continue
      if (textEditingKey && !option.keybind?.startsWith("input_")) continue
      if (option.keybind && keybind.match(option.keybind, evt)) {
        evt.preventDefault()
        option.onSelect?.(dialog)
        return
      }
    }
  })

  const result = {
    trigger(name: string) {
      for (const option of entries()) {
        if (option.value === name) {
          if (!isEnabled(option)) return
          option.onSelect?.(dialog)
          return
        }
      }
    },
    slashes() {
      return visibleOptions().flatMap((option) => {
        const slash = option.slash
        if (!slash) return []
        const description = option.description ?? option.title
        const onSelect = () => result.trigger(option.value)
        return [
          { display: "/" + slash.name, description, onSelect },
          ...(slash.aliases ?? []).map((alias) => ({
            display: "/" + alias,
            description,
            onSelect,
          })),
        ]
      })
    },
    keybinds(enabled: boolean) {
      setSuspendCount((count) => count + (enabled ? -1 : 1))
    },
    suspended,
    show() {
      dialog.replace(() => <DialogCommand options={visibleOptions()} suggestedOptions={suggestedOptions()} />)
    },
    register(cb: () => CommandOption[]) {
      const owner = getOwner() ?? root
      if (!owner) return () => {}

      let list: Accessor<CommandOption[]> | undefined

      // TUI plugins now register commands via an async store that runs outside an active reactive scope.
      // runWithOwner attaches createMemo/onCleanup to this owner so plugin registrations stay reactive and dispose correctly.
      runWithOwner(owner, () => {
        list = createMemo(cb)
        const ref = list
        if (!ref) return
        setRegistrations((arr) => [ref, ...arr])
        onCleanup(() => {
          setRegistrations((arr) => arr.filter((x) => x !== ref))
        })
      })

      if (!list) return () => {}
      let done = false
      return () => {
        if (done) return
        done = true
        const ref = list
        if (!ref) return
        setRegistrations((arr) => arr.filter((x) => x !== ref))
      }
    },
  }
  return result
}

export function useCommandDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useCommandDialog must be used within a CommandProvider")
  }
  return value
}

export function CommandProvider(props: ParentProps) {
  const value = init()
  const dialog = useDialog()
  const keybind = useKeybind()

  useKeyboard((evt) => {
    if (value.suspended()) return
    if (dialog.stack.length > 0) return
    if (evt.defaultPrevented) return
    if (keybind.match("command_list", evt)) {
      evt.preventDefault()
      value.show()
      return
    }
  })

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

function DialogCommand(props: { options: CommandOption[]; suggestedOptions: CommandOption[] }) {
  const lang = useLanguage()
  let ref: DialogSelectRef<string>
  const list = () => {
    if (ref?.filter) return props.options
    return [...props.suggestedOptions, ...props.options]
  }
  return <DialogSelect ref={(r) => (ref = r)} title={lang.t("tui.command.palette.title")} options={list()} />
}
