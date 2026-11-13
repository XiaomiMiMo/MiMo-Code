import type { AssistantMessage } from "@mimo-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { completedTPS, formatTPS, streamingTPS } from "./tps"
import * as Model from "@tui/util/model"
import { Token } from "@/util"

const id = "internal:sidebar-context"
const REFRESH_MS = 1000

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const compactCount = (count: number) => (count > 99 ? "99+" : count.toString())

export function ContextSidebar(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const vectorActivity = createMemo(() => {
    let memory = 0
    let history = 0
    let injected = 0
    const messages = msg()
    const parts = messages.flatMap((item) => props.api.state.part(item.id))
    for (const part of parts) {
      if (part.type === "tool" && part.state.status === "completed") {
        const count = part.state.metadata?.vectorSemanticHits
        if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue
        if (part.tool === "memory") memory = Math.min(100, memory + Math.floor(count))
        if (part.tool === "history") history = Math.min(100, history + Math.floor(count))
      }
      if (part.type === "text" && part.synthetic && !part.ignored) {
        const origin = part.metadata?.retrievalOrigin
        if (origin === "memory.hybridSearch" || origin === "history.hybridSearch" || origin === "memory.rebuild") {
          injected = Math.min(100, injected + 1)
        }
      }
    }
    return { memory, history, injected }
  })
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))

  const [tick, setTick] = createSignal(Date.now())

  const lastAssistant = createMemo(() =>
    msg().findLast((item): item is AssistantMessage => item.role === "assistant"),
  )

  const isStreaming = createMemo(() => {
    const m = lastAssistant()
    return m !== undefined && !m.time.completed
  })

  createEffect(() => {
    if (!isStreaming()) return
    const handle = setInterval(() => setTick(Date.now()), REFRESH_MS)
    onCleanup(() => clearInterval(handle))
  })

  const tps = createMemo<number | null>(() => {
    const m = lastAssistant()
    if (!m) return null

    if (isStreaming()) {
      tick() // reactivity dep so the readout updates between deltas
      const parts = props.api.state.part(m.id)
      const combined = parts
        .filter((p) => p.type === "text" || p.type === "reasoning")
        .map((p) => p.text)
        .join("")
      return streamingTPS(combined, m.time.created, Date.now())
    }

    const idleTarget = msg().findLast(
      (item): item is AssistantMessage =>
        item.role === "assistant" &&
        item.time.completed !== undefined &&
        item.tokens.output + item.tokens.reasoning > 0,
    )
    if (!idleTarget || idleTarget.time.completed === undefined) return null
    return completedTPS(
      idleTarget.tokens.output,
      idleTarget.tokens.reasoning,
      idleTarget.time.created,
      idleTarget.time.completed,
    )
  })

  const tpsLabel = createMemo(() => formatTPS(tps()))

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
        limit: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const win = Model.contextWindow(props.api.state.config, model)
    return {
      tokens,
      percent: win ? Math.round((tokens / win.effective) * 100) : null,
      limit: win,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <Show when={state().limit}>
        {(win) => (
          <text fg={theme().textMuted}>
            limit {Token.format(win().effective)}
            {win().source === "config" ? ` of ${Token.format(win().hard)}` : ""}
          </text>
        )}
      </Show>
      <Show when={tpsLabel()}>{(label) => <text fg={theme().textMuted}>{label()}</text>}</Show>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
      <text fg={theme().text}>Vector hits / injections</text>
      <text fg={theme().textMuted}>
        {`Mem ${compactCount(vectorActivity().memory)} · Hist ${compactCount(vectorActivity().history)} · Inject ${compactCount(vectorActivity().injected)}`}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <ContextSidebar api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
