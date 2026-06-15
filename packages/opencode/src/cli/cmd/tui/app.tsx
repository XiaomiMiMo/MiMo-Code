import { render, TimeToFirstDraw, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import * as Selection from "@tui/util/selection"
import { createCliRenderer, MouseButton, type CliRendererConfig } from "@opentui/core"
import { RouteProvider, useRoute } from "@tui/context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  batch,
  Show,
} from "solid-js"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { Flag } from "@/flag/flag"
import semver from "semver"
import { DialogProvider, useDialog } from "@tui/ui/dialog"
import { DialogMimoLogin } from "@tui/component/dialog-mimo-login"
import { ErrorComponent } from "@tui/component/error-component"
import { PluginRouteMissing } from "@tui/component/plugin-route-missing"
import { ProjectProvider } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { SDKProvider, useSDK } from "@tui/context/sdk"
import { StartupLoading } from "@tui/component/startup-loading"
import { SyncProvider, useSync } from "@tui/context/sync"
import { LocalProvider, useLocal } from "@tui/context/local"
import { DialogModel, useConnected } from "@tui/component/dialog-model"
import { DialogMcp } from "@tui/component/dialog-mcp"
import { DialogStatus } from "@tui/component/dialog-status"
import { DialogWorktree } from "@tui/component/dialog-worktree"
import { DialogThemeList } from "@tui/component/dialog-theme-list"
import { DialogImageList } from "@tui/component/dialog-image-list"
import { DialogLogoDesign } from "@tui/component/dialog-logo-design"
import { DialogHelp } from "./ui/dialog-help"
import { CommandProvider, useCommandDialog } from "@tui/component/dialog-command"
import { DialogAgent } from "@tui/component/dialog-agent"
import { DialogSessionList } from "@tui/component/dialog-session-list"
import { DialogWorkflows } from "@tui/component/dialog-workflows"
import { DialogConsoleOrg } from "@tui/component/dialog-console-org"
import { KeybindProvider, useKeybind } from "@tui/context/keybind"
import { ThemeProvider, useTheme } from "@tui/context/theme"
import { Home } from "@tui/routes/home"
import { Session } from "@tui/routes/session"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { DialogConfirm } from "./ui/dialog-confirm"
import { ToastProvider, useToast } from "./ui/toast"
import { ExitProvider, useExit } from "./context/exit"
import { Session as SessionApi } from "@/session"
import { TuiEvent } from "./event"
import { KVProvider, useKV } from "./context/kv"
import { LanguageProvider, UiI18nBridge, useLanguage } from "./context/language"
import type { Locale } from "./i18n/locales"
import { LOCALES } from "./i18n/locales"
import { DialogSelect } from "./ui/dialog-select"
import { Provider } from "@/provider"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { Process } from "@/util"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig } from "./context/tui-config"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { createTuiApi, TuiPluginRuntime, type RouteMap } from "./plugin"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { isPlainTerminal } from "./util/terminal"

import type { EventSource } from "./context/sdk"
import { DialogVariant } from "./component/dialog-variant"

function rendererConfig(_config: TuiConfig.Info, plainTerminal: boolean): CliRendererConfig {
  const mouseEnabled = !plainTerminal && !Flag.MIMOCODE_DISABLE_MOUSE && (_config.mouse ?? true)

  return {
    externalOutputMode: "passthrough",
    targetFps: plainTerminal ? 10 : 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: plainTerminal ? null : {},
    autoFocus: false,
    openConsoleOnError: false,
    enableMouseMovement: mouseEnabled,
    useMouse: mouseEnabled,
    ...(plainTerminal
      ? {
          maxFps: 15,
          screenMode: "main-screen" as const,
          useThread: false,
          backgroundColor: "transparent",
        }
      : {
          maxFps: 60,
        }),
    consoleOptions: {
      keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
      onCopySelection: (text) => {
        Clipboard.copy(text).catch((error) => {
          console.error(`Failed to copy console selection to clipboard: ${error}`)
        })
      },
    },
  }
}

function errorMessage(error: unknown) {
  const formatted = FormatError(error)
  if (formatted !== undefined) return formatted
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return FormatUnknownError(error)
}

