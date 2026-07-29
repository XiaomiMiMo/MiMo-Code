import type { Config, Model, Provider } from "@mimo-ai/sdk/v2"
import { contextWindow as overflowWindow } from "@/session/overflow"

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
