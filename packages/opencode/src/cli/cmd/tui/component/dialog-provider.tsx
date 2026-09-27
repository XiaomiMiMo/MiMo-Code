import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useSync } from "@tui/context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@mimo-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "@tui/util/provider-origin"
import { isPopularProvider, PROVIDER_PRIORITY } from "@/util/provider-priority"
import { Keybind } from "@/util"
import { Spinner } from "./spinner"
import { fetchProviderModels, type ProviderModel } from "../util/provider-models"

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const options = createMemo(() => {
    const list = pipe(
      sync.data.provider_next.all,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => {
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, provider.id)
        const connected = sync.data.provider_next.connected.includes(provider.id)

        return {
          title: provider.name,
          value: provider.id,
          description: {
            anthropic: "(API key)",
            openai: "(ChatGPT Plus/Pro or API key)",
            "opencode-go": "Low cost subscription for everyone",
          }[provider.id],
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: isPopularProvider(provider.id) ? "Popular" : "Other",
          gutter: connected ? <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return

            const stored = sync.data.provider_auth[provider.id]
            const methods: ProviderAuthMethod[] =
              stored && stored.length > 0
                ? stored
                : [
                    {
                      type: "api",
                      label: "API key",
                    },
                  ]
            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="Select auth method"
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({
                  dialog,
                  prompts: method.prompts,
                })
                if (!value) return
                inputs = value
              }

              const result = await sdk.client.provider.oauth.authorize({
                providerID: provider.id,
                method: index,
                inputs,
              })
              if (result.error) {
                toast.show({
                  variant: "error",
                  message: JSON.stringify(result.error),
                })
                dialog.clear()
                return
              }
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              }
            }
            if (method.type === "api") {
              let metadata: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                metadata = value
              }
              return dialog.replace(() => (
                <ApiMethod providerID={provider.id} title={method.label} metadata={metadata} />
              ))
            }
          },
        }
      }),
    )
    const removable = sync.data.provider_next.all.filter((provider) => provider.source === "config")
    return [
      ...list,
      ...removable.map((provider) => ({
        title: `Remove ${provider.name}`,
        value: `__remove__${provider.id}`,
        description: "Delete provider",
        category: "Manage",
        onSelect() {
          dialog.replace(() => <RemoveCustomProvider providerID={provider.id} name={provider.name} />)
        },
      })),
      {
        title: "+ Custom provider",
        value: "__custom__",
        description: undefined,
        footer: undefined,
        category: "Other",
        gutter: undefined,
        onSelect() {
          dialog.replace(() => <CustomProviderWizard />)
        },
      },
    ]
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Connect a provider" options={options()} />
}

