export const RETURN_STATUSES = ["success", "partial", "failed", "blocked"] as const
export type ReturnStatus = (typeof RETURN_STATUSES)[number]

export interface ParsedReturnHeader {
  status?: ReturnStatus
  summary?: string
}

const STATUS_RE = /^\s*\*\*Status\*\*:\s*(success|partial|failed|blocked)\b/im
const SUMMARY_RE = /\*\*Summary\*\*:\s*(.+)$/im

// Parse the **Status**/**Summary** header a subagent is asked to emit
// (see RETURN_FORMAT_INSTRUCTION in spawn.ts). Missing/malformed → {}.
export function parseReturnHeader(finalText: string | undefined): ParsedReturnHeader {
  if (!finalText) return {}
  const status = finalText.match(STATUS_RE)?.[1]?.toLowerCase() as ReturnStatus | undefined
  const summary = finalText.match(SUMMARY_RE)?.[1]?.trim()
  return {
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
  }
}

export * as ReturnHeader from "./return-header"
