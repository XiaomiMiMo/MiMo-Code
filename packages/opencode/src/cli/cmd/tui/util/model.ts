import type { AssistantMessage, Config, Message, Model, Provider } from "@mimo-ai/sdk/v2"
import { contextWindow as overflowWindow } from "@/session/overflow"
import { Locale, Token } from "@/util"

type Selection = {
  providerID: string
  modelID: string
}

export function index(list: Provider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

export function get(list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string, modelID: string) {
  const provider =
    list instanceof Map
      ? list.get(providerID)
      : Array.isArray(list)
        ? list.find((item) => item.id === providerID)
        : undefined
  return provider?.models[modelID]
}

export function name(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string,
  modelID: string,
) {
  return get(list, providerID, modelID)?.name ?? modelID
}

export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function initial(
  list: Provider[] | undefined,
  input: {
    argument?: string
    ready: boolean
    recent: Selection[]
    configured?: string
  },
) {
  // An explicit CLI choice is available immediately. Wait for persisted state
  // before choosing between the last TUI choice and the configured default.
  return [
    ...(input.argument ? [parse(input.argument)] : []),
    ...(input.ready ? input.recent : []),
    ...(input.ready && input.configured ? [parse(input.configured)] : []),
  ].find((item) => get(list, item.providerID, item.modelID))
}

/**
 * Provider cap, configured budget and compaction trigger for a model. Shares the
 * server's arithmetic so what the UI shows is the value that actually fires
 * compaction. The SDK mirrors of Config/Model carry every field the calculation
 * reads, so the cast is a structural narrowing, not a lie.
 */
export function contextWindow(config: Config | undefined, model: Model | undefined) {
  if (!model || !config) return undefined
  const result = overflowWindow({ cfg: config as never, model: model as never })
  // usable can legitimately reach 0 (window smaller than the reserves, or a large
  // compaction.reserved). Callers divide by it, so treat that as "unknown window".
  return result.hard === 0 || result.usable === 0 ? undefined : result
}

/** Window shape from `contextWindow` / the server's overflow arithmetic. */
export type ContextWindow = ReturnType<typeof overflowWindow>

/**
 * Compute the footer's context-fill readout and cumulative cost from the main
 * message list. Pure and render-free so it can be unit-tested below the SolidJS
 * memo in prompt/index.tsx (which has no render harness).
 *
 * The context number reads the LAST completed assistant turn's usage record —
 * the same source the server's overflow/compaction TRIGGER uses
 * (session/overflow.ts `isOverflow` over `MessageV2.Assistant["tokens"]`, fed by
 * prompt.ts `lastFinished.tokens`). There is deliberately no second estimator:
 * a manual /rebuild inserts only a checkpoint-boundary message and produces no
 * new usage record, so re-tokenizing the trimmed transcript here would show a
 * number that disagrees with the trigger and then jumps to a different measured
 * value on the next turn. Instead, when the newest measured assistant turn is
 * OLDER than the most recent rebuild boundary, the measured figure is stale, so
 * we report `pending: true` rather than repeat the pre-rebuild fill. The number
 * refreshes for real on the next assistant turn (whose id sorts after the
 * boundary). Cost is a cumulative sum over all assistant turns and is unaffected
 * by the boundary — the whole point of /rebuild is to drop context, not cost.
 */
export function computeContextUsage(input: {
  messages: Message[]
  window: ContextWindow | undefined
  /** True when the message with this id carries a `checkpoint` (rebuild) part. */
  hasCheckpoint: (messageID: string) => boolean
}): { context: string; cost: number; pending: boolean } | undefined {
  const { messages, window: win, hasCheckpoint } = input
  const last = messages.findLast(
    (m): m is AssistantMessage => m.role === "assistant" && m.tokens.output > 0,
  )
  if (!last) return undefined

  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  if (tokens <= 0) return undefined

  const cost = messages.reduce((sum, m) => sum + (m.role === "assistant" ? m.cost : 0), 0)

  // Ascending message ids are timestamp-monotonic, so a boundary id greater than
  // the last measured assistant id means the rebuild happened after that turn.
  const boundary = messages.findLast((m) => hasCheckpoint(m.id))
  const pending = !!boundary && boundary.id > last.id
  if (pending) {
    return { context: "…", cost, pending: true }
  }

  const context = win
    ? // Denominator is the compaction trigger, not the raw window — otherwise the
      // percentage never reaches 100% and a configured budget looks ignored.
      `${Locale.number(tokens)}/${Token.format(win.usable)}${win.source === "config" ? "↓" : ""} (${Math.round(
        (tokens / win.usable) * 100,
      )}%)`
    : Locale.number(tokens)
  return { context, cost, pending: false }
}