function RemoveCustomProvider(props: { providerID: string; name: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)

  useKeyboard((evt) => {
    if (evt.name !== "return" || busy()) return
    evt.preventDefault()
    void remove()
  })

  async function remove() {
    setBusy(true)
    const authRes = await sdk.client.auth.remove({ providerID: props.providerID })
    if (authRes.error) {
      setBusy(false)
      toast.show({ variant: "error", message: JSON.stringify(authRes.error) })
      return
    }
    const configRes = await sdk.client.global.config.provider.remove({ providerID: props.providerID })
    if (configRes.error) {
      setBusy(false)
      toast.show({ variant: "error", message: JSON.stringify(configRes.error) })
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.clear()
    toast.show({ variant: "success", message: `Removed provider ${props.name}` })
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Remove provider
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc cancel
        </text>
      </box>
      <text fg={theme.textMuted}>Remove {props.name} and its stored API key?</text>
      <Show when={!busy()} fallback={<Spinner color={theme.textMuted}>Removing provider...</Spinner>}>
        <box flexDirection="row" gap={2}>
          <text fg={theme.error} onMouseUp={() => void remove()}>
            Remove <span style={{ fg: theme.textMuted }}>enter</span>
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            Cancel <span style={{ fg: theme.textMuted }}>esc</span>
          </text>
        </box>
      </Show>
    </box>
  )
}

type CustomProviderProtocol = "@ai-sdk/openai-compatible" | "@ai-sdk/openai" | "@ai-sdk/anthropic"

const CUSTOM_PROVIDER_PAGES = ["Provider ID", "Display name", "Base URL", "Protocol", "API key", "Models"] as const
const SAVE_CUSTOM_PROVIDER_MODELS = "__save_custom_provider_models__"

type CustomProviderWizardState = {
  page: number
  providerID: string
  name: string
  baseURL: string
  protocol: CustomProviderProtocol
  apiKey: string
  selectedModels: ProviderModel[]
}

function CustomProviderWizard() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()
  const [state, setState] = createStore<CustomProviderWizardState>({
    page: 0,
    providerID: "",
    name: "",
    baseURL: "",
    protocol: "@ai-sdk/openai-compatible",
    apiKey: "",
    selectedModels: [],
  })

  function back() {
    if (state.page > 0) {
      setState("page", state.page - 1)
      return
    }
    dialog.clear()
  }

  function next() {
    if (state.page < CUSTOM_PROVIDER_PAGES.length - 1) setState("page", state.page + 1)
  }

  function valueForPage(page: number) {
    return [state.providerID, state.name || state.providerID, state.baseURL, state.protocol, state.apiKey, ""][page]
  }

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      back()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (!evt.ctrl) return
    if (evt.name === "left") {
      back()
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "right") {
      next()
      evt.preventDefault()
      evt.stopPropagation()
    }
  })

  function updateText(value: string) {
    const trimmed = value.trim()
    if (!trimmed) {
      toast.show({ variant: "error", message: `${CUSTOM_PROVIDER_PAGES[state.page]} is required` })
      return
    }
    if (state.page === 0) setState("providerID", trimmed)
    if (state.page === 1) setState("name", trimmed)
    if (state.page === 2) setState("baseURL", trimmed.replace(/\/+$/, ""))
    if (state.page === 4) setState("apiKey", trimmed)
    next()
  }

  async function save(models: ProviderModel[]) {
    const patch = {
      provider: {
        [state.providerID]: {
          name: state.name || state.providerID,
          npm: state.protocol,
          options: {
            baseURL: state.baseURL,
            setCacheKey: true,
            ...(state.protocol === "@ai-sdk/openai" ? { wireProtocol: "responses" } : {}),
          },
          models: Object.fromEntries(models.map((model) => [model.id, { name: model.name }])),
        },
      },
    }
    const updateRes = await sdk.client.global.config.update({ config: patch as never })
    if (updateRes.error) {
      toast.show({ variant: "error", message: JSON.stringify(updateRes.error) })
      return
    }
    const authRes = await sdk.client.auth.set({
      providerID: state.providerID,
      auth: { type: "api", key: state.apiKey },
    })
    if (authRes.error) {
      toast.show({ variant: "error", message: JSON.stringify(authRes.error) })
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={state.providerID} />)
  }

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={2} paddingRight={2} gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            Add custom provider
          </text>
          <text fg={theme.textMuted}>esc back · ctrl←/ctrl→ switch page</text>
        </box>
        <box flexDirection="row" gap={1}>
          <For each={CUSTOM_PROVIDER_PAGES}>
            {(title, index) => (
              <text
                fg={state.page === index() ? theme.primary : theme.textMuted}
                onMouseUp={() => setState("page", index())}
              >
                {state.page === index() ? `[${index() + 1}]` : `${index() + 1}`} {title}
              </text>
            )}
          </For>
        </box>
      </box>
      <Switch>
        <Match when={state.page === 0}>
          <CustomProviderTextPage
            title="Provider ID"
            placeholder="e.g. openrouter"
            value={valueForPage(0)}
            onConfirm={updateText}
          />
        </Match>
        <Match when={state.page === 1}>
          <CustomProviderTextPage
            title="Display name"
            placeholder="e.g. My Provider"
            value={valueForPage(1)}
            onConfirm={updateText}
          />
        </Match>
        <Match when={state.page === 2}>
          <CustomProviderTextPage
            title="Base URL"
            placeholder="https://api.example.com/v1"
            value={valueForPage(2)}
            onConfirm={updateText}
          />
        </Match>
        <Match when={state.page === 3}>
          <DialogSelect
            title="Protocol (4/6)"
            hint="Choose the wire protocol used by this endpoint."
            options={[
              {
                title: "OpenAI Chat Completions",
                value: "@ai-sdk/openai-compatible" as const,
                description: "/chat/completions",
              },
              {
                title: "OpenAI Responses",
                value: "@ai-sdk/openai" as const,
                description: "/responses",
              },
              {
                title: "Anthropic Messages",
                value: "@ai-sdk/anthropic" as const,
                description: "/messages",
              },
            ]}
            current={state.protocol}
            onSelect={(option) => {
              setState("protocol", option.value)
              next()
            }}
          />
        </Match>
        <Match when={state.page === 4}>
          <CustomProviderTextPage title="API key" placeholder="sk-..." value={valueForPage(4)} onConfirm={updateText} />
        </Match>
        <Match when={state.page === 5}>
          <CustomProviderModelsPage
            providerID={state.providerID}
            baseURL={state.baseURL}
            protocol={state.protocol}
            apiKey={state.apiKey}
            selected={state.selectedModels}
            onToggle={(model) => {
              setState("selectedModels", (current) =>
                current.some((item) => item.id === model.id)
                  ? current.filter((item) => item.id !== model.id)
                  : [...current, model],
              )
            }}
            onSubmit={(models) => {
              void save(models)
            }}
          />
        </Match>
      </Switch>
    </box>
  )
}

