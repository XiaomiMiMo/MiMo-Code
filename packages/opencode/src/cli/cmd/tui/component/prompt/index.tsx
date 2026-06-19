import { BoxRenderable, RGBA, TextareaRenderable, MouseEvent, PasteEvent, decodePasteBytes } from "@opentui/core"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match } from "solid-js"
import "opentui-spinner/solid"
import path from "path"
import { fileURLToPath } from "url"
import { Filesystem } from "@/util"
import { useLocal } from "@tui/context/local"
import { tint, useTheme } from "@tui/context/theme"
import { EmptyBorder, SplitBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { MessageID, PartID } from "@/session/schema"
import { createStore, produce, unwrap } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { assign } from "./part"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useLanguage } from "@tui/context/language"
import { useRenderer, type JSX } from "@opentui/solid"
import * as Editor from "@tui/util/editor"
import * as Voice from "@tui/util/voice"
import { useExit } from "../../context/exit"
import * as Clipboard from "../../util/clipboard"
import type { AssistantMessage, FilePart, UserMessage } from "@mimo-ai/sdk/v2"
import { TuiEvent } from "../../event"
import { iife } from "@/util/iife"
import { Locale } from "@/util"
import { formatDuration } from "@/util/format"
import { createColors, createFrames } from "../../ui/spinner.ts"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { createFadeIn } from "../../util/signal"
import { useTextareaKeybindings } from "../textarea-keybindings"
import { DialogSkill } from "../dialog-skill"
import { DialogWorkspaceCreate, restoreWorkspaceSession } from "../dialog-workspace-create"
import { DialogWorkspaceUnavailable } from "../dialog-workspace-unavailable"
import { DialogAgreement, FREE_AGREEMENT_KEY, FREE_MODEL_IDS } from "../dialog-agreement"
import { useArgs } from "@tui/context/args"

