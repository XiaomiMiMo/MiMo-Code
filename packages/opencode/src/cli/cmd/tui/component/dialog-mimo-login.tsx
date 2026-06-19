import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useDialog } from "@tui/ui/dialog"
import { useLanguage } from "../context/language"
import { AutoMethod, createDialogProviderOptions } from "./dialog-provider"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useToast } from "../ui/toast"
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
        title: "Codex",
        value: "codex",
        description: "ChatGPT Pro/Plus",
        category: "Recommended",
        onSelect: async () => {
          const result = await sdk.client.provider.oauth.authorize({
            providerID: "openai",
            method: 0,
          })
          if (result.error) {
            toast.show({ message: t("tui.dialog.login.start_failed"), variant: "error" })
            dialog.clear()
            return
          }
          dialog.replace(() => (
            <AutoMethod
              providerID="openai"
              index={0}
              title="Codex"
              authorization={result.data!}
            />
          ))
        },
      },
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
      ...providerOptions(),
    ]
  })

  return (
    <DialogSelect
      title={t("tui.dialog.login.title")}
      options={options()}
    />
  )
}
