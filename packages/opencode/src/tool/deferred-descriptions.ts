/**
 * 延迟加载工具描述模块
 *
 * 核心思想：工具描述消耗 context tokens，即使工具未被使用。
 * 通过延迟加载完整描述直到工具实际被调用，可以节省大量 context 空间。
 *
 * 参考 Claude Code 的 deferred loading 策略：
 * - MCP 工具：仅名称消耗 context，使用时才加载完整描述
 * - Skills：描述在 session 启动时加载，完整内容按需加载
 */

import type { Agent } from "@/agent/agent"
import { Effect } from "effect"

/**
 * 工具描述的简化版本，仅包含名称和简短描述
 * 用于 context 中的初始注入，节省 token
 */
export interface ToolSummary {
  id: string
  name: string
  shortDescription: string
  category: "file" | "search" | "execute" | "web" | "agent" | "other"
}

/**
 * 工具描述的完整版本，包含详细说明和参数 schema
 * 用于工具实际被调用时的完整描述
 */
export interface ToolFullDescription {
  id: string
  description: string
  parameters: Record<string, unknown>
  examples?: string[]
}

/**
 * 工具分类和简短描述映射
 * 基于 Claude Code 的工具分类策略
 */
const TOOL_SUMMARIES: Record<string, ToolSummary> = {
  bash: {
    id: "bash",
    name: "Bash",
    shortDescription: "Execute shell commands",
    category: "execute",
  },
  read: {
    id: "read",
    name: "Read",
    shortDescription: "Read file contents",
    category: "file",
  },
  edit: {
    id: "edit",
    name: "Edit",
    shortDescription: "Edit files with exact string replacement",
    category: "file",
  },
  write: {
    id: "write",
    name: "Write",
    shortDescription: "Create or overwrite files",
    category: "file",
  },
  glob: {
    id: "glob",
    name: "Glob",
    shortDescription: "Find files by pattern",
    category: "search",
  },
  grep: {
    id: "grep",
    name: "Grep",
    shortDescription: "Search file contents with regex",
    category: "search",
  },
  actor: {
    id: "actor",
    name: "Actor",
    shortDescription: "Spawn subagent for parallel work",
    category: "agent",
  },
  task: {
    id: "task",
    name: "Task",
    shortDescription: "Manage task list and progress",
    category: "agent",
  },
  skill: {
    id: "skill",
    name: "Skill",
    shortDescription: "Load specialized skill instructions",
    category: "agent",
  },
  webfetch: {
    id: "webfetch",
    name: "WebFetch",
    shortDescription: "Fetch and extract web content",
    category: "web",
  },
  websearch: {
    id: "websearch",
    name: "WebSearch",
    shortDescription: "Search the web",
    category: "web",
  },
  memory: {
    id: "memory",
    name: "Memory",
    shortDescription: "Search and manage persistent memory",
    category: "other",
  },
  plan: {
    id: "plan",
    name: "Plan",
    shortDescription: "Enter/exit plan mode",
    category: "other",
  },
  question: {
    id: "question",
    name: "Question",
    shortDescription: "Ask user a question",
    category: "other",
  },
  workflow: {
    id: "workflow",
    name: "Workflow",
    shortDescription: "Run predefined workflow",
    category: "agent",
  },
}

/**
 * 生成工具摘要列表，用于 context 注入
 * 仅包含工具名称和简短描述，不包含完整参数 schema
 */
export function generateToolSummaries(toolIds: string[]): ToolSummary[] {
  return toolIds
    .map((id) => TOOL_SUMMARIES[id])
    .filter(Boolean)
}

/**
 * 生成工具摘要的文本格式，用于注入到 system prompt
 * 格式：按类别分组，每行一个工具
 */
export function formatToolSummariesForPrompt(summaries: ToolSummary[]): string {
  const grouped = summaries.reduce(
    (acc, s) => {
      acc[s.category] = acc[s.category] || []
      acc[s.category].push(s)
      return acc
    },
    {} as Record<string, ToolSummary[]>,
  )

  const categoryLabels: Record<string, string> = {
    file: "File Operations",
    search: "Search & Discovery",
    execute: "Execution",
    web: "Web Access",
    agent: "Agent Orchestration",
    other: "Other Tools",
  }

  const lines: string[] = ["Available tools (use ToolSearch to load full description when needed):"]

  for (const [category, tools] of Object.entries(grouped)) {
    lines.push("")
    lines.push(`## ${categoryLabels[category] || category}`)
    for (const tool of tools) {
      lines.push(`- ${tool.name}: ${tool.shortDescription}`)
    }
  }

  lines.push("")
  lines.push("Use ToolSearch with query 'select:<tool_name>' to load full tool description before calling.")

  return lines.join("\n")
}

/**
 * 生成紧凑的工具列表，用于最小化 context 消耗
 * 仅包含工具名称，用于不需要详细描述的场景
 */
export function generateCompactToolList(toolIds: string[]): string {
  return toolIds.join(", ")
}
