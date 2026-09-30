import type { KeyEvent, Renderable } from "@opentui/core"
import type {
  ActiveBinding,
  Binding,
  Command,
  CommandContext,
  CommandEntry,
  CommandQuery,
  KeyLike,
  KeySequencePart,
  Layer,
  TuiKeymap,
} from "@mimo-ai/plugin/tui"
import type { CommandOption, useCommandDialog } from "@tui/component/dialog-command"
import type { useKeybind } from "@tui/context/keybind"
import type { useDialog } from "@tui/ui/dialog"
import { Keybind } from "@/util"

type PluginTarget = Renderable
type PluginCommand = Command<PluginTarget, KeyEvent>
type PluginBinding = Binding<PluginTarget, KeyEvent>
type PluginLayer = Layer<PluginTarget, KeyEvent>

type CommandRegistryEntry = {
  command: PluginCommand
  binding?: PluginBinding
}

type FunctionBindingEntry = {
  value: string
  binding: PluginBinding & { cmd: (ctx: CommandContext<PluginTarget, KeyEvent>) => unknown }
}

type Input = {
  command: ReturnType<typeof useCommandDialog>
  keybind: ReturnType<typeof useKeybind>
  dialog: ReturnType<typeof useDialog>
}

type ContextOptions = {
  command?: PluginCommand
  event?: KeyEvent
  payload?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function keyLikeToString(key: KeyLike): string {
  if (typeof key === "string") return key
  return Keybind.toString({
    name: key.name,
    ctrl: key.ctrl ?? false,
    meta: key.meta ?? false,
    shift: key.shift ?? false,
    super: key.super ?? false,
    leader: false,
  })
}

function keyLikeToInfo(key: KeyLike): Keybind.Info | undefined {
  if (typeof key === "string") return Keybind.parse(key).at(0)
  return {
    name: key.name,
    ctrl: key.ctrl ?? false,
    meta: key.meta ?? false,
    shift: key.shift ?? false,
    super: key.super ?? false,
    leader: false,
  }
}

function removeEntry<Value>(list: Value[], entry: Value) {
  const index = list.indexOf(entry)
  if (index >= 0) list.splice(index, 1)
}

/**
 * Narrow `api.keymap` implementation bridging to the fork's command dialog
 * (`useCommandDialog`) and keybind system. `registerLayer` registers each layer
 * command as a command-palette entry and each function-valued binding as a
 * hidden keybind option; the existing keyboard loop matches `option.keybind`
 * and calls `onSelect`, so bindings fire through the dialog path.
 * `dispatchCommand` runs keymap commands directly so it can thread
 * `options.payload`/`options.event` into the command context, and falls back to
 * the option's `onSelect` for commands registered outside the keymap.
 *
 * Known gaps vs upstream `@opentui/keymap`: no sequence keys, no layer
 * target/priority/targetMode semantics, no reactive `enabled`/`suggested`
 * subscriptions (evaluated once at registration), and `on`/`intercept` are
 * no-op stubs.
 */
export function createPluginKeymap(input: Input): TuiKeymap {
  const registry: CommandRegistryEntry[] = []
  const functionBindings: FunctionBindingEntry[] = []
  const data = new Map<string, unknown>()

  const buildCommandContext = (
    keymap: TuiKeymap,
    commandInput: string,
    opts?: ContextOptions,
  ): CommandContext<PluginTarget, KeyEvent> => ({
    keymap,
    event: opts?.event,
    focused: null,
    target: null,
    data: Object.fromEntries(data),
    command: opts?.command,
    input: commandInput,
    payload: opts?.payload,
  })

  const toActiveBinding = (binding: PluginBinding, keymap: TuiKeymap): ActiveBinding<PluginTarget, KeyEvent> => ({
    sequence: keymap.parseKeySequence(binding.key),
    command: binding.cmd,
    event: binding.event ?? "press",
    preventDefault: binding.preventDefault ?? true,
    fallthrough: binding.fallthrough ?? false,
  })

  const commandOption = (entry: CommandRegistryEntry, keymap: TuiKeymap): CommandOption => {
    const { command: cmd, binding } = entry
    const slashName = str(cmd.slashName)
    const slashAliases = Array.isArray(cmd.slashAliases)
      ? cmd.slashAliases.filter((x): x is string => typeof x === "string")
      : undefined
    return {
      title: str(cmd.title) ?? cmd.name,
      value: cmd.name,
      description: str(cmd.desc) ?? str(cmd.description),
      category: str(cmd.category),
      slash: slashName ? { name: slashName, aliases: slashAliases } : undefined,
      suggested: typeof cmd.suggested === "function" ? Boolean(cmd.suggested()) : (cmd.suggested as boolean | undefined),
      enabled: typeof cmd.enabled === "function" ? Boolean(cmd.enabled()) : (cmd.enabled as boolean | undefined),
      keybind: binding ? keyLikeToString(binding.key) : undefined,
      onSelect: () => cmd.run(buildCommandContext(keymap, cmd.name, { command: cmd })),
    }
  }

  const fnBindingOption = (entry: FunctionBindingEntry, keymap: TuiKeymap): CommandOption => ({
    title: entry.value,
    value: entry.value,
    hidden: true,
    keybind: keyLikeToString(entry.binding.key),
    onSelect: () => entry.binding.cmd(buildCommandContext(keymap, entry.value, {})),
  })

  const filterCommands = (
    commands: PluginCommand[],
    query?: CommandQuery<PluginTarget, KeyEvent>,
  ): PluginCommand[] => {
    let list = commands
    if (query?.search) {
      const searchIn = query.searchIn?.length ? query.searchIn : ["name"]
      const needle = query.search.toLowerCase()
      list = list.filter((cmd) =>
        searchIn.some((field) => {
          const value = cmd[field]
          return typeof value === "string" && value.toLowerCase().includes(needle)
        }),
      )
    }
    if (typeof query?.filter === "function") list = list.filter(query.filter)
    else if (query?.filter) {
      for (const [field, expected] of Object.entries(query.filter)) {
        list = list.filter((cmd) => {
          if (typeof expected === "function") return Boolean(expected(cmd[field], cmd))
          if (Array.isArray(expected)) return expected.includes(cmd[field])
          return cmd[field] === expected
        })
      }
    }
    if (query?.limit != null) list = list.slice(0, query.limit)
    return list
  }

  const keymap: TuiKeymap = {
    registerLayer(layer: PluginLayer) {
      const commands = layer.commands ?? []
      const bindings = layer.bindings ?? []
      const commandEntries = commands.map((command) => ({
        command,
        binding: bindings.find((b) => b.cmd === command.name),
      }))
      const fnEntries = bindings
        .filter(
          (b): b is PluginBinding & { cmd: (ctx: CommandContext<PluginTarget, KeyEvent>) => unknown } =>
            typeof b.cmd === "function",
        )
        .map((binding, index) => ({
          value: `__keybind:${keyLikeToString(binding.key)}:${index}`,
          binding,
        }))
      for (const entry of commandEntries) registry.push(entry)
      for (const entry of fnEntries) functionBindings.push(entry)
      const dispose = input.command.register(() => [
        ...commandEntries.map((entry) => commandOption(entry, keymap)),
        ...fnEntries.map((entry) => fnBindingOption(entry, keymap)),
      ])
      return () => {
        for (const entry of commandEntries) removeEntry(registry, entry)
        for (const entry of fnEntries) removeEntry(functionBindings, entry)
        dispose()
      }
    },
    dispatchCommand(name, options) {
      if (name === "command.palette.show") {
        input.command.show()
        return { ok: true }
      }
      const option = input.command.find(name)
      if (!option) return { ok: false, reason: "not-found" }
      if (option.enabled === false) return { ok: false, reason: "disabled" }
      const command = registry.find((entry) => entry.command.name === name)?.command
      if (command) {
        command.run(buildCommandContext(keymap, name, { command, event: options?.event, payload: options?.payload }))
        return { ok: true, command }
      }
      const fnBinding = functionBindings.find((entry) => entry.value === name)
      if (fnBinding) {
        fnBinding.binding.cmd(buildCommandContext(keymap, name, { event: options?.event, payload: options?.payload }))
        return { ok: true }
      }
      option.onSelect?.(input.dialog)
      return { ok: true }
    },
    runCommand(name, options) {
      return keymap.dispatchCommand(name, options)
    },
    getCommands(query) {
      return filterCommands(registry.map((entry) => entry.command), query)
    },
    getCommandEntries(query) {
      return keymap.getCommands(query).map((command): CommandEntry<PluginTarget, KeyEvent> => {
        const binding = registry.find((x) => x.command === command)?.binding
        return { command, bindings: binding ? [toActiveBinding(binding, keymap)] : [] }
      })
    },
    getCommandBindings(query) {
      const map = new Map<string, readonly ActiveBinding<PluginTarget, KeyEvent>[]>()
      for (const command of keymap.getCommands(query)) {
        const binding = registry.find((x) => x.command === command)?.binding
        if (!binding) continue
        map.set(command.name, [toActiveBinding(binding, keymap)])
      }
      return map
    },
    setData(name, value) {
      data.set(name, value)
    },
    getData(name) {
      return data.get(name)
    },
    on() {
      return () => {}
    },
    intercept() {
      return () => {}
    },
    createKeyMatcher(key) {
      const target = keyLikeToInfo(key)
      return (input) => {
        if (!input) return false
        const info = keyLikeToInfo(input)
        if (!info || !target) return false
        return Keybind.match(target, info)
      }
    },
    parseKeySequence(key) {
      return Keybind.parse(keyLikeToString(key)).map((info): KeySequencePart => ({
        stroke: {
          name: info.name,
          ctrl: info.ctrl,
          shift: info.shift,
          meta: info.meta,
          super: info.super ?? false,
        },
        display: Keybind.toString(info),
        match: Keybind.toString(info),
      }))
    },
    formatKey(key) {
      return Keybind.toString(keyLikeToInfo(key))
    },
  }

  return keymap
}
