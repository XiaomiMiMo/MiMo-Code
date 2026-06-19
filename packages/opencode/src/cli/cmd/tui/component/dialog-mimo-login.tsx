import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { useLanguage } from "../context/language"
import { createDialogProviderOptions } from "./dialog-provider"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import * as Clipboard from "@tui/util/clipboard"
import { useRenderer } from "@opentui/solid"
import os from "os"
import path from "path"

export function DialogMimoLogin() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const toast = useToast()
  const { t } = useLanguage()
  const providerOptions = createDialogProviderOptions()

  const options = createMemo(() => {
    const recommended = [
      {
        title: t("tui.dialog.login.xiaomi"),
        value: "xiaomi",
        description: t("tui.dialog.login.xiaomi.desc"),
        category: "Recommended",
        onSelect: async () => {
          const result = await sdk.client.provider.oauth.authorize({
            providerID: "xiaomi",
            method: 0,
          })
          if (result.error) {
            toast.show({ message: t("tui.dialog.login.start_failed"), variant: "error" })
            dialog.clear()
            return
          }
          dialog.replace(() => (
            <MimoOAuthFlow url={result.data!.url} instructions={result.data!.instructions} />
          ))
        },
      },
      // Free "mimo-auto" channel: only offered when its provider is actually
      // loaded (i.e. the private src/private/ overlay is present). In the
      // open-source build the provider never loads, so this option is hidden.
      ...(sync.data.provider.some((p) => p.id === "mimo")
        ? [
            {
              title: t("tui.dialog.login.mimo_free"),
              value: "mimo-free",
              description: t("tui.dialog.login.mimo_free.desc"),
              category: "Recommended",
              onSelect: async () => {
                await sync.bootstrap()
                const mimo = sync.data.provider.find((p) => p.id === "mimo")
                if (!mimo || !("mimo-auto" in mimo.models)) {
                  toast.show({ message: t("tui.dialog.login.mimo_free.unavailable"), variant: "error" })
                  dialog.clear()
                  return
                }
                local.model.set({ providerID: "mimo", modelID: "mimo-auto" }, { recent: true })
                toast.show({ message: t("tui.dialog.login.mimo_free.success"), variant: "info" })
                dialog.clear()
              },
            },
          ]
        : []),
      {
        title: t("tui.dialog.login.import_claude"),
        value: "import_claude",
        category: "Recommended",
        onSelect: async () => {
          const claudeDir = path.join(os.homedir(), ".claude")
          const candidates = ["settings.json", "settings.local.json", "settings_local.json"]

          const resolve = await (async () => {
            const envs: Record<string, string>[] = []
            for (const file of candidates) {
              try {
                const content = await Bun.file(path.join(claudeDir, file)).json()
                if (content?.env && typeof content.env === "object") envs.push(content.env)
              } catch {}
            }
            return (name: string) => {
              for (let i = envs.length - 1; i >= 0; i--) {
                const v = envs[i][name]
                if (v && typeof v === "string") return v
              }
              return process.env[name]
            }
          })()

          const key = resolve("ANTHROPIC_API_KEY")
          const rawBaseUrl = resolve("ANTHROPIC_BASE_URL")
          const baseUrl = rawBaseUrl
            ? rawBaseUrl.replace(/\/+$/, "").replace(/(?<!\/v1)$/, "/v1")
            : undefined
          // strip Claude Code context-window suffix e.g. claude-opus-4-6[1m]
          const preferredModel = (
            resolve("ANTHROPIC_DEFAULT_OPUS_MODEL") ?? resolve("ANTHROPIC_DEFAULT_SONNET_MODEL")
          )?.replace(/\[.*\]$/, "")

          if (!key) {
            toast.show({ message: t("tui.dialog.login.import_claude.no_key"), variant: "error" })
            dialog.clear()
            return
          }

          await sdk.client.auth.set({
            providerID: "anthropic",
            auth: { type: "api", key },
          })
          await sdk.client.global.config.update({
            config: {
              provider: {
                anthropic: { options: { baseURL: baseUrl || "https://api.anthropic.com/v1" } },
              },
            },
          })
          await sdk.client.instance.dispose()
          await sync.bootstrap()

          const anthropic = sync.data.provider.find((p) => p.id === "anthropic")
          if (anthropic) {
            if (preferredModel && !(preferredModel in anthropic.models)) {
              await sdk.client.global.config.update({
                config: {
                  provider: {
                    anthropic: { models: { [preferredModel]: { name: preferredModel } } },
                  },
                },
              })
              await sdk.client.instance.dispose()
              await sync.bootstrap()
            }
            const models = Object.keys(anthropic.models).sort()
            const selected = preferredModel
              || models.find((m) => m === "claude-opus-4-6")
              || models.findLast((m) => m.includes("opus"))
              || models.findLast((m) => m.includes("sonnet"))
              || models[0]
            if (selected) {
              local.model.set({ providerID: "anthropic", modelID: selected }, { recent: true })
            }
          }
          toast.show({ message: t("tui.dialog.login.import_claude.success"), variant: "info" })
          dialog.clear()
        },
      },
    ]

    return [
      ...recommended,
      ...providerOptions().filter((option) => option.value !== "xiaomi"),
    ]
  })

  return (
    <DialogSelect
      title={t("tui.dialog.login.title")}
      options={options()}
    />
  )
}

