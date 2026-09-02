import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../../context/helper"
import { appendFile, writeFile } from "fs/promises"
import type { AgentPart, FilePart, TextPart } from "@mimo-ai/sdk/v2"

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  sessionID?: string
  workspaceID?: string
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

export type PromptHistoryScope = {
  sessionID?: string
  workspaceID?: string
}

const MAX_HISTORY_ENTRIES = 50

export function promptHistoryScopeKey(scope: PromptHistoryScope) {
  if (scope.sessionID) return `session:${scope.sessionID}`
  if (scope.workspaceID) return `workspace:${scope.workspaceID}`
  return "global"
}

export function promptHistoryMatchesScope(entry: PromptInfo, scope: PromptHistoryScope) {
  if (scope.sessionID) return entry.sessionID === scope.sessionID
  if (scope.workspaceID) return entry.workspaceID === scope.workspaceID
  return !entry.sessionID && !entry.workspaceID
}

export function promptHistoryForScope(history: PromptInfo[], scope: PromptHistoryScope) {
  return history.filter((entry) => promptHistoryMatchesScope(entry, scope))
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const historyPath = path.join(Global.Path.state, "prompt-history.jsonl")
    onMount(async () => {
      const text = await Filesystem.readText(historyPath).catch(() => "")
      const lines = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((line): line is PromptInfo => line !== null)
        .slice(-MAX_HISTORY_ENTRIES)

      setStore("history", lines)

      // Rewrite file with only valid entries to self-heal corruption
      if (lines.length > 0) {
        const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n"
        writeFile(historyPath, content).catch(() => {})
      }
    })

    const [store, setStore] = createStore({
      indices: {} as Record<string, number>,
      history: [] as PromptInfo[],
    })

    return {
      move(scope: PromptHistoryScope, direction: 1 | -1, input: string) {
        const scopedHistory = promptHistoryForScope(store.history, scope)
        const key = promptHistoryScopeKey(scope)
        const index = store.indices[key] ?? 0
        if (!scopedHistory.length) return undefined
        const current = scopedHistory.at(index)
        if (!current) return undefined
        if (current.input !== input && input.length) return
        setStore(
          produce((draft) => {
            const next = index + direction
            if (Math.abs(next) > scopedHistory.length) return
            if (next > 0) return
            draft.indices[key] = next
          }),
        )
        if ((store.indices[key] ?? 0) === 0)
          return {
            input: "",
            parts: [],
          }
        return scopedHistory.at(store.indices[key])
      },
      append(scope: PromptHistoryScope, item: PromptInfo) {
        const entry = structuredClone(
          unwrap({
            input: item.input,
            mode: item.mode,
            parts: item.parts,
            sessionID: scope.sessionID,
            workspaceID: scope.workspaceID,
          }),
        )
        const key = promptHistoryScopeKey(scope)
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            if (draft.history.length > MAX_HISTORY_ENTRIES) {
              draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
            draft.indices[key] = 0
          }),
        )

        if (trimmed) {
          const content = store.history.map((line) => JSON.stringify(line)).join("\n") + "\n"
          writeFile(historyPath, content).catch(() => {})
          return
        }

        appendFile(historyPath, JSON.stringify(entry) + "\n").catch(() => {})
      },
    }
  },
})
