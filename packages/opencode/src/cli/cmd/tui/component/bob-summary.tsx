import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { SplitBorder } from "./border"

export interface BobSummaryProps {
  /** Markdown text produced by `buildSummary()`. May be empty when no summary is available. */
  text: string
}

/**
 * Parsed view-model of a Bob Summary block. We extract sections by `###`
 * headings so the TUI can lay them out as labeled rows instead of a single
 * markdown blob — easier to skim in a grid cell.
 */
export interface BobSummaryModel {
  title: string
  caption: string | null
  status: string | null
  reasoning: string | null
  evidence: string[]
  endpoints: Array<{ url: string; port: string; source: string }>
  remaining: string[]
}

const TITLE_RX = /^##\s+(.+?)(?:\s+—\s+(.+))?$/m
const CAPTION_RX = /^\*([^*]+)\*$/m
const STATUS_RX = /^\*\*Status:\*\*\s+(.+)$/m
const SECTION_RX = /###\s+([^\n]+)\n([\s\S]*?)(?=\n###\s+|\n##\s+|$)/g

function parseSummary(text: string): BobSummaryModel | null {
  if (!text.trim()) return null
  const model: BobSummaryModel = {
    title: "Bob Summary",
    caption: null,
    status: null,
    reasoning: null,
    evidence: [],
    endpoints: [],
    remaining: [],
  }
  const titleMatch = text.match(TITLE_RX)
  if (titleMatch) model.title = titleMatch[1].trim()
  const captionMatch = text.match(CAPTION_RX)
  if (captionMatch) model.caption = captionMatch[1].trim()
  const statusMatch = text.match(STATUS_RX)
  if (statusMatch) model.status = statusMatch[1].trim()

  const body = text.replace(TITLE_RX, "").replace(CAPTION_RX, "").replace(STATUS_RX, "")
  let sectionMatch: RegExpExecArray | null
  while ((sectionMatch = SECTION_RX.exec(body)) !== null) {
    const heading = sectionMatch[1].trim().toLowerCase()
    const content = sectionMatch[2].trim()
    if (!content) continue
    if (heading === "reasoning") {
      model.reasoning = content
    } else if (heading === "evidence") {
      model.evidence = content
        .split("\n")
        .map((l) => l.replace(/^[-*]\s+/, "").trim())
        .filter(Boolean)
    } else if (heading === "open endpoints") {
      model.endpoints = parseEndpointRows(content)
    } else if (heading === "remaining items") {
      model.remaining = content
        .split("\n")
        .map((l) => l.replace(/^[-*]\s+/, "").trim())
        .filter(Boolean)
    }
  }
  return model
}

function parseEndpointRows(block: string): Array<{ url: string; port: string; source: string }> {
  const lines = block.split("\n").filter((l) => l.trim() && !l.startsWith("| ---"))
  return lines
    .map((line) => line.split("|").map((c) => c.trim()))
    .filter((cols) => cols.length >= 4)
    .map((cols) => ({
      url: cols[1]?.replace(/`/g, "") ?? "",
      port: cols[2] ?? "",
      source: cols[3] ?? "",
    }))
    .filter((r) => r.url)
}

/**
 * Renders a Bob completion summary as a stylized card. Used as a message-part
 * renderer in both the legacy single-session route and the grid `SessionCell`.
 *
 * Visual layout:
 *  ┌─ Bob Summary ──────────────────────────┐
 *  │ [STATUS]   session caption              │
 *  │                                           │
 *  │ Reasoning: ...                            │
 *  │ Evidence:                                 │
 *  │   - ...                                   │
 *  │ Open endpoints:                           │
 *  │   http://localhost:3000   3000  bash      │
 *  │ Remaining items:                          │
 *  │   - ...                                   │
 *  └──────────────────────────────────────────┘
 */
export function BobSummaryPart(props: BobSummaryProps) {
  const { theme } = useTheme()
  const model = createMemo(() => parseSummary(props.text))
  const statusColor = createMemo(() => {
    const s = model()?.status?.toLowerCase() ?? ""
    if (s.includes("rejected")) return theme.error
    if (s.includes("accepted") || s.includes("completed")) return theme.success
    return theme.textMuted
  })

  return (
    <Show when={model()}>
      {(m) => (
        <box
          border={["left"]}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.primary}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          flexShrink={0}
          flexDirection="column"
          gap={1}
        >
          <box flexDirection="row" gap={1} justifyContent="space-between">
            <text fg={theme.text}>
              <b>{m().title}</b>
            </text>
            <Show when={m().status}>
              <text fg={statusColor()}>
                <b>{m().status}</b>
              </text>
            </Show>
          </box>
          <Show when={m().caption}>
            <text fg={theme.textMuted}>{m().caption}</text>
          </Show>

          <Show when={m().reasoning}>
            <box flexDirection="column">
              <text fg={theme.text}>
                <b>Reasoning</b>
              </text>
              <text fg={theme.text} wrapMode="word">
                {m().reasoning}
              </text>
            </box>
          </Show>

          <Show when={m().evidence.length > 0}>
            <box flexDirection="column">
              <text fg={theme.text}>
                <b>Evidence</b>
              </text>
              <For each={m().evidence}>{(item) => <text fg={theme.textMuted}>- {item}</text>}</For>
            </box>
          </Show>

          <Show when={m().endpoints.length > 0}>
            <box flexDirection="column">
              <text fg={theme.text}>
                <b>Open endpoints</b>
              </text>
              <For each={m().endpoints}>
                {(row) => (
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.accent }}>{row.url}</span>
                    <span style={{ fg: theme.textMuted }}> :{row.port}</span>
                    <span style={{ fg: theme.textMuted }}> ({row.source})</span>
                  </text>
                )}
              </For>
            </box>
          </Show>

          <Show when={m().remaining.length > 0}>
            <box flexDirection="column">
              <text fg={theme.text}>
                <b>Remaining items</b>
              </text>
              <For each={m().remaining}>{(item) => <text fg={theme.textMuted}>- {item}</text>}</For>
            </box>
          </Show>
        </box>
      )}
    </Show>
  )
}