function MimoOAuthFlow(props: { url: string; instructions: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const { t } = useLanguage()
  const toast = useToast()
  const renderer = useRenderer()
  const [busy, setBusy] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  function copyUrl() {
    Clipboard.copy(props.url)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(toast.error)
  }

  async function onLoginSuccess() {
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    const xiaomi = sync.data.provider.find((p) => p.id === "xiaomi")
    const defaultModel = xiaomi && "mimo-v2.5-pro" in xiaomi.models ? "mimo-v2.5-pro" : xiaomi ? Object.keys(xiaomi.models)[0] : undefined
    if (defaultModel) {
      local.model.set({ providerID: "xiaomi", modelID: defaultModel }, { recent: true })
    }
    dialog.clear()
  }

  onMount(async () => {
    const callbackResult = await sdk.client.provider.oauth.callback({
      providerID: "xiaomi",
      method: 0,
    })
    if (callbackResult.error) return
    await onLoginSuccess()
  })

  return (
    <DialogPrompt
      title={t("tui.dialog.login.flow.title")}
      placeholder={t("tui.dialog.login.flow.placeholder")}
      busy={busy()}
      busyText={t("tui.dialog.login.flow.busy")}
      description={
        <box gap={1}>
          <Show when={props.url}>
            <text fg={theme.textMuted}>
              {t("tui.dialog.login.flow.manual_hint")}
              <Show when={copied()}>{" "}<span style={{ fg: theme.primary }}>({t("tui.dialog.login.flow.copied")})</span></Show>
            </text>
            <text
              fg={theme.primary}
              onMouseUp={() => {
                if (renderer.getSelection()?.getSelectedText()) return
                copyUrl()
              }}
            >
              {props.url}
            </text>
          </Show>
          <Show when={props.instructions}>
            <text fg={theme.textMuted}>{props.instructions}</text>
          </Show>
          <text fg={theme.textMuted}>{t("tui.dialog.login.flow.waiting")}</text>
        </box>
      }
      onConfirm={async (value) => {
        if (!value) return
        setBusy(true)
        const { error: err } = await sdk.client.provider.oauth.callback({
          providerID: "xiaomi",
          method: 0,
          code: value.trim(),
        })
        if (err) {
          setBusy(false)
          toast.show({ message: t("tui.dialog.login.flow.invalid_code"), variant: "error" })
          return
        }
        await onLoginSuccess()
      }}
    />
  )
}