export type PromptProps = {
  sessionID?: string
  workspaceID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
  paste(): void
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

let stashed: { prompt: PromptInfo; cursor: number } | undefined

// Module-level voice state: survives component remounts and route changes
let activeVoice: {
  handle: Voice.StreamingHandle
  pending: number
  appendText: (text: string) => void
  setText: (text: string) => void
  getPlainText: () => string
  switchAgent: (name: string) => void
  submit: () => Promise<unknown>
  setState: (type: "listening" | "speaking" | "processing" | "finishing" | "idle") => void
  showError: (msg: string) => void
} | undefined

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef

  const keybind = useKeybind()
  const local = useLocal()
  const args = useArgs()
  const sdk = useSDK()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandDialog()
  const t = useLanguage().t
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const animationsEnabled = createMemo(() => kv.get("animations_enabled", true))
  const voiceEnabled = createMemo(() => kv.get("voice_enabled", false))
  const voiceSendEnabled = createMemo(() => kv.get("voice_send_command", false))
  const voiceControlEnabled = createMemo(() => kv.get("voice_control_enabled", false))
  const [voiceState, setVoiceState] = createSignal<"idle" | "listening" | "speaking" | "processing" | "finishing">(
    activeVoice ? (activeVoice.pending > 0 ? "processing" : "listening") : "idle",
  )
  const [voiceElapsed, setVoiceElapsed] = createSignal(0)

  let voiceTimer: ReturnType<typeof setInterval> | undefined
  let voiceSegmentStart = 0

  function voiceTimerStart() {
    voiceTimerStop()
    voiceSegmentStart = Date.now()
    voiceTimer = setInterval(() => {
      setVoiceElapsed(Math.floor((Date.now() - voiceSegmentStart) / 1000))
    }, 200)
  }
  function voiceTimerStop() {
    if (voiceTimer) {
      clearInterval(voiceTimer)
      voiceTimer = undefined
    }
    setVoiceElapsed(0)
  }

  function voiceAppendText(text: string) {
    if (!input || input.isDestroyed) return
    const current = store.prompt.input
    if (current.length > 0 && /[.?!]$/.test(current) && text.length > 0 && text[0] !== " ") {
      input.insertText(" " + text)
      setStore("prompt", "input", current + " " + text)
    } else {
      input.insertText(text)
      setStore("prompt", "input", current + text)
    }
    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  }

  function voiceSetText(text: string) {
    if (!input || input.isDestroyed) return
    input.clear()
    input.insertText(text)
    setStore("prompt", "input", text)
    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  }

  function voiceGetPlainText() {
    return store.prompt.input
  }

  function voiceSwitchAgent(name: string) {
    const match = local.agent.list().find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (match) local.agent.set(match.name)
    else toast.show({ message: t("tui.voice.error.unknown_agent", { name: name }), variant: "error", duration: 3000 })
  }

  function voiceSetState(type: "idle" | "listening" | "speaking" | "processing" | "finishing") {
    setVoiceState(type)
    if (type === "speaking") voiceTimerStart()
    if (type === "idle" || type === "listening" || type === "processing") voiceTimerStop()
  }

  // Wire module-level callbacks to current component instance
  if (activeVoice) {
    activeVoice.appendText = voiceAppendText
    activeVoice.setText = voiceSetText
    activeVoice.getPlainText = voiceGetPlainText
    activeVoice.switchAgent = voiceSwitchAgent
    activeVoice.submit = () => submit()
    activeVoice.setState = voiceSetState
    activeVoice.showError = (msg) => toast.show({ message: msg, variant: "error", duration: 3000 })
  }
  onCleanup(() => {
    voiceTimerStop()
  })

  async function voiceToggle() {
    const state = voiceState()
    if (state === "listening" || state === "speaking" || state === "processing") {
      voiceTimerStop()
      setVoiceState("finishing")
      if (activeVoice) {
        const handle = activeVoice.handle
        const av = activeVoice
        activeVoice = undefined
        await Voice.stopStreaming(handle)
        if (av.pending <= 0) setVoiceState("idle")
      }
      return
    }
    if (state === "finishing") return
    // Start streaming — only validate the active mode's provider
    const voiceConfig = sync.data.config.voice
    const resolved = Voice.resolveVoiceConfig(voiceConfig)
    const activeConfig = voiceControlEnabled() ? resolved.control : resolved.asr
    const creds = Voice.resolveCredentials(sync.data.provider, activeConfig)
    if ("error" in creds) {
      const vars = { provider: creds.providerID, model: creds.model }
      const msg = !voiceConfig ? t("tui.voice.error.no_auth")
        : creds.error === "not_found" ? t("tui.voice.error.provider_not_found", vars)
        : creds.error === "no_url" ? t("tui.voice.error.no_url", vars)
        : t("tui.voice.error.no_auth_provider", vars)
      toast.show({ message: msg, variant: "error" })
      return
    }
    if (!Voice.isAvailable()) {
      toast.show({ message: t("tui.voice.error.no_recorder"), variant: "error" })
      return
    }

    const av: NonNullable<typeof activeVoice> = {
      handle: undefined!,
      pending: 0,
      appendText: voiceAppendText,
      setText: voiceSetText,
      getPlainText: voiceGetPlainText,
      switchAgent: voiceSwitchAgent,
      submit: () => submit(),
      setState: voiceSetState,
      showError: (msg) => toast.show({ message: msg, variant: "error", duration: 3000 }),
    }

    let voiceControlChain: Promise<void> = Promise.resolve()

    const handle = Voice.startStreaming({
      onSegment: (segment) => {
        av.pending++
        av.setState("processing")

        if (voiceControlEnabled()) {
          voiceControlChain = voiceControlChain.then(async () => {
            try {
              if (!activeVoice) return
              av.setState("processing")
              const currentText = av.getPlainText()
              const currentAgent = local.agent.current()?.name ?? ""
              const availableAgents = local.agent.list().map((x) => x.name)

              const ctrl = await Voice.processVoiceControl({
                audio: segment.audio,
                apiKey: creds.apiKey,
                baseUrl: creds.baseUrl,
                model: resolved.control.model,
                currentText,
                currentAgent,
                availableAgents,
                sendEnabled: voiceSendEnabled(),
              })

              if (ctrl) {
                for (const action of ctrl.actions) {
                  if (action.action === "edit") av.setText(action.text)
                  else if (action.action === "send") {
                    if (voiceSendEnabled() && av.getPlainText().trim()) await av.submit()
                    else if (!av.getPlainText().trim()) av.showError(t("tui.voice.error.empty_send"))
                  } else if (action.action === "agent") {
                    av.switchAgent(action.agent)
                  }
                }
              } else {
                av.showError(t("tui.voice.error.network"))
              }
            } finally {
              av.pending--
              if (activeVoice === av && voiceState() !== "speaking")
                av.setState(av.pending > 0 ? "processing" : "listening")
              if (!activeVoice && av.pending <= 0) av.setState("idle")
            }
          }).catch(() => {})
        } else {
          Voice.transcribeAudio({
            audio: segment.audio,
            apiKey: creds.apiKey,
            baseUrl: creds.baseUrl,
            model: resolved.asr.model,
          }).then((text) => {
            if (text) {
              if (voiceSendEnabled() && Voice.SEND_RE.test(text.replace(/[\s。.!！？?，,]+$/g, "").trim())) {
                av.submit()
              } else {
                av.appendText(text.trim())
              }
            } else {
              av.showError(t("tui.voice.error.network"))
            }
            av.pending--
            if (activeVoice === av && voiceState() !== "speaking")
              av.setState(av.pending > 0 ? "processing" : "listening")
            if (!activeVoice && av.pending <= 0) av.setState("idle")
          }).catch(() => {
            av.pending--
            if (activeVoice === av && voiceState() !== "speaking")
              av.setState(av.pending > 0 ? "processing" : "listening")
            if (!activeVoice && av.pending <= 0) av.setState("idle")
          })
        }
      },
      onActiveChange: (active) => {
        if (active && activeVoice === av) av.setState("speaking")
      },
      onError: (err) => {
        const msg = err.message || ""
        if (msg.includes("no default audio") || msg.includes("not found") || msg.includes("Cannot open") || msg.includes("ALSA")) {
          av.showError(t("tui.voice.error.no_device"))
        } else {
          av.showError(`${t("tui.voice.error.recorder_failed")}: ${msg}`)
        }
        activeVoice = undefined
        av.setState("idle")
      },
    })
    if (!handle) {
      toast.show({ message: t("tui.voice.error.no_recorder"), variant: "error" })
      return
    }
    av.handle = handle
    activeVoice = av
    setVoiceState("listening")
  }

  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const [ghost, setGhost] = createSignal("")
  const hasRightContent = createMemo(() => Boolean(props.right))

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  const textareaKeybindings = useTextareaKeybindings()

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]?.["main"]
    if (!messages) return undefined
    return messages.findLast((m): m is UserMessage => m.role === "user")
  })

  // After the agent finishes a turn, predict the user's likely next prompt and
  // show it as ghost text in the empty input (accept with Tab). Only fires on
  // an idle transition while the input is empty so it never clobbers typing.
  let ghostRequest = 0
  async function fetchGhost(sessionID: string) {
    if (props.showPlaceholder === false) return
    const token = ++ghostRequest
    const userMessageID = lastUserMessage()?.id
    const res = await sdk.client.session.predict({ sessionID }).catch(() => undefined)
    const text = res?.data?.prediction?.trim()
    if (!text) return
    // Drop the result if anything that defined its context changed while the
    // request was in flight: superseded by a newer fetch, session switched, a
    // new run started, the conversation advanced, or the user began typing.
    if (token !== ghostRequest) return
    if (props.sessionID !== sessionID) return
    if (status().type !== "idle") return
    if (lastUserMessage()?.id !== userMessageID) return
    if (!input || input.isDestroyed || input.plainText !== "") return
    setGhost(text)
  }
  createEffect(
    on(
      () => status().type,
      (type, prev) => {
        if (type !== "idle") {
          // A new run started (or the session went non-idle): invalidate any
          // in-flight prediction and hide a stale suggestion.
          ghostRequest++
          if (ghost()) setGhost("")
          return
        }
        if (prev === "idle") return
        const sessionID = props.sessionID
        if (!sessionID || !input || input.isDestroyed || input.plainText !== "") return
        if (!lastUserMessage()) return
        fetchGhost(sessionID)
      },
    ),
  )
  // While a ghost suggestion is showing, suspend global command keybinds so Tab
  // reaches the textarea's onKeyDown (where we accept it) instead of being
  // consumed by the agent-cycle keybind. Global keyboard handlers run before
  // renderable handlers, so without this the suggestion can never be accepted.
  // The cleanup resumes keybinds on any dismissal (typing, accept, submit,
  // session change, status leaving idle).
  createEffect(() => {
    if (!ghost()) return
    command.keybinds(false)
    onCleanup(() => command.keybinds(true))
  })

  const usage = createMemo(() => {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID]?.["main"] ?? []
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = msg.reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)
    return {
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setGhost("")
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return

      syncedSessionID = sessionID

      // Only set agent if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
      if (msg.agent && isPrimaryAgent) {
        // Keep command line --agent if specified.
        if (!args.agent) local.agent.set(msg.agent)
        if (msg.model) {
          local.model.set(msg.model)
          local.model.variant.set(msg.model.variant)
        }
      }
    }
  })

  command.register(() => {
    return [
      {
        title: t("tui.command.prompt.clear.title"),
        value: "prompt.clear",
        category: "prompt",
        hidden: true,
        onSelect: (dialog) => {
          input.extmarks.clear()
          input.clear()
          dialog.clear()
        },
      },
      {
        title: t("tui.command.prompt.submit.title"),
        value: "prompt.submit",
        keybind: "input_submit",
        category: "prompt",
        hidden: true,
        onSelect: async (dialog) => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: t("tui.command.prompt.paste.title"),
        value: "prompt.paste",
        keybind: "input_paste",
        category: "prompt",
        hidden: true,
        onSelect: async () => {
          await pasteFromClipboard()
        },
      },
      {
        title: t("tui.command.session.interrupt.title"),
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: "session",
        hidden: true,
        enabled: status().type !== "idle",
        onSelect: (dialog) => {
          if (autocomplete.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: t("tui.command.prompt.editor.title"),
        category: "session",
        keybind: "editor_open",
        value: "prompt.editor",
        slash: {
          name: "editor",
        },
        onSelect: async (dialog) => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await Editor.open({ value, renderer })
          if (!content) return

          input.setText(content)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = content.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: content,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(content)
        },
      },
      {
        title: t("tui.command.prompt.skills.title"),
        value: "prompt.skills",
        category: "prompt",
        slash: {
          name: "skills",
        },
        onSelect: () => {
          dialog.replace(() => (
            <DialogSkill
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  input: `/${skill} `,
                  parts: [],
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
      {
        title: t("tui.command.consent.revoke.title"),
        value: "consent.revoke",
        category: "prompt",
        slash: {
          name: "revoke-consent",
        },
        onSelect: (dialog) => {
          kv.delete(FREE_AGREEMENT_KEY)
          dialog.clear()
          toast.show({
            message: t("tui.consent.revoked"),
            variant: "info",
            duration: 3000,
          })
        },
      },
      {
        title: voiceEnabled() ? t("tui.command.voice.toggle.title_on") : t("tui.command.voice.toggle.title_off"),
        value: "voice.toggle",
        category: "prompt",
        slash: {
          name: "voice",
        },
        onSelect: () => {
          const next = !voiceEnabled()
          kv.set("voice_enabled", next)
          if (!next && activeVoice) void voiceToggle()
          toast.show({
            message: next ? t("tui.voice.enabled") : t("tui.voice.disabled"),
            variant: "info",
            duration: 3000,
          })
        },
      },
      {
        title: voiceSendEnabled() ? t("tui.command.voice.send.title_on") : t("tui.command.voice.send.title_off"),
        value: "voice.send",
        category: "prompt",
        slash: {
          name: "voice-send",
        },
        onSelect: () => {
          const next = !voiceSendEnabled()
          kv.set("voice_send_command", next)
          toast.show({
            message: next ? t("tui.voice.send.enabled") : t("tui.voice.send.disabled"),
            variant: "info",
            duration: 3000,
          })
        },
      },
      {
        title: voiceControlEnabled() ? t("tui.command.voice.control.title_on") : t("tui.command.voice.control.title_off"),
        value: "voice.control",
        category: "prompt",
        slash: {
          name: "voice-control",
        },
        onSelect: () => {
          const next = !voiceControlEnabled()
          kv.set("voice_control_enabled", next)
          toast.show({
            message: next ? t("tui.voice.control.enabled") : t("tui.voice.control.disabled"),
            variant: "info",
            duration: 3000,
          })
        },
      },
    ]
  })

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
    paste() {
      void pasteFromClipboard()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: unwrap(store.prompt), cursor: input.cursorOffset }
    }
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    const capture =
      store.mode === "normal"
        ? auto()?.visible
          ? (["escape", "navigate", "submit", "tab"] as const)
          : (["tab"] as const)
        : undefined
    input.traits = {
      capture,
      suspend: !!props.disabled || store.mode === "shell",
      status: store.mode === "shell" ? "SHELL" : undefined,
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  command.register(() => [
    {
      title: t("tui.command.prompt.stash.title"),
      value: "prompt.stash",
      category: "prompt",
      enabled: !!store.prompt.input,
      onSelect: (dialog) => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        dialog.clear()
      },
    },
    {
      title: t("tui.command.prompt.stash.pop.title"),
      value: "prompt.stash.pop",
      category: "prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
        dialog.clear()
      },
    },
    {
      title: t("tui.command.prompt.stash.list.title"),
      value: "prompt.stash.list",
      category: "prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogStash
            onSelect={(entry) => {
              input.setText(entry.input)
              setStore("prompt", { input: entry.input, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  // While the free-model agreement dialog is open, ignore any further submit()
  // calls. Enter triggers submit twice (the input_submit keybind plus the
  // textarea's deferred onSubmit), and without this guard the deferred call can
  // interleave with the post-accept re-submit and drop the user's message.
  let agreementPending = false
  async function submit() {
    if (agreementPending) return false
    setGhost("")
    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (autocomplete?.visible) return false
    if (!store.prompt.input) return false
    const agent = local.agent.current()
    if (!agent) return false
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      void exit()
      return true
    }
    const selectedModel = local.model.current()
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }

    // Free models require a one-time acknowledgment of the terms and privacy
    // policy. Gate submission until the user accepts; the flag is stored in KV.
    const isFreeModel = FREE_MODEL_IDS.has(selectedModel.modelID)
    if (isFreeModel && !kv.get(FREE_AGREEMENT_KEY)) {
      agreementPending = true
      DialogAgreement.show(dialog, {
        onConfirm: () => {
          kv.set(FREE_AGREEMENT_KEY, true)
          void submit()
        },
        // Fires on any dismissal (confirm, cancel, esc, click-outside). Reset
        // the guard here so submission is unblocked once the dialog is gone.
        onClose: () => {
          agreementPending = false
        },
      })
      return false
    }

    const workspaceSession = props.sessionID ? sync.session.get(props.sessionID) : undefined
    const workspaceID = workspaceSession?.workspaceID
    const workspaceStatus = workspaceID ? (project.workspace.status(workspaceID) ?? "error") : undefined
    if (props.sessionID && workspaceID && workspaceStatus !== "connected") {
      dialog.replace(() => (
        <DialogWorkspaceUnavailable
          onRestore={() => {
            dialog.replace(() => (
              <DialogWorkspaceCreate
                onSelect={(nextWorkspaceID) =>
                  restoreWorkspaceSession({
                    dialog,
                    sdk,
                    sync,
                    project,
                    toast,
                    workspaceID: nextWorkspaceID,
                    sessionID: props.sessionID!,
                  })
                }
              />
            ))
          }}
        />
      ))
      return false
    }

    let sessionID = props.sessionID
    if (sessionID == null) {
      const res = await sdk.client.session.create({ workspace: props.workspaceID })

      if (res.error) {
        console.log("Creating a session failed:", res.error)

        toast.show({
          message: "Creating a session failed. Open console for more details.",
          variant: "error",
        })

        return true
      }

      sessionID = res.data.id
    }

    const messageID = MessageID.ascending()
    let inputText = store.prompt.input

    // Expand pasted text inline before submitting
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

    for (const extmark of sortedExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex !== undefined) {
        const part = store.prompt.parts[partIndex]
        if (part?.type === "text" && part.text) {
          const before = inputText.slice(0, extmark.start)
          const after = inputText.slice(extmark.end)
          inputText = before + part.text + after
        }
      }
    }

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const variant = local.model.variant.current()

    const clientSlash = inputText.startsWith("/")
      ? command.slashes().find((s) => s.display === inputText.trim())
      : undefined

    if (store.mode === "shell") {
      void sdk.client.session.shell({
        sessionID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        },
        command: inputText,
      })
      setStore("mode", "normal")
    } else if (clientSlash) {
      clientSlash.onSelect?.()
    } else if (
      inputText.startsWith("/") &&
      iife(() => {
        const firstLine = inputText.split("\n")[0]
        const command = firstLine.split(" ")[0].slice(1)
        return sync.data.command.some((x) => x.name === command)
      })
    ) {
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      void sdk.client.session.command({
        sessionID,
        command: command.slice(1),
        arguments: args,
        agent: agent.name,
        model: `${selectedModel.providerID}/${selectedModel.modelID}`,
        messageID,
        variant,
        parts: nonTextParts
          .filter((x) => x.type === "file")
          .map((x) => ({
            id: PartID.ascending(),
            ...x,
          })),
      })
    } else {
      sdk.client.session
        .promptAsync({
          sessionID,
          ...selectedModel,
          messageID,
          agent: agent.name,
          model: selectedModel,
          variant,
          parts: [
            {
              id: PartID.ascending(),
              type: "text",
              text: inputText,
            },
            ...nonTextParts.map(assign),
          ],
        })
        .catch((err) => {
          toast.show({
            message: err instanceof Error ? err.message : "Failed to send message",
            variant: "error",
          })
        })
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID)
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    input.clear()
    return true
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pastePlainText(normalizedText: string) {
    const pastedContent = normalizedText.trim()
    if (!pastedContent) return

    const filepath = iife(() => {
      const raw = pastedContent.replace(/^['"]+|['"]+$/g, "")
      if (raw.startsWith("file://")) {
        try {
          return fileURLToPath(raw)
        } catch {}
      }
      if (process.platform === "win32") return raw
      return raw.replace(/\\(.)/g, "$1")
    })
    const isUrl = /^(https?):\/\//.test(filepath)
    if (!isUrl) {
      try {
        const mime = await Filesystem.mimeType(filepath)
        const filename = path.basename(filepath)
        // Handle SVG as raw text content, not as base64 image
        if (mime === "image/svg+xml") {
          const content = await Filesystem.readText(filepath).catch(() => {})
          if (content) {
            pasteText(content, `[SVG: ${filename ?? "image"}]`)
            return
          }
        }
        if (mime.startsWith("image/") || mime === "application/pdf") {
          const content = await Filesystem.readArrayBuffer(filepath)
            .then((buffer) => Buffer.from(buffer).toString("base64"))
            .catch(() => {})
          if (content) {
            await pasteAttachment({
              filename,
              filepath,
              mime,
              content,
            })
            return
          }
        }
      } catch {}
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if ((lineCount >= 3 || pastedContent.length > 150) && !sync.data.config.experimental?.disable_paste_summary) {
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    // Force layout update and render for the pasted content
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  async function pasteFromClipboard() {
    if (props.disabled) return
    const content = await Clipboard.read()
    if (!content) return
    if (content.mime.startsWith("image/")) {
      await pasteAttachment({
        filename: "clipboard",
        mime: content.mime,
        content: content.data,
      })
      return
    }
    await pastePlainText(content.data.replace(/\r\n/g, "\n").replace(/\r/g, "\n"))
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const pdf = file.mime === "application/pdf"
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (pdf) return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    const agent = local.agent.current()
    if (!agent) return theme.border
    return local.agent.color(agent.name)
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const agentMetaAlpha = createFadeIn(() => !!local.agent.current(), animationsEnabled)
  const modelMetaAlpha = createFadeIn(() => !!local.agent.current() && store.mode === "normal", animationsEnabled)
  const variantMetaAlpha = createFadeIn(
    () => !!local.agent.current() && store.mode === "normal" && showVariant(),
    animationsEnabled,
  )
  const borderHighlight = createMemo(() => tint(theme.border, highlight(), agentMetaAlpha()))

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "normal" && ghost()) return t("tui.prompt.ghost", { prediction: ghost() })
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      return t("tui.prompt.placeholder.shell", { example: shell()[store.placeholder % shell().length] })
    }
    if (!list().length) return undefined
    return t("tui.prompt.placeholder.normal", { example: list()[store.placeholder % list().length] })
  })

  const spinnerDef = createMemo(() => {
    const agent = local.agent.current()
    const color = agent ? local.agent.color(agent.name) : theme.border
    return {
      frames: createFrames({
        color,
        style: "plane",
        width: 14,
        holdStart: 8,
        holdEnd: 8,
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "plane",
        holdStart: 8,
        holdEnd: 8,
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          autocomplete = r
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
      <box ref={(r) => (anchor = r)} visible={props.visible !== false}>
        <box
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
          >
            <textarea
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={keybind.leader ? theme.textMuted : theme.text}
              focusedTextColor={keybind.leader ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={6}
              onContentChange={() => {
                const value = input.plainText
                if (value !== "" && ghost()) setGhost("")
                setStore("prompt", "input", value)
                autocomplete.onInput(value)
                syncExtmarksWithPromptParts()
              }}
              keyBindings={textareaKeybindings()}
              onKeyDown={async (e) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
                // Handle Ctrl+V for terminals that forward it to the app as a raw
                // keypress (common on macOS/Linux). The textarea has no built-in
                // paste action, so without this nothing gets inserted. Terminals
                // that handle paste natively (e.g. Windows Terminal 1.25+) emit a
                // bracketed paste instead and never reach this path.
                if (keybind.match("input_paste", e)) {
                  e.preventDefault()
                  await pasteFromClipboard()
                  return
                }
                if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                  input.clear()
                  input.extmarks.clear()
                  setStore("prompt", {
                    input: "",
                    parts: [],
                  })
                  setStore("extmarkToPartIndex", new Map())
                  return
                }
                if (keybind.match("app_exit", e)) {
                  if (store.prompt.input === "") {
                    if (props.sessionID && status().type !== "idle") {
                      void sdk.client.session.abort({ sessionID: props.sessionID })
                      e.preventDefault()
                      return
                    }
                    await exit()
                    // Don't preventDefault - let textarea potentially handle the event
                    e.preventDefault()
                    return
                  }
                }
                if (e.name === "!" && input.visualCursor.offset === 0) {
                  setStore("placeholder", randomIndex(shell().length))
                  setStore("mode", "shell")
                  e.preventDefault()
                  return
                }
                if (store.mode === "shell") {
                  if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                    setStore("mode", "normal")
                    e.preventDefault()
                    return
                  }
                }
                if (ghost() && store.mode === "normal" && !autocomplete.visible && input.plainText === "") {
                  if (e.name === "tab") {
                    const text = ghost()
                    setGhost("")
                    input.setText(text)
                    setStore("prompt", "input", text)
                    input.gotoBufferEnd()
                    e.preventDefault()
                    return
                  }
                  if (e.name === "escape") {
                    setGhost("")
                    e.preventDefault()
                    return
                  }
                }
                if (store.mode === "normal") autocomplete.onKeyDown(e)
                if (!autocomplete.visible) {
                  if (
                    (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                    (keybind.match("history_next", e) && input.cursorOffset === input.plainText.length)
                  ) {
                    const direction = keybind.match("history_previous", e) ? -1 : 1
                    const item = history.move(direction, input.plainText)

                    if (item) {
                      input.setText(item.input)
                      setStore("prompt", item)
                      setStore("mode", item.mode ?? "normal")
                      restoreExtmarksFromParts(item.parts)
                      e.preventDefault()
                      if (direction === -1) input.cursorOffset = 0
                      if (direction === 1) input.cursorOffset = input.plainText.length
                    }
                    return
                  }

                  if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0) input.cursorOffset = 0
                  if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                    input.cursorOffset = input.plainText.length
                }
              }}
              onSubmit={() => {
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!normalizedText.trim()) {
                  command.trigger("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()
                await pastePlainText(normalizedText)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = theme.text
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={theme.text}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <Show when={local.agent.current()} fallback={<box height={1} />}>
                  {(agent) => (
                    <>
                      <text fg={fadeColor(highlight(), agentMetaAlpha())}>
                        {store.mode === "shell" ? "Shell" : Locale.titlecase(agent().name)}
                      </text>
                      <Show when={store.mode === "normal"}>
                        <box flexDirection="row" gap={1}>
                          <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>·</text>
                          <text
                            flexShrink={0}
                            fg={fadeColor(keybind.leader ? theme.textMuted : theme.text, modelMetaAlpha())}
                          >
                            {local.model.parsed().model}
                          </text>
                          <Show when={showVariant()}>
                            <text fg={fadeColor(theme.textMuted, variantMetaAlpha())}>·</text>
                            <text>
                              <span style={{ fg: fadeColor(theme.warning, variantMetaAlpha()), bold: true }}>
                                {local.model.variant.current()}
                              </span>
                            </text>
                          </Show>
                        </box>
                      </Show>
                    </>
                  )}
                </Show>
                <Show when={local.neverAsk.current()}>
                  <text>
                    <span style={{ fg: theme.error, bold: true }}>«never-ask»</span>
                  </text>
                </Show>
              </box>
              <box flexDirection="row" gap={1} alignItems="center">
                <Show when={hasRightContent()}>
                  {props.right}
                </Show>
                <Show when={voiceEnabled()}>
                  <Switch>
                    <Match when={voiceState() === "idle"}>
                      <text fg={theme.textMuted} selectable={false} onMouseUp={() => voiceToggle()}>
                        {"[ 🎙  Voice ]"}
                      </text>
                    </Match>
                    <Match when={voiceState() === "listening"}>
                      <text fg={theme.primary} selectable={false} onMouseUp={() => voiceToggle()}>
                        {"[ 🎙  -:-- ]"}
                      </text>
                    </Match>
                    <Match when={voiceState() === "speaking"}>
                      <text fg={theme.primary} selectable={false} onMouseUp={() => voiceToggle()}>
                        {`[ 🎙  ${Math.floor(voiceElapsed() / 60)}:${String(voiceElapsed() % 60).padStart(2, "0")} ]`}
                      </text>
                    </Match>
                    <Match when={voiceState() === "processing"}>
                      <text fg={theme.primary} selectable={false} onMouseUp={() => voiceToggle()}>
                        {"[ 🎙  .... ]"}
                      </text>
                    </Match>
                    <Match when={voiceState() === "finishing"}>
                      <text fg={theme.textMuted} selectable={false}>{"[ 🎙  .... ]"}</text>
                    </Match>
                  </Switch>
                </Show>
              </box>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between">
          <Show when={status().type !== "idle"} fallback={props.hint ?? <text />}>
            <box
              flexDirection="row"
              gap={1}
              flexGrow={1}
              justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
            >
              <box flexShrink={0} flexDirection="row" gap={1}>
                <box marginLeft={1}>
                  <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                    <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                  </Show>
                </box>
                {(() => {
                  const busyMessage = createMemo(() => {
                    const s = status()
                    return s.type === "busy" ? s.message : undefined
                  })
                  return (
                    <Show when={busyMessage()}>
                      <text fg={theme.textMuted}>{busyMessage()}</text>
                    </Show>
                  )
                })()}
                <box flexDirection="row" gap={1} flexShrink={0}>
                  {(() => {
                    const retry = createMemo(() => {
                      const s = status()
                      if (s.type !== "retry") return
                      return s
                    })
                    const message = createMemo(() => {
                      const r = retry()
                      if (!r) return
                      if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                        return "gemini is way too hot right now"
                      if (r.message.length > 80) return r.message.slice(0, 80) + "..."
                      return r.message
                    })
                    const isTruncated = createMemo(() => {
                      const r = retry()
                      if (!r) return false
                      return r.message.length > 120
                    })
                    const [seconds, setSeconds] = createSignal(0)
                    onMount(() => {
                      const timer = setInterval(() => {
                        const next = retry()?.next
                        if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                      }, 1000)

                      onCleanup(() => {
                        clearInterval(timer)
                      })
                    })
                    const handleMessageClick = () => {
                      const r = retry()
                      if (!r) return
                      if (isTruncated()) {
                        void DialogAlert.show(dialog, "Retry Error", r.message)
                      }
                    }

                    const retryText = () => {
                      const r = retry()
                      if (!r) return ""
                      const baseMessage = message()
                      const truncatedHint = isTruncated() ? " (click to expand)" : ""
                      const duration = formatDuration(seconds())
                      const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                      return baseMessage + truncatedHint + retryInfo
                    }

                    return (
                      <Show when={retry()}>
                        <box onMouseUp={handleMessageClick}>
                          <text fg={theme.error}>{retryText()}</text>
                        </box>
                      </Show>
                    )
                  })()}
                </box>
              </box>
              <text fg={store.interrupt > 0 ? theme.primary : theme.text}>
                esc{" "}
                <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                  {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                </span>
              </text>
            </box>
          </Show>
          <Show when={status().type !== "retry"}>
            <box gap={2} flexGrow={1} flexDirection="row" justifyContent="space-between">
              <Switch>
                <Match when={store.mode === "normal"}>
                  <box gap={2} flexDirection="row">
                    <Show when={usage()}>
                      {(item) => (
                        <text fg={theme.textMuted} wrapMode="none">
                          {[item().context, item().cost].filter(Boolean).join(" · ")}
                        </text>
                      )}
                    </Show>
                    <text fg={theme.text}>
                      {keybind.print("agent_cycle")} <span style={{ fg: theme.textMuted }}>{t("tui.prompt.hint.switch_mode")}</span>
                    </text>
                    <text fg={theme.text}>
                      {keybind.print("command_list")}{" "}
                      <span style={{ fg: theme.textMuted }}>{t("tui.prompt.hint.settings")}</span>
                    </text>
                  </box>
                  <Show when={status().type === "idle"}>
                    <box gap={2} flexDirection="row">
                      <text fg={theme.text}>
                        @ <span style={{ fg: theme.textMuted }}>{t("tui.prompt.hint.attach_file")}</span>
                      </text>
                      <text fg={theme.text}>
                        $ <span style={{ fg: theme.textMuted }}>{t("tui.prompt.hint.subagent")}</span>
                      </text>
                      <text fg={theme.text}>
                        / <span style={{ fg: theme.textMuted }}>{t("tui.prompt.hint.commands")}</span>
                      </text>
                    </box>
                  </Show>
                </Match>
                <Match when={store.mode === "shell"}>
                  <box flexGrow={1} flexDirection="row" justifyContent="flex-end">
                    <text fg={theme.text}>
                      esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                    </text>
                  </box>
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
      </box>
    </>
  )
}