export function tui(input: {
  url: string
  args: Args
  config: TuiConfig.Info
  onSnapshot?: () => Promise<string[]>
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
}) {
  // promise to prevent immediate exit
  // oxlint-disable-next-line no-async-promise-executor -- intentional: async executor used for sequential setup before resolve
  return new Promise<void>(async (resolve) => {
    const unguard = win32InstallCtrlCGuard()
    win32DisableProcessedInput()

    const onExit = async () => {
      unguard?.()
      resolve()
    }

    const onBeforeExit = async () => {
      await TuiPluginRuntime.dispose()
    }

    const plainTerminal = isPlainTerminal()
    const renderer = await createCliRenderer(rendererConfig(input.config, plainTerminal))
    // 默认使用 dark 模式(不跟随终端背景);用户手动切换后会被 theme_mode_lock 记住并优先。
    const mode = "dark"

    await render(() => {
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <ErrorComponent error={error} reset={reset} onBeforeExit={onBeforeExit} onExit={onExit} mode={mode} />
          )}
        >
          <ArgsProvider {...input.args}>
            <ExitProvider onBeforeExit={onBeforeExit} onExit={onExit}>
              <KVProvider>
                <LanguageProvider>
                  <UiI18nBridge>
                <ToastProvider>
                  <RouteProvider
                    initialRoute={
                      input.args.continue
                        ? {
                            type: "session",
                            sessionID: "dummy",
                          }
                        : undefined
                    }
                  >
                    <TuiConfigProvider config={input.config}>
                      <SDKProvider
                        url={input.url}
                        directory={input.directory}
                        fetch={input.fetch}
                        headers={input.headers}
                        events={input.events}
                      >
                        <ProjectProvider>
                          <SyncProvider>
                            <ThemeProvider mode={mode} plain={plainTerminal}>
                              <LocalProvider>
                                <KeybindProvider>
                                  <PromptStashProvider>
                                    <DialogProvider>
                                      <CommandProvider>
                                        <FrecencyProvider>
                                          <PromptHistoryProvider>
                                            <PromptRefProvider>
                                              <App onSnapshot={input.onSnapshot} />
                                            </PromptRefProvider>
                                          </PromptHistoryProvider>
                                        </FrecencyProvider>
                                      </CommandProvider>
                                    </DialogProvider>
                                  </PromptStashProvider>
                                </KeybindProvider>
                              </LocalProvider>
                            </ThemeProvider>
                          </SyncProvider>
                        </ProjectProvider>
                      </SDKProvider>
                    </TuiConfigProvider>
                  </RouteProvider>
                </ToastProvider>
                  </UiI18nBridge>
                </LanguageProvider>
              </KVProvider>
            </ExitProvider>
          </ArgsProvider>
        </ErrorBoundary>
      )
    }, renderer)
  })
}

