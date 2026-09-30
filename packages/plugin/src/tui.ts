import type {
  AgentPart,
  OpencodeClient,
  Event,
  FilePart,
  LspStatus,
  McpStatus,
  Todo,
  SessionTaskResponse,
  Message,
  Part,
  Provider,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  TextPart,
  Config as SdkConfig,
} from "@mimo-ai/sdk/v2"
import type { CliRenderer, KeyEvent, ParsedKey, Renderable, RGBA, SlotMode } from "@opentui/core"
import type { JSX, SolidPlugin } from "@opentui/solid"
import type { Config as PluginConfig, PluginOptions } from "./index.js"

export type { CliRenderer, SlotMode } from "@opentui/core"

export type TuiRouteCurrent =
  | {
      name: "home"
    }
  | {
      name: "session"
      params: {
        sessionID: string
        prompt?: unknown
      }
    }
  | {
      name: string
      params?: Record<string, unknown>
    }

export type TuiRouteDefinition = {
  name: string
  render: (input: { params?: Record<string, unknown> }) => JSX.Element
}

export type TuiCommand = {
  title: string
  value: string
  description?: string
  category?: string
  keybind?: string
  suggested?: boolean
  hidden?: boolean
  enabled?: boolean
  slash?: {
    name: string
    aliases?: string[]
  }
  onSelect?: () => void
}

export type TuiKeybind = {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  super?: boolean
  leader: boolean
}

export type TuiKeybindMap = Record<string, string>

export type TuiKeybindSet = {
  readonly all: TuiKeybindMap
  get: (name: string) => string
  match: (name: string, evt: ParsedKey) => boolean
  print: (name: string) => string
}

// ---- api.keymap types ------------------------------------------------------
// Narrow, type-compatible subset of upstream `@opentui/keymap` (mirrored so
// OpenCode plugins using `api.keymap.registerLayer` compile against it). The
// runtime value bridges to the fork's command dialog + keybind system — see
// `packages/opencode/src/cli/cmd/tui/plugin/keymap.ts`.

export type KeyStrokeInput = {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
  hyper?: boolean
}

export type KeyLike = string | KeyStrokeInput

export type KeySequencePart = {
  stroke: KeyStrokeInput & { ctrl: boolean; shift: boolean; meta: boolean; super: boolean }
  display: string
  match: string
  tokenName?: string
  patternName?: string
  payloadKey?: string
}

export type CommandContext<TTarget extends object = object, TEvent = KeyEvent, TPayload = unknown> = {
  keymap: Keymap<TTarget, TEvent>
  event: TEvent | undefined
  focused: TTarget | null
  target: TTarget | null
  data: Readonly<Record<string, unknown>>
  command?: Command<TTarget, TEvent, TPayload>
  input: string
  payload: TPayload
}

export type Command<TTarget extends object = object, TEvent = KeyEvent, TPayload = unknown> = {
  name: string
  run: (ctx: CommandContext<TTarget, TEvent, TPayload>) => unknown
  [key: string]: unknown
}

export type RunCommandResult<TTarget extends object = object, TEvent = KeyEvent> =
  | { ok: true; command?: Command<TTarget, TEvent> }
  | { ok: false; reason: "not-found" }
  | {
      ok: false
      reason: "inactive" | "disabled" | "invalid-args" | "rejected" | "error"
      command?: Command<TTarget, TEvent>
    }

export type RunCommandOptions<TTarget extends object = object, TEvent = KeyEvent> = {
  event?: TEvent
  focused?: TTarget | null
  target?: TTarget | null
  includeCommand?: boolean
  payload?: unknown
}

export type Binding<TTarget extends object = object, TEvent = KeyEvent> = {
  key: KeyLike
  cmd?: string | ((ctx: CommandContext<TTarget, TEvent>) => unknown)
  event?: "press" | "release"
  preventDefault?: boolean
  fallthrough?: boolean
  [key: string]: unknown
}

export type Layer<TTarget extends object = object, TEvent = KeyEvent> = {
  target?: TTarget
  priority?: number
  bindings?: readonly Binding<TTarget, TEvent>[]
  commands?: readonly Command<TTarget, TEvent, unknown>[]
  targetMode?: "focus" | "focus-within"
  [key: string]: unknown
}

export type CommandQuery<TTarget extends object = object, TEvent = KeyEvent> = {
  visibility?: "reachable" | "active" | "registered"
  focused?: TTarget | null
  namespace?: string | readonly string[]
  search?: string
  searchIn?: readonly string[]
  filter?: Readonly<Record<string, unknown>> | ((command: Command<TTarget, TEvent>) => boolean)
  limit?: number
}

