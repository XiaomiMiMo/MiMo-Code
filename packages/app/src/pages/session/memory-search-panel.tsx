import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { createQuery, keepPreviousData, skipToken } from "@tanstack/solid-query"
import { useNavigate, useLocation, useParams } from "@solidjs/router"
import { TextField } from "@mimo-ai/ui/text-field"
import { Tabs } from "@mimo-ai/ui/tabs"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
type PanelMode = "memory" | "history"

type MemoryHit = {
  path: string
  snippet: string
  score: number
  scope: string
  scope_id: string
  type: string
}

type HistoryHit = {
  part_id: string
  session_id: string
  message_id: string
  project_id: string
  kind: string
  tool_name: string | null
  snippet: string
  score: number
  time_created: number
}

const SEARCH_DEBOUNCE_MS = 300

function useDebounced<T>(value: () => T, ms: number) {
  const [debounced, setDebounced] = createSignal(value())
  createEffect(() => {
    const next = value()
    const timer = setTimeout(() => setDebounced(() => next), ms)
    return () => clearTimeout(timer)
  })
  return debounced
}

function memoryLabel(hit: MemoryHit) {
  const parts = hit.path.split("/")
  return parts[parts.length - 1] || hit.path
}

export function MemorySearchPanel() {
  const language = useLanguage()
  const sdk = useSDK()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()

  const [mode, setMode] = createSignal<PanelMode>("memory")
  const [query, setQuery] = createSignal("")
  const [selectedMemoryPath, setSelectedMemoryPath] = createSignal<string | undefined>()
  const debouncedQuery = useDebounced(query, SEARCH_DEBOUNCE_MS)

  const memoryQuery = createQuery(() => {
    const q = debouncedQuery().trim()
    const active = mode() === "memory" && q.length > 0
    return {
      queryKey: ["memory-search", sdk.directory, q] as const,
      enabled: active,
      placeholderData: keepPreviousData,
      queryFn: active
        ? async () => {
            const res = await sdk.client.memory.search({ query: q, limit: 20 })
            if (res.error) throw res.error
            return (res.data ?? []) as MemoryHit[]
          }
        : skipToken,
    }
  })

  const historyQuery = createQuery(() => {
    const q = debouncedQuery().trim()
    const sessionID = params.id
    const active = mode() === "history" && q.length > 0
    return {
      queryKey: ["history-search", sdk.directory, sessionID ?? "", q] as const,
      enabled: active,
      placeholderData: keepPreviousData,
      queryFn: active
        ? async () => {
            const res = await sdk.client.history.search({
              query: q,
              scope: "project",
              session_id: sessionID || undefined,
              limit: 20,
            })
            if (res.error) throw res.error
            return (res.data ?? []) as HistoryHit[]
          }
        : skipToken,
    }
  })

  const previewQuery = createQuery(() => {
    const filePath = selectedMemoryPath()
    const active = !!filePath
    return {
      queryKey: ["memory-file", filePath ?? ""] as const,
      enabled: active,
      queryFn: active
        ? async () => {
            const res = await sdk.client.memory.file.get({ path: filePath! })
            if (res.error) throw res.error
            return res.data?.content ?? ""
          }
        : skipToken,
    }
  })

  const memoryHits = createMemo(() => memoryQuery.data ?? [])
  const historyHits = createMemo(() => historyQuery.data ?? [])
  const loading = createMemo(() =>
    mode() === "memory" ? memoryQuery.isFetching : historyQuery.isFetching,
  )

  createEffect(() => {
    mode()
    setSelectedMemoryPath(undefined)
  })

  const openHistoryMessage = (messageID: string) => {
    navigate(`${location.pathname}#message-${messageID}`)
  }

  const emptyMessage = createMemo(() => {
    if (!debouncedQuery().trim()) return language.t("session.memory.search.placeholder")
    if (loading()) return language.t("common.loading")
    if (mode() === "memory" && memoryHits().length === 0) return language.t("session.memory.search.empty")
    if (mode() === "history" && historyHits().length === 0) return language.t("session.history.search.empty")
    return ""
  })

  return (
    <div data-component="memory-search-panel" class="h-full flex flex-col min-h-0 bg-background-stronger">
      <div class="px-3 pt-3 pb-2 shrink-0 flex flex-col gap-2">
        <Tabs variant="pill" value={mode()} onChange={(value) => setMode(value as PanelMode)}>
          <Tabs.List>
            <Tabs.Trigger value="memory" class="flex-1" classes={{ button: "w-full" }} data-testid="memory-mode-memory">
              {language.t("session.memory.tab.memory")}
            </Tabs.Trigger>
            <Tabs.Trigger value="history" class="flex-1" classes={{ button: "w-full" }} data-testid="memory-mode-history">
              {language.t("session.memory.tab.history")}
            </Tabs.Trigger>
          </Tabs.List>
        </Tabs>
        <div data-testid="memory-search-input">
          <TextField
            variant="ghost"
            hideLabel
            label={language.t("session.memory.search.label")}
            placeholder={language.t("session.memory.search.label")}
            value={query()}
            onChange={setQuery}
          />
        </div>
      </div>

      <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
        <Show when={emptyMessage()}>
          <div class="px-3 py-4 text-12-regular text-text-weak">{emptyMessage()}</div>
        </Show>

        <Show when={mode() === "memory" && memoryHits().length > 0}>
          <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-3" data-testid="memory-search-results">
            <For each={memoryHits()}>
              {(hit) => (
                <button
                  type="button"
                  data-testid="memory-search-result"
                  class="w-full text-left rounded-md px-2 py-2 hover:bg-surface-base-hover"
                  classList={{ "bg-surface-base-hover": selectedMemoryPath() === hit.path }}
                  onClick={() => setSelectedMemoryPath(hit.path)}
                >
                  <div class="text-12-medium text-text-strong truncate">{memoryLabel(hit)}</div>
                  <div class="text-11-regular text-text-weak truncate">
                    {hit.scope}
                    {hit.scope_id ? ` / ${hit.scope_id}` : ""} · {hit.type}
                  </div>
                  <div class="text-11-regular text-text-weak mt-1 line-clamp-2">
                    {hit.snippet.replace(/<<|>>/g, "")}
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={mode() === "history" && historyHits().length > 0}>
          <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-3" data-testid="history-search-results">
            <For each={historyHits()}>
              {(hit) => (
                <button
                  type="button"
                  data-testid="history-search-result"
                  class="w-full text-left rounded-md px-2 py-2 hover:bg-surface-base-hover"
                  onClick={() => openHistoryMessage(hit.message_id)}
                >
                  <div class="text-12-medium text-text-strong truncate">{hit.kind}</div>
                  <div class="text-11-regular text-text-weak truncate">
                    {hit.tool_name ?? language.t("session.history.search.noTool")}
                  </div>
                  <div class="text-11-regular text-text-weak mt-1 line-clamp-2">
                    {hit.snippet.replace(/<<|>>/g, "")}
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={selectedMemoryPath() && previewQuery.data}>
          <div class="shrink-0 max-h-[45%] border-t border-border-weaker-base overflow-hidden flex flex-col">
            <div class="px-3 py-2 text-11-medium text-text-weak">{language.t("session.memory.preview")}</div>
            <pre
              data-testid="memory-search-preview"
              class="flex-1 min-h-0 overflow-auto px-3 pb-3 text-11-regular text-text-base whitespace-pre-wrap font-mono"
            >
              {previewQuery.data}
            </pre>
          </div>
        </Show>
      </div>
    </div>
  )
}
