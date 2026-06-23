import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { useCurrentAgentID, useRoute, useRouteData } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA, MouseEvent } from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type {
  AssistantMessage,
  Part,
  Provider,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@mimo-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util"
import type { Tool } from "@/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { BashTool } from "@/tool/bash"
import type { GlobTool } from "@/tool/glob"
import type { GrepTool } from "@/tool/grep"
import type { EditTool } from "@/tool/edit"
import type { ApplyPatchTool } from "@/tool/apply_patch"
import type { WebFetchTool } from "@/tool/webfetch"
import type { CodeSearchTool } from "@/tool/codesearch"
import type { WebSearchTool } from "@/tool/websearch"
import type { ActorTool } from "@/tool/actor"
import type { TaskTool } from "@/tool/task"
import type { QuestionTool } from "@/tool/question"
import type { SkillTool } from "@/tool/skill"
import type { WorkflowTool } from "@/tool/workflow"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useLanguage } from "@tui/context/language"
import type { DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { useDialog } from "../../ui/dialog"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { SubagentFooter } from "./subagent-footer.tsx"
import { DialogSubagent } from "./dialog-subagent.tsx"
import { Flag } from "@/flag/flag"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsers from "../../../../../../parsers-config.ts"
import * as Clipboard from "../../util/clipboard"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import * as Editor from "../../util/editor"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { Filesystem } from "@/util"
import { Global } from "@/global"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { UI } from "@/cli/ui.ts"
import { useTuiConfig } from "../../context/tui-config"
import { getScrollAcceleration } from "../../util/scroll"
import { nextThinkingMode, reasoningSummary, useThinkingMode, type ThinkingMode } from "../../context/thinking"
import { TuiPluginRuntime } from "../../plugin"
import { DialogGoUpsell } from "../../component/dialog-go-upsell"
import { DialogTokenPlan } from "../../component/dialog-token-plan"
import { SessionRetry } from "@/session/retry"
import { getRevertDiffFiles } from "../../util/revert-diff"

addDefaultParsers(parsers.parsers)

const GO_UPSELL_LAST_SEEN_AT = "go_upsell_last_seen_at"
const GO_UPSELL_DONT_SHOW = "go_upsell_dont_show"
const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs

const QUEUE_TOKEN_PLAN_LAST_SEEN_AT = "queue_token_plan_last_seen_at"
const QUEUE_TOKEN_PLAN_WINDOW = 86_400_000 // 24 hrs

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export function Session() {
  const route = useRouteData("session")
  const fullRoute = useRoute()
  const navigate = fullRoute.navigate
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const currentAgentID = useCurrentAgentID()
  const actors = createMemo(() => sync.data.actor[route.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[route.sessionID]?.[currentAgentID()] ?? [])
  const permissions = createMemo(() => sync.data.permission[route.sessionID] ?? [])
  const questions = createMemo(() => sync.data.question[route.sessionID] ?? [])
  const visible = createMemo(
    () =>
      !session()?.parentID &&
      currentAgentID() === "main" &&
      permissions().length === 0 &&
      questions().length === 0,
  )
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0)

  const pending = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed)?.id
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [scrolling, setScrolling] = createSignal(false)
  let scrollHideTimer: ReturnType<typeof setTimeout> | undefined
  const scrollbarVisible = createMemo(() => showScrollbar() || scrolling())
  const onWheel = (evt: MouseEvent) => {
    if (evt.type !== "scroll") return
    setScrolling(true)
    if (scrollHideTimer) clearTimeout(scrollHideTimer)
    scrollHideTimer = setTimeout(() => setScrolling(false), 1000)
  }
  onCleanup(() => {
    if (scrollHideTimer) clearTimeout(scrollHideTimer)
  })
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (currentAgentID() !== "main") return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()

  createEffect(async () => {
    const previousWorkspace = project.workspace.current()
    const result = await sdk.client.session.get({ sessionID: route.sessionID }, { throwOnError: true })
    if (!result.data) {
      toast.show({
        message: `Session not found: ${route.sessionID}`,
        variant: "error",
      })
      navigate({ type: "home" })
      return
    }

    if (result.data.workspaceID !== previousWorkspace) {
      project.workspace.set(result.data.workspaceID)

      // Sync all the data for this workspace. Note that this
      // workspace may not exist anymore which is why this is not
      // fatal. If it doesn't we still want to show the session
      // (which will be non-interactive)
      try {
        await sync.bootstrap({ fatal: false })
      } catch (e) {}
    }
    await sync.session.sync(route.sessionID)
    if (scroll) scroll.scrollBy(100_000)
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit" && part.state.metadata?.switched) {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const keybind = useKeybind()
  const dialog = useDialog()
  const renderer = useRenderer()

  event.on("session.status", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    if (evt.properties.status.type !== "retry") return
    if (evt.properties.status.message !== SessionRetry.GO_UPSELL_MESSAGE) return
    if (dialog.stack.length > 0) return

    const seen = kv.get(GO_UPSELL_LAST_SEEN_AT)
    if (typeof seen === "number" && Date.now() - seen < GO_UPSELL_WINDOW) return

    if (kv.get(GO_UPSELL_DONT_SHOW)) return

    void DialogGoUpsell.show(dialog).then((dontShowAgain) => {
      if (dontShowAgain) kv.set(GO_UPSELL_DONT_SHOW, true)
      kv.set(GO_UPSELL_LAST_SEEN_AT, Date.now())
    })
  })

  // Allow exit when in child session (prompt is hidden)
  const exit = useExit()

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    const pad = (text: string) => text.padEnd(10, " ")
    const weak = (text: string) => UI.Style.TEXT_DIM + pad(text) + UI.Style.TEXT_NORMAL
    const logo = UI.logo("  ").split(/\r?\n/)
    return exit.message.set(
      [
        ...logo,
        ``,
        `  ${weak("Session")}${UI.Style.TEXT_NORMAL_BOLD}${title}${UI.Style.TEXT_NORMAL}`,
        `  ${weak("Continue")}${UI.Style.TEXT_NORMAL_BOLD}mimo -s ${session()?.id}${UI.Style.TEXT_NORMAL}`,
        ``,
      ].join("\n"),
    )
  })

  useKeyboard((evt) => {
    if (!session()?.parentID && currentAgentID() === "main") return
    if (keybind.match("app_exit", evt)) {
      const status = sync.data.session_status?.[route.sessionID]
      if (status && status.type !== "idle") {
        void sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        return
      }
      void exit()
    }
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()

  // Free "mimo-auto" channel: on a rate-limit / queue ("too many requests"),
  // nudge the user toward a Token Plan — at most once per 24h.
  event.on("session.status", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    if (evt.properties.status.type !== "retry") return
    if (!SessionRetry.isRateLimitMessage(evt.properties.status.message)) return
    const model = local.model.current()
    if (!model || model.providerID !== "mimo" || model.modelID !== "mimo-auto") return
    if (dialog.stack.length > 0) return

    const seen = kv.get(QUEUE_TOKEN_PLAN_LAST_SEEN_AT)
    if (typeof seen === "number" && Date.now() - seen < QUEUE_TOKEN_PLAN_WINDOW) return

    kv.set(QUEUE_TOKEN_PLAN_LAST_SEEN_AT, Date.now())
    void DialogTokenPlan.show(dialog)
  })

  function moveFirstChild() {
    const list = actors().filter((a) => a.mode === "subagent")
    if (list.length === 0) {
      dialog.replace(() => <DialogSubagent sessionID={route.sessionID} />)
      return
    }
    if (fullRoute.data.type !== "session") return
    navigate({ ...fullRoute.data, agentID: list[0].actor_id })
  }

  function moveChild(direction: 1 | -1) {
    const list = actors().filter((a) => a.mode === "subagent")
    if (list.length === 0) return
    if (fullRoute.data.type !== "session") return
    const cur = currentAgentID()
    const idx = list.findIndex((a) => a.actor_id === cur)
    const next =
      idx === -1
        ? direction === 1
          ? 0
          : list.length - 1
        : (idx + direction + list.length) % list.length
    navigate({ ...fullRoute.data, agentID: list[next].actor_id })
  }

  const command = useCommandDialog()
  const t = useLanguage().t
  command.register(() => [
    {
      title: t(session()?.share?.url ? "tui.command.session.share.copy_link" : "tui.command.session.share.title"),
      value: "session.share",
      suggested: route.type === "session",
      keybind: "session_share",
      category: "session",
      enabled: sync.data.config.share !== "disabled",
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        const copy = (url: string) =>
          Clipboard.copy(url)
            .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
            .catch(() => toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }))
        const url = session()?.share?.url
        if (url) {
          await copy(url)
          dialog.clear()
          return
        }
        if (!kv.get("share_consent", false)) {
          const ok = await DialogConfirm.show(dialog, "Share Session", "Are you sure you want to share it?")
          if (ok !== true) return
          kv.set("share_consent", true)
        }
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) => copy(res.data!.share!.url))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to share session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.rename.title"),
      value: "session.rename",
      keybind: "session_rename",
      category: "session",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: t("tui.command.session.timeline.title"),
      value: "session.timeline",
      keybind: "session_timeline",
      category: "session",
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: t("tui.command.session.fork.title"),
      value: "session.fork",
      keybind: "session_fork",
      category: "session",
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: t("tui.command.session.compact.title"),
      value: "session.compact",
      keybind: "session_compact",
      category: "session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.unshare.title"),
      value: "session.unshare",
      keybind: "session_unshare",
      category: "session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to unshare session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.undo.title"),
      value: "session.undo",
      keybind: "messages_undo",
      category: "session",
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt?.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.redo.title"),
      value: "session.redo",
      keybind: "messages_redo",
      category: "session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt?.set({ input: "", parts: [] })
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: t(sidebarVisible() ? "tui.command.session.sidebar.hide" : "tui.command.session.sidebar.show"),
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "session",
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: t(conceal() ? "tui.command.session.conceal.disable" : "tui.command.session.conceal.enable"),
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal",
      category: "session",
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: t(showTimestamps() ? "tui.command.session.timestamps.hide" : "tui.command.session.timestamps.show"),
      value: "session.toggle.timestamps",
      category: "session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: t(
        nextThinkingMode(thinkingMode()) === "hide"
          ? "tui.command.session.thinking.collapse"
          : "tui.command.session.thinking.expand",
      ),
      value: "session.toggle.thinking",
      keybind: "display_thinking",
      category: "session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        thinking.set(nextThinkingMode(thinkingMode()))
        dialog.clear()
      },
    },
    {
      title: t(showDetails() ? "tui.command.session.tool_details.hide" : "tui.command.session.tool_details.show"),
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "session",
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.scrollbar.toggle"),
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "session",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: t(
        showGenericToolOutput()
          ? "tui.command.session.generic_tool_output.hide"
          : "tui.command.session.generic_tool_output.show",
      ),
      value: "session.toggle.generic_tool_output",
      category: "session",
      onSelect: (dialog) => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.page_up.title"),
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.page_down.title"),
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.line_up.title"),
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.line_down.title"),
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.half_page_up.title"),
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.half_page_down.title"),
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.first.title"),
      value: "session.first",
      keybind: "messages_first",
      category: "session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.last.title"),
      value: "session.last",
      keybind: "messages_last",
      category: "session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.last_user.title"),
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "session",
      hidden: true,
      onSelect: () => {
        const msgs = messages()
        if (!msgs || !msgs.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = msgs.length - 1; i >= 0; i--) {
          const message = msgs[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: t("tui.command.session.message_next.title"),
      value: "session.message.next",
      keybind: "messages_next",
      category: "session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: t("tui.command.session.message_previous.title"),
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: t("tui.command.messages.copy.title"),
      value: "messages.copy",
      keybind: "messages_copy",
      category: "session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.copy.title"),
      value: "session.copy",
      category: "session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.export.title"),
      value: "session.export",
      keybind: "session_export",
      category: "session",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Filesystem.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Filesystem.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.child_first.title"),
      value: "session.child.first",
      keybind: "session_child_first",
      category: "session",
      hidden: true,
      onSelect: (dialog) => {
        moveFirstChild()
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.parent.title"),
      value: "session.parent",
      keybind: "session_parent",
      category: "session",
      hidden: true,
      enabled: currentAgentID() !== "main" || !!session()?.parentID,
      onSelect: (dialog) => {
        if (fullRoute.data.type === "session" && currentAgentID() !== "main") {
          navigate({ ...fullRoute.data, agentID: undefined })
          dialog.clear()
          return
        }
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.child_next.title"),
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "session",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(1)
        dialog.clear()
      },
    },
    {
      title: t("tui.command.session.child_previous.title"),
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "session",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(-1)
        dialog.clear()
      },
    },
  ])

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: route.sessionID,
        conceal,
        thinkingMode,
        showThinking,
        showTimestamps,
        showDetails,
        showGenericToolOutput,
        diffWrapMode,
        providers,
        sync,
        tui: tuiConfig,
      }}
    >
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} onMouse={onWheel}>
          <Show when={session()}>
            <scrollbox
              ref={(r) => (scroll = r)}
              viewportOptions={{
                paddingRight: 1,
              }}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: true,
                trackOptions: {
                  backgroundColor: scrollbarVisible() ? theme.backgroundElement : theme.background,
                  foregroundColor: scrollbarVisible() ? theme.border : theme.background,
                },
              }}
              stickyScroll={true}
              stickyStart="bottom"
              flexGrow={1}
              scrollAcceleration={scrollAcceleration()}
            >
              <box height={1} />
              <For each={messages()}>
                {(message, index) => (
                  <Switch>
                    <Match when={message.id === revert()?.messageID}>
                      {(function () {
                        const command = useCommandDialog()
                        const [hover, setHover] = createSignal(false)
                        const dialog = useDialog()

                        const handleUnrevert = async () => {
                          const confirmed = await DialogConfirm.show(
                            dialog,
                            "Confirm Redo",
                            "Are you sure you want to restore the reverted messages?",
                          )
                          if (confirmed) {
                            command.trigger("session.redo")
                          }
                        }

                        return (
                          <box
                            onMouseOver={() => setHover(true)}
                            onMouseOut={() => setHover(false)}
                            onMouseUp={handleUnrevert}
                            marginTop={1}
                            flexShrink={0}
                            border={["left"]}
                            customBorderChars={SplitBorder.customBorderChars}
                            borderColor={theme.backgroundPanel}
                          >
                            <box
                              paddingTop={1}
                              paddingBottom={1}
                              paddingLeft={2}
                              backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                            >
                              <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                              <text fg={theme.textMuted}>
                                <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to
                                restore
                              </text>
                              <Show when={revert()!.diffFiles?.length}>
                                <box marginTop={1}>
                                  <For each={revert()!.diffFiles}>
                                    {(file) => (
                                      <text fg={theme.text}>
                                        {file.filename}
                                        <Show when={file.additions > 0}>
                                          <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                        </Show>
                                        <Show when={file.deletions > 0}>
                                          <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                        </Show>
                                      </text>
                                    )}
                                  </For>
                                </box>
                              </Show>
                            </box>
                          </box>
                        )
                      })()}
                    </Match>
                    <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
                      <></>
                    </Match>
                    <Match when={message.role === "user"}>
                      <UserMessage
                        index={index()}
                        onMouseUp={() => {
                          if (renderer.getSelection()?.getSelectedText()) return
                          dialog.replace(() => (
                            <DialogMessage
                              messageID={message.id}
                              sessionID={route.sessionID}
                              setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                            />
                          ))
                        }}
                        message={message as UserMessage}
                        parts={sync.data.part[message.id] ?? []}
                        pending={pending()}
                      />
                    </Match>
                    <Match when={message.role === "assistant"}>
                      <AssistantMessage
                        last={lastAssistant()?.id === message.id}
                        message={message as AssistantMessage}
                        parts={sync.data.part[message.id] ?? []}
                      />
                    </Match>
                  </Switch>
                )}
              </For>
            </scrollbox>
            <box flexShrink={0}>
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
              </Show>
              <Show when={session()?.parentID || currentAgentID() !== "main"}>
                <SubagentFooter />
              </Show>
              <Show when={visible()}>
                <TuiPluginRuntime.Slot
                  name="session_prompt"
                  mode="replace"
                  session_id={route.sessionID}
                  visible={visible()}
                  disabled={disabled()}
                  on_submit={toBottom}
                  ref={bind}
                >
                  <Prompt
                    visible={visible()}
                    ref={bind}
                    disabled={disabled()}
                    onSubmit={() => {
                      toBottom()
                    }}
                    sessionID={route.sessionID}
                    right={<TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                  />
                </TuiPluginRuntime.Slot>
              </Show>
            </box>
          </Show>
          <Toast />
        </box>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} />
              </box>
            </Match>
          </Switch>
        </Show>
      </box>
    </context.Provider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0])
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()?.text}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    })
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const toast = useToast()
  const renderer = useRenderer()
  const t = useLanguage().t
  const [copyHover, setCopyHover] = createSignal(false)
  const messages = createMemo(() => sync.data.message[props.message.sessionID]?.[props.message.agentID ?? "main"] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const final = createMemo(() => {
    return props.message.finish && props.message.finish !== "tool-calls"
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })

  const keybind = useKeybind()

  const handleCopy = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    const text = props.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as TextPart).text)
      .join("\n")
      .trim()
    if (!text) return
    Clipboard.copy(text)
      .then(() => toast.show({ message: t("tui.toast.copied_to_clipboard"), variant: "success" }))
      .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
  }

  // Goal judge verdict for this specific turn, if the stop-condition judge
  // evaluated it. Rendered as a foldable per-turn marker so the user can trace
  // back which turn failed the check — without polluting the message stream.
  const verdict = createMemo(() => sync.data.session_goal?.[props.message.sessionID]?.verdicts?.[props.message.id])
  const [verdictOpen, setVerdictOpen] = createSignal(false)
  const verdictMark = createMemo(() => {
    const v = verdict()
    if (!v) return undefined
    if (v.error) return { icon: "!", fg: theme.textMuted, label: "Judge: error (stopped)" }
    if (v.ok) return { icon: "✓", fg: theme.success, label: "Judge: met" }
    if (v.impossible) return { icon: "⊘", fg: theme.error, label: "Judge: impossible" }
    return { icon: "⟳", fg: theme.warning, label: `Judge [round ${v.attempt}]: not met` }
  })

  return (
    <>
      <For each={props.parts}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === props.parts.length - 1}
                component={component()}
                part={part as any}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <Show when={props.parts.some((x) => x.type === "tool" && x.tool === "actor")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {keybind.print("session_child_first")}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <ErrorBlock error={props.message.error!} />
      </Show>
      <Switch>
        <Match when={props.last || final() || props.message.error?.name === "MessageAbortedError"}>
          <box paddingLeft={3} flexDirection="row" justifyContent="space-between" marginTop={1}>
            <text>
              <span
                style={{
                  fg:
                    props.message.error?.name === "MessageAbortedError"
                      ? theme.textMuted
                      : local.agent.color(props.message.agent),
                }}
              >
                ▣{" "}
              </span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
              <span style={{ fg: theme.textMuted }}> · {model()}</span>
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
              </Show>
              <Show when={props.message.error?.name === "MessageAbortedError"}>
                <span style={{ fg: theme.textMuted }}> · interrupted</span>
              </Show>
            </text>
            <Show when={props.message.time.completed}>
              <box
                onMouseOver={() => setCopyHover(true)}
                onMouseOut={() => setCopyHover(false)}
                onMouseUp={handleCopy}
              >
                <text fg={copyHover() ? theme.text : theme.textMuted}>⎘ copy</text>
              </box>
            </Show>
          </box>
        </Match>
      </Switch>
      <Show when={verdictMark()}>
        {(mark) => (
          <box paddingLeft={3} onMouseUp={() => setVerdictOpen((x) => !x)}>
            <text>
              <span style={{ fg: theme.textMuted }}>{verdictOpen() ? "▼" : "▶"} </span>
              <span style={{ fg: mark().fg }}>
                {mark().icon} {mark().label}
              </span>
            </text>
            <Show when={verdictOpen()}>
              <box paddingLeft={2}>
                <text fg={theme.textMuted} wrapMode="word">
                  {verdict()!.reason}
                </text>
              </box>
            </Show>
          </box>
        )}
      </Show>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

type MessageError = NonNullable<AssistantMessage["error"]>

function errorBody(error: MessageError): string {
  if (error.name === "MessageOutputLengthError") return "Output length limit reached"
  return (error.data as { message?: string }).message ?? "Unknown error"
}

function errorMeta(error: MessageError): string | undefined {
  if (error.name === "APIError") {
    const parts: string[] = []
    if (error.data.statusCode !== undefined) parts.push(`status ${error.data.statusCode}`)
    parts.push(error.data.isRetryable ? "retryable" : "non-retryable")
    return parts.join(" · ")
  }
  if (error.name === "ProviderAuthError") return `provider: ${error.data.providerID}`
  if (error.name === "StructuredOutputError") return `retries: ${error.data.retries}`
  return undefined
}

function ErrorBlock(props: { error: MessageError }) {
  const { theme } = useTheme()
  const meta = createMemo(() => errorMeta(props.error))
  return (
    <box flexDirection="column" paddingLeft={3} marginTop={1}>
      <text fg={theme.error} wrapMode="word">
        <span style={{ fg: theme.error }}>✗  </span>
        {errorBody(props.error)}
      </text>
      <Show when={meta()}>
        <box paddingLeft={3}>
          <text fg={theme.textMuted} wrapMode="word">
            {meta()}
          </text>
        </box>
      </Show>
    </box>
  )
}

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => {
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  const isDone = createMemo(() => props.part.time.end !== undefined)
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time.end
    return end === undefined ? 0 : Math.max(0, end - props.part.time.start)
  })
  const summary = createMemo(() => reasoningSummary(content()))

  const toggle = () => {
    if (!inMinimal()) return
    setExpanded((prev) => !prev)
  }

  return (
    <Show when={content()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
        <box onMouseUp={toggle}>
          <ReasoningHeader
            toggleable={inMinimal()}
            open={!inMinimal() || expanded()}
            done={isDone()}
            title={summary().title}
            duration={isDone() ? Locale.duration(duration()) : undefined}
          />
        </box>
        <Show when={(!inMinimal() || expanded()) && summary().body}>
          <box paddingLeft={inMinimal() ? 2 : 0} marginTop={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={subtleSyntax()}
              content={summary().body}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  title: string | null
  duration?: string
}) {
  const { theme } = useTheme()
  const fg = () =>
    props.open
      ? RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, theme.thinkingOpacity)
      : theme.warning

  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <Spinner color={fg()}>{props.title ? "Thinking: " + props.title : "Thinking"}</Spinner>
        </box>
      </Match>
      <Match when={true}>
        <text fg={fg()} wrapMode="none">
          <Show when={props.toggleable}>
            <span>{props.open ? "- " : "+ "}</span>
          </Show>
          <span>Thought</span>
          <Show when={props.title || props.duration}>
            <span>: </span>
          </Show>
          <Show when={props.title}>
            <span>{props.title}</span>
          </Show>
          <Show when={props.duration}>
            <span>
              {props.title ? " · " : ""}
              {props.duration}
            </span>
          </Show>
        </text>
      </Match>
    </Switch>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Switch>
          <Match when={Flag.MIMOCODE_EXPERIMENTAL_MARKDOWN}>
            <markdown
              syntaxStyle={syntax()}
              streaming={true}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.markdownText}
              bg={theme.background}
            />
          </Match>
          <Match when={!Flag.MIMOCODE_EXPERIMENTAL_MARKDOWN}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={props.part.tool === "bash"}>
          <Bash {...toolprops} />
        </Match>
        <Match when={props.part.tool === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={props.part.tool === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={props.part.tool === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={props.part.tool === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "codesearch"}>
          <CodeSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={props.part.tool === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={props.part.tool === "actor"}>
          <Task {...toolprops} />
        </Match>
        <Match when={props.part.tool === "task"}>
          <WorkItemTask {...toolprops} />
        </Match>
        <Match when={props.part.tool === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={props.part.tool === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={props.part.tool === "workflow"}>
          <Workflow {...toolprops} />
        </Match>
        <Match when={props.part.tool === "plan_exit"}>
          <PlanExit {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps<T> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}
function PlanExit(props: ToolProps<any>) {
  const { theme } = useTheme()
  const dismissed = createMemo(
    () => props.part.state.status === "completed" && props.part.state.metadata?.switched === false,
  )
  const feedback = createMemo(() => (dismissed() ? props.metadata.feedback : undefined))

  return (
    <>
      <InlineTool icon="⚙" pending="Asking..." complete={true} part={props.part} dismissed={dismissed()}>
        plan_exit
      </InlineTool>
      <Show when={feedback()}>
        <box paddingLeft={6}>
          <text fg={theme.textMuted}>{feedback()}</text>
        </box>
      </Show>
    </>
  )
}

function GenericTool(props: ToolProps<any>) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const maxLines = 3
  const overflow = createMemo(() => lines().length > maxLines)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, maxLines), "…"].join("\n")
  })

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
          {props.tool} {input(props.input)}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.tool} ${input(props.input)}`}
        part={props.part}
        onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={overflow()}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

// Inline renderer for the work-item `task` tool (distinct from <Task>, which
// renders the subagent-spawning `actor` tool). Shows the operation as a concise
// one-liner derived from the nested `{ operation: { action } }` discriminator,
// so task create/start/done don't fall through to GenericTool's raw-JSON dump.
function WorkItemTask(props: ToolProps<typeof TaskTool>) {
  const summary = createMemo(() => {
    const op = (props.input as { operation?: Record<string, any> }).operation
    if (!op || typeof op !== "object") return "task"
    const verb = typeof op.action === "string" ? op.action : "task"
    if (verb === "create") return op.summary ? `create "${op.summary}"` : "create"
    if (verb === "list") return op.status ? `list ${op.status}` : "list"
    if (op.id) return `${verb} ${op.id}`
    return verb
  })
  return (
    <InlineTool icon="#" pending="Updating tasks..." complete={true} part={props.part}>
      task {summary()}
    </InlineTool>
  )
}

// Inline renderer for the dynamic-workflow `workflow` tool. The "run" op blocks
// until terminal and streams a transcript (phase transitions + log() messages)
// into part-state metadata via ctx.metadata; the tool's `Workflow` view here
// reads metadata.transcript reactively (each ctx.metadata call fires a
// message.part.delta) and renders it as multi-line chat content alongside the
// live header from sync.data.workflow[runID]. That way phase/log events show
// up in the main agent's conversation as the workflow runs, not as a single
// silent line that only updates once the run finishes.
function Workflow(props: ToolProps<typeof WorkflowTool>) {
  const sync = useSync()

  const operation = createMemo(() => {
    const op = (props.input as { operation?: string }).operation
    return typeof op === "string" ? op : "run"
  })

  const runID = createMemo(
    () => (props.metadata.runID as string | undefined) ?? (props.input as { run_id?: string }).run_id,
  )

  const run = createMemo(() => {
    const id = runID()
    if (!id) return undefined
    return sync.data.workflow[id]
  })

  // Spinner is true while EITHER side reports running — the tool part stays
  // running until execute() returns (the whole workflow duration, since we
  // block), and the bus-fed run row independently reports "running" until the
  // workflow.finished event lands. Either signal alone is enough.
  const isRunning = createMemo(() => {
    if (props.part.state.status === "running") return true
    const r = run()
    return r?.status === "running"
  })

  const transcript = createMemo(() => {
    const t = (props.metadata as { transcript?: { kind: "phase" | "log"; text: string }[] }).transcript
    return Array.isArray(t) ? t : []
  })

  const content = createMemo(() => {
    const op = operation()
    const r = run()
    const id = runID()
    if (op !== "run") {
      return `workflow ${op}${id ? ` ${id}` : ""}`
    }
    const lines: string[] = []
    const name = r?.name ?? (props.input as { name?: string }).name ?? "inline"
    const status = r?.status ?? (props.metadata.status as string | undefined)
    const phase = r?.currentPhase
    const counters = r ? `${r.succeeded}✓ ${r.failed}✗ ${r.running}⟳` : ""
    const head = [
      `workflow ${name}`,
      status ? `· ${status}` : "",
      phase ? `· ${phase}` : "",
      counters ? `· ${counters}` : "",
    ]
      .filter(Boolean)
      .join(" ")
    lines.push(head)
    for (const e of transcript()) {
      lines.push(e.kind === "phase" ? `↳ phase: ${e.text}` : `  ${e.text}`)
    }
    return lines.join("\n")
  })

  return (
    <InlineTool icon="⚡" spinner={isRunning()} pending="Starting workflow..." complete={true} part={props.part}>
      {content()}
    </InlineTool>
  )
}

function CollapsibleError(props: { error: string; paddingLeft?: number }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)


  const lineCount = createMemo(() => props.error.split("\n").length)

  return (
    <box
      paddingLeft={props.paddingLeft}
      onMouseUp={(evt) => {
        evt.stopPropagation()
        if (renderer.getSelection()?.getSelectedText()) return
        setExpanded((prev) => !prev)
      }}
    >
      <Show
        when={expanded()}
        fallback={
          <text fg={theme.error}>
            + Error ({lineCount()} {lineCount() === 1 ? "line" : "lines"})
          </text>
        }
      >
        <text fg={theme.error}>- Error</text>
        <box paddingLeft={2}>
          <text fg={theme.error}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  spinner?: boolean
  dismissed?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (hover() && props.onClick) return theme.text
    if (props.complete) return theme.textMuted
    return theme.text
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  // Agent-recoverable failures (bad args, malformed call, unknown task/actor id)
  // are flagged on the error state. Render them muted (struck through, no red
  // block) like denials — the agent self-corrects; the user needn't be alarmed.
  const recoverable = createMemo(() => {
    const state = props.part.state
    return state.status === "error" && state.metadata?.recoverable === true
  })

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={fg()} children={props.children} />
        </Match>
        <Match when={true}>
          <text paddingLeft={3} fg={fg()} attributes={denied() || recoverable() || props.dismissed ? TextAttributes.STRIKETHROUGH : undefined}>
            <Show fallback={<>~ {props.pending}</>} when={props.complete}>
              <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
            </Show>
          </text>
        </Match>
      </Switch>
      <Show when={error() && !denied() && !recoverable()}>
        <CollapsibleError error={error()!} paddingLeft={3} />
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.spinner}
        fallback={
          <text paddingLeft={3} fg={theme.textMuted}>
            {props.title}
          </text>
        }
      >
        <Spinner color={theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
      </Show>
      {props.children}
      <Show when={error()}>
        <CollapsibleError error={error()!} />
      </Show>
    </box>
  )
}

const TOOL_COLLAPSE_MAX_LINES = 3
const TOOL_COLLAPSE_MAX_LINE_LENGTH = 120

function displayLines(content: string) {
  if (!content) return []
  return content.replace(/\n$/, "").split("\n")
}

function hasLongDisplayLine(content: string) {
  return displayLines(content).some((line) => line.length > TOOL_COLLAPSE_MAX_LINE_LENGTH)
}

function Bash(props: ToolProps<typeof BashTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          spinner={isRunning()}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.text}>$ {props.input.command}</text>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps<typeof WriteTool>) {
  const { theme, syntax } = useTheme()
  const [expanded, setExpanded] = createSignal(false)
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })
  const lineCount = createMemo(() => displayLines(code()).length)
  const collapsed = createMemo(() => lineCount() > TOOL_COLLAPSE_MAX_LINES || hasLongDisplayLine(code()))

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool
          title={"# Wrote " + normalizePath(props.input.filePath!)}
          part={props.part}
          onClick={collapsed() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <Show
            when={!collapsed() || expanded()}
            fallback={
              <text fg={theme.textMuted}>
                Click to expand ({lineCount()} {lineCount() === 1 ? "line" : "lines"})
              </text>
            }
          >
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
              <code
                conceal={false}
                fg={theme.text}
                filetype={filetype(props.input.filePath!)}
                syntaxStyle={syntax()}
                content={code()}
              />
            </line_number>
            <Show when={collapsed()}>
              <text fg={theme.textMuted}>Click to collapse</text>
            </Show>
          </Show>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write..." complete={props.input.filePath} part={props.part}>
          Write {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part}>
      Glob "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.count}>
        ({props.metadata.count} {props.metadata.count === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
  const { theme } = useTheme()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file..."
        complete={props.input.filePath}
        spinner={isRunning()}
        part={props.part}
      >
        Read {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>
        ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={props.input.url} part={props.part}>
      WebFetch {props.input.url}
    </InlineTool>
  )
}

function CodeSearch(props: ToolProps<typeof CodeSearchTool>) {
  const metadata = props.metadata as { results?: number }
  return (
    <InlineTool icon="◇" pending="Searching code..." complete={props.input.query} part={props.part}>
      Exa Code Search "{props.input.query}" <Show when={metadata.results}>({metadata.results} results)</Show>
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<typeof WebSearchTool>) {
  const metadata = props.metadata as { numResults?: number }
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={props.input.query} part={props.part}>
      Web Search "{props.input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps<typeof ActorTool>) {
  const route = useRoute()
  const sync = useSync()

  const input = createMemo(() => {
    const raw = props.input as Partial<{ operation: { description: string; subagent_type: string } } & {
      description: string
      subagent_type: string
    }>
    return (raw?.operation ?? raw) as Partial<{ description: string; subagent_type: string }>
  })

  const targetSession = createMemo(() => props.metadata.sessionId as string | undefined)
  const targetBucket = createMemo(() => (props.metadata.actorId as string | undefined) ?? "main")

  createEffect(() => {
    const session = targetSession()
    const bucket = targetBucket()
    if (session && !sync.data.message[session]?.[bucket]?.length)
      void sync.session.sync(session)
  })

  const messages = createMemo(() => sync.data.message[targetSession() ?? ""]?.[targetBucket()] ?? [])

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() =>
    tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title),
  )

  const isRunning = createMemo(() => props.part.state.status === "running")

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    if (!input().description) return ""
    let content = [`${Locale.titlecase(input().subagent_type ?? "General")} Task — ${input().description}`]

    if (isRunning() && tools().length > 0) {
      // content[0] += ` · ${tools().length} toolcalls`
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${title}`)
      } else content.push(`↳ ${tools().length} toolcalls`)
    }

    if (props.part.state.status === "completed") {
      content.push(`└ ${tools().length} toolcalls · ${Locale.duration(duration())}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon="│"
      spinner={isRunning()}
      complete={input().description}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        const session = targetSession()
        if (!session) return
        const actor = targetBucket()
        if (
          route.data.type === "session" &&
          session === route.data.sessionID &&
          actor !== "main"
        ) {
          route.navigate({ ...route.data, agentID: actor })
          return
        }
        route.navigate({ type: "session", sessionID: session, agentID: actor !== "main" ? actor : undefined })
      }}
    >
      {content()}
    </InlineTool>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.input.filePath))

  const diffContent = createMemo(() => props.metadata.diff)

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool title={"← Edit " + normalizePath(props.input.filePath!)} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </box>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={props.input.filePath} part={props.part}>
          Edit {normalizePath(props.input.filePath!)} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const [expanded, setExpanded] = createSignal<string[]>([])

  const files = createMemo(() => props.metadata.files ?? [])

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + normalizePath(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  function toggle(filePath: string) {
    setExpanded((prev) => (prev.includes(filePath) ? prev.filter((item) => item !== filePath) : [...prev, filePath]))
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => {
            const open = createMemo(() => expanded().includes(file.filePath))
            const count = createMemo(() => file.additions + file.deletions)
            const collapsed = createMemo(() => count() > TOOL_COLLAPSE_MAX_LINES || hasLongDisplayLine(file.patch))

            return (
              <BlockTool
                title={title(file)}
                part={props.part}
                onClick={file.type !== "delete" && collapsed() ? () => toggle(file.filePath) : undefined}
              >
                <Show
                  when={file.type !== "delete"}
                  fallback={
                    <text fg={theme.diffRemoved}>
                      -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                    </text>
                  }
                >
                  <Show
                    when={!collapsed() || open()}
                    fallback={
                      <text fg={theme.textMuted}>
                        Click to expand ({count()} change{count() !== 1 ? "s" : ""})
                      </text>
                    }
                  >
                    <Diff diff={file.patch} filePath={file.filePath} />
                    <Show when={collapsed()}>
                      <text fg={theme.textMuted}>Click to collapse</text>
                    </Show>
                  </Show>
                  <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
                </Show>
              </BlockTool>
            )
          }}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps<typeof SkillTool>) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={props.input.name} part={props.part}>
      Skill "{props.input.name}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics?: Record<string, Record<string, any>[]>; filePath: string }) {
  const { theme } = useTheme()
  const errors = createMemo(() => {
    const normalized = Filesystem.normalizePath(props.filePath)
    const arr = props.diagnostics?.[normalized] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use absolute
  return absolute
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