export type ActiveBinding<TTarget extends object = object, TEvent = KeyEvent> = {
  sequence: readonly KeySequencePart[]
  command?: string | ((ctx: CommandContext<TTarget, TEvent>) => unknown)
  commandAttrs?: Readonly<Record<string, unknown>>
  attrs?: Readonly<Record<string, unknown>>
  event: "press" | "release"
  preventDefault: boolean
  fallthrough: boolean
}

export type CommandEntry<TTarget extends object = object, TEvent = KeyEvent> = {
  command: Command<TTarget, TEvent>
  bindings: readonly ActiveBinding<TTarget, TEvent>[]
}

/**
 * The `api.keymap` surface. Only the methods the fork implements are declared;
 * OpenCode plugins call `registerLayer`/`dispatchCommand` and the query/data
 * accessors, which are all present. `on`/`intercept` are no-op stubs.
 */
export interface Keymap<TTarget extends object = object, TEvent = KeyEvent> {
  registerLayer(layer: Layer<TTarget, TEvent>): () => void
  dispatchCommand(name: string, options?: RunCommandOptions<TTarget, TEvent>): RunCommandResult<TTarget, TEvent>
  runCommand(name: string, options?: RunCommandOptions<TTarget, TEvent>): RunCommandResult<TTarget, TEvent>
  getCommands(query?: CommandQuery<TTarget, TEvent>): readonly Command<TTarget, TEvent>[]
  getCommandEntries(query?: CommandQuery<TTarget, TEvent>): readonly CommandEntry<TTarget, TEvent>[]
  getCommandBindings(
    query?: CommandQuery<TTarget, TEvent>,
  ): ReadonlyMap<string, readonly ActiveBinding<TTarget, TEvent>[]>
  setData(name: string, value: unknown): void
  getData(name: string): unknown
  on(name: string, listener: (...args: unknown[]) => void): () => void
  intercept(name: string, fn: (...args: unknown[]) => void): () => void
  createKeyMatcher(key: KeyLike): (input: KeyLike | null | undefined) => boolean
  parseKeySequence(key: KeyLike): readonly KeySequencePart[]
  formatKey(key: KeyLike): string
}

export type TuiKeymap = Keymap<Renderable, KeyEvent>

export type TuiDialogProps = {
  size?: "medium" | "large" | "xlarge"
  onClose: () => void
  children?: JSX.Element
}

export type TuiDialogStack = {
  replace: (render: () => JSX.Element, onClose?: () => void) => void
  clear: () => void
  setSize: (size: "medium" | "large" | "xlarge") => void
  readonly size: "medium" | "large" | "xlarge"
  readonly depth: number
  readonly open: boolean
}

export type TuiDialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export type TuiDialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
}

export type TuiDialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export type TuiDialogSelectOption<Value = unknown> = {
  title: string
  value: Value
  description?: string
  footer?: JSX.Element | string
  category?: string
  disabled?: boolean
  onSelect?: () => void
}

export type TuiDialogSelectProps<Value = unknown> = {
  title: string
  placeholder?: string
  options: TuiDialogSelectOption<Value>[]
  flat?: boolean
  onMove?: (option: TuiDialogSelectOption<Value>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: TuiDialogSelectOption<Value>) => void
  skipFilter?: boolean
  current?: Value
}