function App(props: { onSnapshot?: () => Promise<string[]> }) {
  const tuiConfig = useTuiConfig()
  const plainTerminal = isPlainTerminal()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const command = useCommandDialog()
  const keybind = useKeybind()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, setMode, locked, lock, unlock } = themeState
  const sync = useSync()
  const exit = useExit()
  const promptRef = usePromptRef()
  const lang = useLanguage()
  const t = lang.t
  const routes: RouteMap = new Map()
  const [routeRev, setRouteRev] = createSignal(0)
  const routeView = (name: string) => {
    routeRev()
    return routes.get(name)?.at(-1)?.render
  }

  const api = createTuiApi({
    command,
    tuiConfig,
    dialog,
    keybind,
    kv,
    route,
    routes,
    bump: () => setRouteRev((x) => x + 1),
    event,
    sdk,
    sync,
    theme: themeState,
    toast,
    renderer,
  })
  const [ready, setReady] = createSignal(false)
  TuiPluginRuntime.init({
    api,
    config: tuiConfig,
  })
    .catch((error) => {
      console.error("Failed to load TUI plugins", error)
    })
    .finally(() => {
      setReady(true)
    })

  useKeyboard((evt) => {
    if (!Flag.MIMOCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
    const sel = renderer.getSelection()
    if (!sel) return

    // Windows Terminal-like behavior:
    // - Ctrl+C copies and dismisses selection
    // - Esc dismisses selection
    // - Most other key input dismisses selection and is passed through
    if (evt.ctrl && evt.name === "c") {
      if (!Selection.copy(renderer, toast, t("tui.toast.copied_to_clipboard"))) {
        renderer.clearSelection()
        return
      }

      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    if (evt.name === "escape") {
      renderer.clearSelection()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    const focus = renderer.currentFocusedRenderable
    if (focus?.hasSelection() && sel.selectedRenderables.includes(focus)) {
      return
    }

    renderer.clearSelection()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copy(text)
      .then(() => toast.show({ message: t("tui.toast.copied_to_clipboard"), variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.MIMOCODE_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("MiMoCode")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || SessionApi.isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("MiMoCode")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      renderer.setTerminalTitle(`MC | ${title}`)
      return
    }

    if (route.data.type === "plugin") {
      renderer.setTerminalTitle(`OC | ${route.data.id}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Provider.parseModel(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })


  const connected = useConnected()

  // Seed never-ask from the launch flag once connected (the server starts with
  // it off; this mirrors --never-ask to the question service).
  let seededNeverAsk = false
  createEffect(() => {
    if (seededNeverAsk || !args.neverAsk || !connected()) return
    seededNeverAsk = true
    local.neverAsk.set(true)
  })

  command.register(() => [
    {
      title: t("tui.command.session.list.title"),
      value: "session.list",
      keybind: "session_list",
      category: "session",
      suggested: sync.data.session.length > 0,
      slash: {
        name: "sessions",
        aliases: ["resume", "continue"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogSessionList />)
      },
    },
    {
      title: t("tui.command.workflow.list.title"),
      value: "workflow.list",
      category: "session",
      enabled: Flag.MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL,
      slash: {
        name: "workflows",
      },
      onSelect: () => {
        dialog.replace(() => <DialogWorkflows />)
      },
    },
    {
      title: t("tui.command.session.new.title"),
      suggested: route.data.type === "session",
      value: "session.new",
      keybind: "session_new",
      category: "session",
      slash: {
        name: "new",
        aliases: ["clear"],
      },
      onSelect: () => {
        route.navigate({
          type: "home",
        })
        dialog.clear()
      },
    },
    {
      title: t("tui.command.model.list.title"),
      value: "model.list",
      keybind: "model_list",
      suggested: true,
      category: "agent",
      slash: {
        name: "models",
      },
      onSelect: () => {
        dialog.replace(() => <DialogModel />)
      },
    },
    {
      title: t("tui.command.model.cycle_recent.title"),
      value: "model.cycle_recent",
      keybind: "model_cycle_recent",
      category: "agent",
      hidden: true,
      onSelect: () => {
        local.model.cycle(1)
      },
    },
    {
      title: t("tui.command.model.cycle_recent_reverse.title"),
      value: "model.cycle_recent_reverse",
      keybind: "model_cycle_recent_reverse",
      category: "agent",
      hidden: true,
      onSelect: () => {
        local.model.cycle(-1)
      },
    },
    {
      title: t("tui.command.model.cycle_favorite.title"),
      value: "model.cycle_favorite",
      keybind: "model_cycle_favorite",
      category: "agent",
      hidden: true,
      onSelect: () => {
        local.model.cycleFavorite(1)
      },
    },
    {
      title: t("tui.command.model.cycle_favorite_reverse.title"),
      value: "model.cycle_favorite_reverse",
      keybind: "model_cycle_favorite_reverse",
      category: "agent",
      hidden: true,
      onSelect: () => {
        local.model.cycleFavorite(-1)
      },
    },
    {
      title: t("tui.command.agent.list.title"),
      value: "agent.list",
      keybind: "agent_list",
      category: "agent",
      slash: {
        name: "agents",
      },
      onSelect: () => {
        dialog.replace(() => <DialogAgent />)
      },
    },
    {
      title: local.neverAsk.current()
        ? t("tui.command.never_ask.title_on")
        : t("tui.command.never_ask.title_off"),
      value: "question.never_ask.toggle",
      category: "agent",
      slash: {
        name: "never-ask",
      },
      onSelect: () => {
        const next = !local.neverAsk.current()
        local.neverAsk.set(next)
        toast.show({
          variant: next ? "warning" : "info",
          message: next ? t("tui.command.never_ask.toast_on") : t("tui.command.never_ask.toast_off"),
          duration: 4000,
        })
      },
    },
    {
      title: t("tui.command.mcp.list.title"),
      value: "mcp.list",
      category: "agent",
      slash: {
        name: "mcps",
      },
      onSelect: () => {
        dialog.replace(() => <DialogMcp />)
      },
    },
    {
      title: t("tui.command.agent.cycle.title"),
      value: "agent.cycle",
      keybind: "agent_cycle",
      category: "agent",
      hidden: true,
      onSelect: () => {
        local.agent.move(1)
      },
    },
    {
      title: t("tui.command.variant.cycle.title"),
      value: "variant.cycle",
      keybind: "variant_cycle",
      category: "agent",
      onSelect: () => {
        local.model.variant.cycle()
      },
    },
    {
      title: t("tui.command.variant.list.title"),
      value: "variant.list",
      keybind: "variant_list",
      category: "agent",
      hidden: local.model.variant.list().length === 0,
      slash: {
        name: "variants",
      },
      onSelect: () => {
        dialog.replace(() => <DialogVariant />)
      },
    },
    {
      title: t("tui.command.agent.cycle.reverse.title"),
      value: "agent.cycle.reverse",
      keybind: "agent_cycle_reverse",
      category: "agent",
      hidden: true,
      onSelect: () => {
        local.agent.move(-1)
      },
    },
    {
      title: t("tui.command.provider.login.title"),
      value: "provider.login",
      slash: {
        name: "login",
      },
      onSelect: () => {
        dialog.replace(() => <DialogMimoLogin />)
      },
      category: "provider",
    },
    {
      title: t("tui.command.provider.connect.title"),
      value: "provider.connect",
      suggested: !connected(),
      slash: {
        name: "connect",
      },
      onSelect: () => {
        dialog.replace(() => <DialogMimoLogin />)
      },
      category: "provider",
    },
    {
      title: t("tui.command.provider.logout.title"),
      value: "provider.logout",
      slash: {
        name: "logout",
      },
      onSelect: async () => {
        await sdk.client.auth.remove({ providerID: "xiaomi" })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        toast.show({ message: t("tui.command.logout.toast"), variant: "info" })
        dialog.clear()
      },
      category: "provider",
    },
    ...(sync.data.console_state.switchableOrgCount > 1
      ? [
          {
            title: t("tui.command.console.org.switch.title"),
            value: "console.org.switch",
            suggested: Boolean(sync.data.console_state.activeOrgName),
            slash: {
              name: "org",
              aliases: ["orgs", "switch-org"],
            },
            onSelect: () => {
              dialog.replace(() => <DialogConsoleOrg />)
            },
            category: "provider",
          },
        ]
      : []),
    {
      title: t("tui.command.opencode.status.title"),
      keybind: "status_view",
      value: "opencode.status",
      slash: {
        name: "status",
      },
      onSelect: () => {
        dialog.replace(() => <DialogStatus />)
      },
      category: "system",
    },
    {
      title: t("tui.command.worktree.list.title"),
      value: "worktree.list",
      slash: {
        name: "worktree",
        aliases: ["wt"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogWorktree />)
      },
      category: "system",
    },
    {
      title: t("tui.command.theme.switch.title"),
      value: "theme.switch",
      keybind: "theme_list",
      slash: {
        name: "themes",
      },
      onSelect: () => {
        dialog.replace(() => <DialogThemeList />)
      },
      category: "system",
    },
    {
      title: t("tui.command.image.switch.title"),
      value: "background.switch",
      slash: {
        name: "background",
      },
      onSelect: () => {
        dialog.replace(() => <DialogImageList />)
      },
      category: "system",
    },
    {
      title: t("tui.command.logo.switch.title"),
      value: "logo.switch",
      slash: {
        name: "logo",
      },
      onSelect: () => {
        dialog.replace(() => <DialogLogoDesign />)
      },
      category: "system",
    },
    {
      title: t("tui.command.theme.switch_mode.to_dark"),
      value: "theme.switch_mode.dark",
      slash: {
        name: "dark",
      },
      onSelect: (dialog) => {
        setMode("dark")
        dialog.clear()
      },
      category: "system",
    },
    {
      title: t("tui.command.theme.switch_mode.to_light"),
      value: "theme.switch_mode.light",
      slash: {
        name: "light",
      },
      onSelect: (dialog) => {
        setMode("light")
        dialog.clear()
      },
      category: "system",
    },
    {
      title: t(locked() ? "tui.command.theme.mode.unlock" : "tui.command.theme.mode.lock"),
      value: "theme.mode.lock",
      onSelect: (dialog) => {
        if (locked()) unlock()
        else lock()
        dialog.clear()
      },
      category: "system",
    },
    {
      title: t("tui.command.help.show.title"),
      value: "help.show",
      slash: {
        name: "help",
      },
      onSelect: () => {
        dialog.replace(() => <DialogHelp />)
      },
      category: "system",
    },
    {
      title: t("tui.command.docs.open.title"),
      value: "docs.open",
      slash: {
        name: "doc",
        aliases: ["docs"],
      },
      onSelect: () => {
        open("https://mimo.xiaomi.com/coder/docs").catch(() => {})
        dialog.clear()
      },
      category: "system",
    },
    {
      title: t("tui.command.app.exit.title"),
      value: "app.exit",
      slash: {
        name: "exit",
        aliases: ["quit", "q"],
      },
      onSelect: () => exit(),
      category: "system",
    },
    {
      title: t("tui.command.app.debug.title"),
      category: "system",
      value: "app.debug",
      onSelect: (dialog) => {
        renderer.toggleDebugOverlay()
        dialog.clear()
      },
    },
    {
      title: t("tui.command.app.console.title"),
      category: "system",
      value: "app.console",
      onSelect: (dialog) => {
        renderer.console.toggle()
        dialog.clear()
      },
    },
    {
      title: t("tui.command.app.heap_snapshot.title"),
      category: "system",
      value: "app.heap_snapshot",
      onSelect: async (dialog) => {
        const files = await props.onSnapshot?.()
        toast.show({
          variant: "info",
          message: `Heap snapshot written to ${files?.join(", ")}`,
          duration: 5000,
        })
        dialog.clear()
      },
    },
    {
      title: t("tui.command.terminal.suspend.title"),
      value: "terminal.suspend",
      keybind: "terminal_suspend",
      category: "system",
      hidden: true,
      enabled: tuiConfig.keybinds?.terminal_suspend !== "none",
      onSelect: () => {
        process.once("SIGCONT", () => {
          renderer.resume()
        })

        renderer.suspend()
        // pid=0 means send the signal to all processes in the process group
        process.kill(0, "SIGTSTP")
      },
    },
    {
      title: t(terminalTitleEnabled() ? "tui.command.terminal.title.disable" : "tui.command.terminal.title.enable"),
      value: "terminal.title.toggle",
      keybind: "terminal_title_toggle",
      category: "system",
      onSelect: (dialog) => {
        setTerminalTitleEnabled((prev) => {
          const next = !prev
          kv.set("terminal_title_enabled", next)
          if (!next) renderer.setTerminalTitle("")
          return next
        })
        dialog.clear()
      },
    },
    {
      title: t(
        kv.get("animations_enabled", true)
          ? "tui.command.app.toggle.animations.disable"
          : "tui.command.app.toggle.animations.enable",
      ),
      value: "app.toggle.animations",
      category: "system",
      onSelect: (dialog) => {
        kv.set("animations_enabled", !kv.get("animations_enabled", true))
        dialog.clear()
      },
    },
    {
      title: t(
        kv.get("diff_wrap_mode", "word") === "word"
          ? "tui.command.app.toggle.diffwrap.disable"
          : "tui.command.app.toggle.diffwrap.enable",
      ),
      value: "app.toggle.diffwrap",
      category: "system",
      onSelect: (dialog) => {
        const current = kv.get("diff_wrap_mode", "word")
        kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
        dialog.clear()
      },
    },
    {
      title: t("tui.command.language.switch.title"),
      description: t("tui.command.language.switch.description"),
      value: "language.switch",
      slash: {
        name: "language",
        aliases: ["lang"],
      },
      category: "system",
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogSelect<Locale | "auto">
            title={t("tui.command.language.dialog.title")}
            current={lang.preference()}
            options={(["auto", ...LOCALES] as const).map((locale) => ({
              value: locale,
              title: locale === "auto" ? t("tui.language.auto") : lang.label(locale as Locale),
              description: locale === lang.preference() ? t("tui.language.current") : undefined,
              onSelect: (ctx) => {
                lang.setLocale(locale as Locale | "auto")
                ctx.clear()
              },
            }))}
          />
        ))
      },
    },
  ])

  event.on(TuiEvent.CommandExecute.type, (evt) => {
    command.trigger(evt.properties.command)
  })

  event.on(TuiEvent.ToastShow.type, (evt) => {
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on(TuiEvent.InstructionsLoaded.type, (evt) => {
    toast.show({
      message: t("tui.toast.instructions_loaded", { files: evt.properties.files.join(", ") }),
      variant: "info",
    })
  })

  event.on(TuiEvent.SessionSelect.type, (evt) => {
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt) => {
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  event.on("installation.update-available", async (evt) => {
    const version = evt.properties.version

    const skipped = kv.get("skipped_version")
    if (skipped && !semver.gt(version, skipped)) return

    const choice = await DialogConfirm.show(
      dialog,
      t("tui.toast.update_available.title"),
      t("tui.toast.update_available.confirm", { version }),
      "skip",
    )

    if (choice === false) {
      kv.set("skipped_version", version)
      return
    }

    if (choice !== true) return

    toast.show({
      variant: "info",
      message: t("tui.toast.update_available.updating", { version }),
      duration: 30000,
    })

    const result = await sdk.client.global.upgrade({ target: version })

    if (result.error || !result.data?.success) {
      toast.show({
        variant: "error",
        title: t("tui.toast.update_available.title"),
        message: t("tui.toast.update_available.failed"),
        duration: 10000,
      })
      return
    }

    await DialogAlert.show(
      dialog,
      t("tui.toast.update_available.title"),
      t("tui.toast.update_available.success", { version: result.data.version }),
    )

    void exit()
  })

  event.on("installation.updated", (evt) => {
    toast.show({
      variant: "success",
      title: t("tui.toast.updated.title"),
      message: t("tui.toast.updated.message", { version: evt.properties.version }),
      duration: 10000,
    })
  })

  // Handle interactive bash commands: suspend TUI, let user interact directly in terminal
  event.subscribe((evt) => {
    if ((evt.type as string) !== "bash.interactive.asked") return
    const props = evt.properties as Record<string, unknown>
    const id = typeof props.id === "string" ? props.id : undefined
    const command = typeof props.command === "string" ? props.command : undefined
    const cwd = typeof props.cwd === "string" ? props.cwd : undefined
    const description = typeof props.description === "string" ? props.description : "(interactive)"
    const env = props.env && typeof props.env === "object" ? (props.env as Record<string, string>) : undefined
    if (!id || !command || !cwd) return

    const abort = new AbortController()
    void (async () => {
      renderer.suspend()
      renderer.currentRenderBuffer.clear()
      let exitCode = 1
      let output = ""
      try {
        const shell = process.platform === "win32" ? "cmd" : "sh"
        const args = process.platform === "win32" ? ["/c", command] : ["-c", command]
        process.stdout.write(`\x1b[2J\x1b[H`) // clear screen
        process.stdout.write(`\x1b[1m[Interactive] ${description}\x1b[0m\n`)
        process.stdout.write(`\x1b[2m$ ${command}\x1b[0m\n\n`)
        const proc = Process.spawn([shell, ...args], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          cwd,
          env: env ?? undefined,
          abort: abort.signal,
        })
        exitCode = await proc.exited
        output = `(interactive command completed with exit code ${exitCode})`
      } catch (err: any) {
        output = `(interactive command failed: ${err?.message ?? "unknown error"})`
      } finally {
        renderer.currentRenderBuffer.clear()
        renderer.resume()
        renderer.requestRender()
      }

      // Send result back to the server — if this fails, agent hangs forever, so retry once
      const url = `${sdk.url}/bash-interactive/${id}/reply`
      const body = JSON.stringify({ output, exitCode })
      const doReply = () =>
        (sdk.fetch ?? fetch)(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      try {
        const res = await doReply()
        if (!res.ok) throw new Error(`reply failed: ${res.status}`)
      } catch {
        // Retry once after a short delay
        await new Promise((r) => setTimeout(r, 500))
        try {
          await doReply()
        } catch (retryErr: any) {
          toast.show({
            variant: "error",
            message: `Interactive command reply failed: ${retryErr?.message ?? "unknown"}`,
          })
        }
      }
    })()
  })

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "plugin") return
    const render = routeView(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={plainTerminal ? undefined : theme.background}
      onMouseDown={(evt) => {
        if (evt.button !== MouseButton.RIGHT) return

        // When copy-on-mousedown is enabled, prefer copying an active selection;
        // fall through to paste when there is nothing selected.
        if (
          Flag.MIMOCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT &&
          Selection.copy(renderer, toast, t("tui.toast.copied_to_clipboard"))
        ) {
          evt.preventDefault()
          evt.stopPropagation()
          return
        }

        promptRef.current?.paste()
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={
        Flag.MIMOCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
          ? undefined
          : () => Selection.copy(renderer, toast, t("tui.toast.copied_to_clipboard"))
      }
    >
      <Show when={Flag.MIMOCODE_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <Show when={ready()}>
        <Switch>
          <Match when={route.data.type === "home"}>
            <Home />
          </Match>
          <Match when={route.data.type === "session"}>
            <Session />
          </Match>
        </Switch>
      </Show>
      {plugin()}
      <TuiPluginRuntime.Slot name="app" />
      <StartupLoading ready={ready} />
    </box>
  )
}