function CustomProviderTextPage(props: {
  title: string
  placeholder: string
  value: string
  onConfirm: (value: string) => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  let textarea: TextareaRenderable

  onMount(() => {
    dialog.setSize("large")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
      textarea.gotoLineEnd()
    }, 1)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text}>{props.title}</text>
      <textarea
        height={3}
        initialValue={props.value}
        placeholder={props.placeholder}
        placeholderColor={theme.textMuted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.primary}
        keyBindings={[{ name: "return", action: "submit" }]}
        onSubmit={() => props.onConfirm(textarea.plainText)}
        ref={(value: TextareaRenderable) => {
          textarea = value
        }}
      />
      <text fg={theme.textMuted}>enter continue · esc back</text>
    </box>
  )
}

function CustomProviderModelsPage(props: {
  providerID: string
  baseURL: string
  protocol: CustomProviderProtocol
  apiKey: string
  selected: ProviderModel[]
  onToggle: (model: ProviderModel) => void
  onSubmit: (models: ProviderModel[]) => void
}) {
  const [models, setModels] = createSignal<ProviderModel[]>([])
  const [error, setError] = createSignal<string>()
  const toast = useToast()
  const { theme } = useTheme()

  onMount(() => {
    void fetchProviderModels(props.protocol, props.baseURL, props.apiKey)
      .then((value) => {
        if (value.length === 0) {
          setError("The provider returned no models")
          return
        }
        setModels(value)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load models"))
  })

  function submit() {
    if (props.selected.length === 0) {
      toast.show({ variant: "error", message: "Select at least one model" })
      return
    }
    props.onSubmit(props.selected)
  }

  const options = createMemo<DialogSelectOption<ProviderModel | typeof SAVE_CUSTOM_PROVIDER_MODELS>[]>(() => [
    ...models().map((model) => ({
      title: model.name,
      value: model,
      description: model.id === model.name ? undefined : model.id,
      gutter: props.selected.some((item) => item.id === model.id) ? <text fg={theme.success}>✓</text> : undefined,
      onSelect: () => props.onToggle(model),
    })),
    {
      title: `Save selected models (${props.selected.length})`,
      value: SAVE_CUSTOM_PROVIDER_MODELS,
      description: "Finish provider setup",
      category: "",
      onSelect: submit,
    },
  ])

  return (
    <Show
      when={!error()}
      fallback={
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text attributes={TextAttributes.BOLD} fg={theme.error}>
            Could not load models
          </text>
          <text fg={theme.textMuted}>{error()}</text>
          <text fg={theme.textMuted}>Check the base URL and API key, then press esc to go back.</text>
        </box>
      }
    >
      <Show
        when={models().length > 0}
        fallback={
          <box paddingLeft={2} paddingRight={2} gap={1}>
            <Spinner color={theme.textMuted}>Loading models from {props.providerID}...</Spinner>
          </box>
        }
      >
        <DialogSelect
          title="Select models (6/6)"
          hint={`${props.selected.length} selected · space toggle · enter save`}
          options={options()}
          keybind={[
            {
              keybind: Keybind.parse("space")[0],
              title: "Toggle",
              onTrigger: (option) => {
                if (option.value !== SAVE_CUSTOM_PROVIDER_MODELS) props.onToggle(option.value)
              },
            },
          ]}
        />
      </Show>
    </Show>
  )
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
export function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata?: Record<string, string>
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={
        {
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Zen gives you access to all the best coding models at the cheapest prices with a single API
                key.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> to get a key
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Go is a $10 per month subscription that provides reliable access to popular open coding models
                with generous usage limits.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> and enable OpenCode Go
              </text>
            </box>
          ),
        }[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