export type TuiPromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export type TuiPromptRef = {
  focused: boolean
  current: TuiPromptInfo
  set(prompt: TuiPromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
  paste(): void
}

export type TuiPromptProps = {
  sessionID?: string
  workspaceID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: TuiPromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type TuiToast = {
  variant?: "info" | "success" | "warning" | "error"
  title?: string
  message: string
  duration?: number
}

export type TuiThemeCurrent = {
  readonly primary: RGBA
  readonly secondary: RGBA
  readonly accent: RGBA
  readonly error: RGBA
  readonly warning: RGBA
  readonly success: RGBA
  readonly info: RGBA
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly selectedListItemText: RGBA
  readonly background: RGBA
  readonly backgroundPanel: RGBA
  readonly backgroundElement: RGBA
  readonly backgroundMenu: RGBA
  readonly border: RGBA
  readonly borderActive: RGBA
  readonly borderSubtle: RGBA
  readonly diffAdded: RGBA
  readonly diffRemoved: RGBA
  readonly diffContext: RGBA
  readonly diffHunkHeader: RGBA
  readonly diffHighlightAdded: RGBA
  readonly diffHighlightRemoved: RGBA
  readonly diffAddedBg: RGBA
  readonly diffRemovedBg: RGBA
  readonly diffContextBg: RGBA
  readonly diffLineNumber: RGBA
  readonly diffAddedLineNumberBg: RGBA
  readonly diffRemovedLineNumberBg: RGBA
  readonly markdownText: RGBA
  readonly markdownHeading: RGBA
  readonly markdownLink: RGBA
  readonly markdownLinkText: RGBA
  readonly markdownCode: RGBA
  readonly markdownBlockQuote: RGBA
  readonly markdownEmph: RGBA
  readonly markdownStrong: RGBA
  readonly markdownHorizontalRule: RGBA
  readonly markdownListItem: RGBA
  readonly markdownListEnumeration: RGBA
  readonly markdownImage: RGBA
  readonly markdownImageText: RGBA
  readonly markdownCodeBlock: RGBA
  readonly syntaxComment: RGBA
  readonly syntaxKeyword: RGBA
  readonly syntaxFunction: RGBA
  readonly syntaxVariable: RGBA
  readonly syntaxString: RGBA
  readonly syntaxNumber: RGBA
  readonly syntaxType: RGBA
  readonly syntaxOperator: RGBA
  readonly syntaxPunctuation: RGBA
  readonly thinkingOpacity: number
}

export type TuiTheme = {
  readonly current: TuiThemeCurrent
  readonly selected: string
  has: (name: string) => boolean
  set: (name: string) => boolean
  install: (jsonPath: string) => Promise<void>
  mode: () => "dark" | "light"
  readonly ready: boolean
}

export type TuiKV = {
  get: <Value = unknown>(key: string, fallback?: Value) => Value
  set: (key: string, value: unknown) => void
  readonly ready: boolean
}

export type TuiState = {
  readonly ready: boolean
  readonly config: SdkConfig
  readonly provider: ReadonlyArray<Provider>
  readonly path: {
    state: string
    config: string
    worktree: string
    directory: string
  }
  readonly vcs: { branch?: string } | undefined
  session: {
    count: () => number
    diff: (sessionID: string) => ReadonlyArray<TuiSidebarFileItem>
    todo: (sessionID: string) => ReadonlyArray<TuiSidebarTodoItem>
    task: (sessionID: string) => ReadonlyArray<TuiSidebarTaskItem>
    messages: (sessionID: string) => ReadonlyArray<Message>
    status: (sessionID: string) => SessionStatus | undefined
    goal: (sessionID: string) => TuiSidebarGoal | undefined
    cwd: (sessionID: string) => string | undefined
    permission: (sessionID: string) => ReadonlyArray<PermissionRequest>
    question: (sessionID: string) => ReadonlyArray<QuestionRequest>
  }
  part: (messageID: string) => ReadonlyArray<Part>
  lsp: () => ReadonlyArray<TuiSidebarLspItem>
  mcp: () => ReadonlyArray<TuiSidebarMcpItem>
  instructions: () => ReadonlyArray<string>
}

type TuiConfigView = Pick<PluginConfig, "$schema" | "theme" | "keybinds" | "plugin"> &
  NonNullable<PluginConfig["tui"]> & {
    plugin_enabled?: Record<string, boolean>
  }

export type TuiApp = {
  readonly version: string
}

type Frozen<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends ReadonlyArray<infer Item>
    ? ReadonlyArray<Frozen<Item>>
    : Value extends object
      ? { readonly [Key in keyof Value]: Frozen<Value[Key]> }
      : Value

export type TuiSidebarMcpItem = {
  name: string
  status: McpStatus["status"]
  error?: string
}

export type TuiSidebarLspItem = Pick<LspStatus, "id" | "root" | "status">

export type TuiSidebarGoalVerdict = {
  ok: boolean
  impossible?: boolean
  reason: string
  attempt: number
  error?: boolean
}

export type TuiSidebarGoal = {
  condition?: string
  verdicts: { [messageID: string]: TuiSidebarGoalVerdict }
  lastMessageID?: string
}

export type TuiSidebarTodoItem = Pick<Todo, "content" | "status">

export type TuiSidebarTaskItem = Pick<
  SessionTaskResponse[number],
  "id" | "status" | "summary" | "owner" | "ended_at"
>

export type TuiSidebarFileItem = {
  file: string
  additions: number
  deletions: number
}

export type TuiHostSlotMap = {
  app: {}
  home_logo: {}
  home_prompt: {
    workspace_id?: string
    ref?: (ref: TuiPromptRef | undefined) => void
  }
  home_prompt_right: {
    workspace_id?: string
  }
  session_prompt: {
    session_id: string
    visible?: boolean
    disabled?: boolean
    on_submit?: () => void
    ref?: (ref: TuiPromptRef | undefined) => void
  }
  session_prompt_right: {
    session_id: string
  }
  home_bottom: {}
  home_footer: {}
  sidebar_title: {
    session_id: string
    title: string
    share_url?: string
  }
  sidebar_content: {
    session_id: string
  }
  sidebar_footer: {
    session_id: string
  }
}

export type TuiSlotMap<Slots extends Record<string, object> = {}> = TuiHostSlotMap & Slots

type TuiSlotShape<Name extends string, Slots extends Record<string, object>> = Name extends keyof TuiHostSlotMap
  ? TuiHostSlotMap[Name]
  : Name extends keyof Slots
    ? Slots[Name]
    : Record<string, unknown>

export type TuiSlotProps<Name extends string = string, Slots extends Record<string, object> = {}> = {
  name: Name
  mode?: SlotMode
  children?: JSX.Element
} & TuiSlotShape<Name, Slots>

export type TuiSlotContext = {
  theme: TuiTheme
}

type SlotCore<Slots extends Record<string, object> = {}> = SolidPlugin<TuiSlotMap<Slots>, TuiSlotContext>

export type TuiSlotPlugin<Slots extends Record<string, object> = {}> = Omit<SlotCore<Slots>, "id"> & {
  id?: never
}

export type TuiSlots = {
  register: {
    (plugin: TuiSlotPlugin): string
    <Slots extends Record<string, object>>(plugin: TuiSlotPlugin<Slots>): string
  }
}

export type TuiEventBus = {
  on: <Type extends Event["type"]>(type: Type, handler: (event: Extract<Event, { type: Type }>) => void) => () => void
}

export type TuiDispose = () => void | Promise<void>

export type TuiLifecycle = {
  readonly signal: AbortSignal
  onDispose: (fn: TuiDispose) => () => void
}

export type TuiPluginState = "first" | "updated" | "same"

export type TuiPluginEntry = {
  id: string
  source: "file" | "npm" | "internal"
  spec: string
  target: string
  requested?: string
  version?: string
  modified?: number
  first_time: number
  last_time: number
  time_changed: number
  load_count: number
  fingerprint: string
}

export type TuiPluginMeta = TuiPluginEntry & {
  state: TuiPluginState
}

export type TuiPluginStatus = {
  id: string
  source: TuiPluginEntry["source"]
  spec: string
  target: string
  enabled: boolean
  active: boolean
}

export type TuiPluginInstallOptions = {
  global?: boolean
}

export type TuiPluginInstallResult =
  | {
      ok: true
      dir: string
      tui: boolean
    }
  | {
      ok: false
      message: string
      missing?: boolean
    }

export type TuiWorkspace = {
  current: () => string | undefined
  set: (workspaceID?: string) => void
}

export type TuiPluginApi = {
  app: TuiApp
  command: {
    register: (cb: () => TuiCommand[]) => () => void
    trigger: (value: string) => void
    show: () => void
  }
  keymap: TuiKeymap
  route: {
    register: (routes: TuiRouteDefinition[]) => () => void
    navigate: (name: string, params?: Record<string, unknown>) => void
    readonly current: TuiRouteCurrent
  }
  ui: {
    Dialog: (props: TuiDialogProps) => JSX.Element
    DialogAlert: (props: TuiDialogAlertProps) => JSX.Element
    DialogConfirm: (props: TuiDialogConfirmProps) => JSX.Element
    DialogPrompt: (props: TuiDialogPromptProps) => JSX.Element
    DialogSelect: <Value = unknown>(props: TuiDialogSelectProps<Value>) => JSX.Element
    Slot: <Name extends string>(props: TuiSlotProps<Name>) => JSX.Element | null
    Prompt: (props: TuiPromptProps) => JSX.Element
    toast: (input: TuiToast) => void
    dialog: TuiDialogStack
  }
  keybind: {
    match: (key: string, evt: ParsedKey) => boolean
    print: (key: string) => string
    create: (defaults: TuiKeybindMap, overrides?: Record<string, unknown>) => TuiKeybindSet
  }
  readonly tuiConfig: Frozen<TuiConfigView>
  kv: TuiKV
  state: TuiState
  theme: TuiTheme
  client: OpencodeClient
  event: TuiEventBus
  renderer: CliRenderer
  slots: TuiSlots
  plugins: {
    list: () => ReadonlyArray<TuiPluginStatus>
    activate: (id: string) => Promise<boolean>
    deactivate: (id: string) => Promise<boolean>
    add: (spec: string) => Promise<boolean>
    install: (spec: string, options?: TuiPluginInstallOptions) => Promise<TuiPluginInstallResult>
  }
  lifecycle: TuiLifecycle
}

export type TuiPlugin = (api: TuiPluginApi, options: PluginOptions | undefined, meta: TuiPluginMeta) => Promise<void>

export type TuiPluginModule = {
  id?: string
  tui: TuiPlugin
  server?: never
}
