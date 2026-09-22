import type { ModelMessage, Tool } from "ai"
import { Flag } from "@/flag/flag"
import { type HarnessMode, usesGPTToolset } from "./gpt"

export type NamedTool = Tool & { modelName?: string }

const defaults = new Map([
  ["read", "Read"],
  ["grep", "Grep"],
  ["glob", "Glob"],
  ["edit", "Edit"],
  ["write", "Write"],
  ["bash", "Bash"],
  ["notebook_edit", "NotebookEdit"],
  ["actor", "Actor"],
  ["task", "Task"],
  ["session", "Session"],
  ["memory", "Memory"],
  ["history", "History"],
  ["skill", "Skill"],
  ["skill_search", "SkillSearch"],
  ["question", "Question"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["codesearch", "CodeSearch"],
  ["lsp", "LSP"],
  ["plan_exit", "PlanExit"],
  ["cron", "Cron"],
  ["workflow", "Workflow"],
])

export function defaultToolName(id: string) {
  return defaults.get(id)
}

export function usesPascalCaseTools(modelID: string, harness?: HarnessMode, apiModelID?: string, family?: string) {
  if (usesGPTToolset(modelID, harness, apiModelID, family)) return false
  return Flag.MIMOCODE_PASCAL_CASE_TOOLS ?? [modelID, apiModelID].some((id) => id?.toLowerCase().includes("mimo-v2.6"))
}

/** Project the known internal names without changing persisted tool IDs. */
export function toolSurface(input: Record<string, NamedTool>) {
  const names = new Map(Object.entries(input).map(([id, item]) => [id, item.modelName ?? id]))
  const canonical = new Map([...names].map(([id, name]) => [name, id]))
  const name = (id: string) => names.get(id) ?? id
  const id = (name: string) => canonical.get(name) ?? name

  function restore<T extends object>(event: T): T {
    if ("toolName" in event && typeof event.toolName === "string") {
      return { ...event, toolName: id(event.toolName) }
    }
    if ("toolCall" in event && event.toolCall && typeof event.toolCall === "object") {
      return { ...event, toolCall: restore(event.toolCall) }
    }
    return event
  }

  function project<T extends { type: string }>(part: T): T {
    if (
      (part.type === "tool-call" || part.type === "tool-result") &&
      "toolName" in part &&
      typeof part.toolName === "string"
    ) {
      return { ...part, toolName: name(part.toolName) }
    }
    return part
  }

  return {
    name,
    id,
    restore,
    tools: (tools: Record<string, NamedTool>) =>
      Object.fromEntries(Object.entries(tools).map(([id, item]) => [name(id), item])),
    messages: (messages: ModelMessage[]): ModelMessage[] =>
      messages.map((message) => {
        if (message.role === "assistant" && typeof message.content !== "string") {
          return { ...message, content: message.content.map(project) }
        }
        if (message.role === "tool") return { ...message, content: message.content.map(project) }
        return message
      }),
  }
}
