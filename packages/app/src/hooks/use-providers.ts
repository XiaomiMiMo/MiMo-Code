import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import type { ProviderListResponse } from "@mimo-ai/sdk/v2/client"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  // Provider data loads asynchronously. A child store can briefly report
  // provider_ready before `provider` is populated, and a remote sync can leave
  // globalSync.data.provider unset (e.g. on locked-down/offline networks where
  // the fetch never completes). Guarding here keeps the getters below from
  // dereferencing undefined and throwing "Cannot read properties of undefined
  // (reading 'map'/'filter')" during provider init, which otherwise crashes the
  // whole web UI with no recovery. The list fills in reactively once data lands.
  const providers = (): ProviderListResponse => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.provider_ready && projectStore.provider) return projectStore.provider
    }
    return globalSync.data.provider ?? { all: [], connected: [], default: {} }
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () => providers().all.filter((p) => popularProviderSet.has(p.id)),
    connected: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter((p) => connected.has(p.id))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter(
        (p) => connected.has(p.id) && (p.id !== "opencode" || Object.values(p.models).some((m) => m.cost?.input)),
      )
    },
  }
}
