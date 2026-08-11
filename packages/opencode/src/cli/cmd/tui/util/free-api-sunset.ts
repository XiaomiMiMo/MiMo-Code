import { createSignal, onCleanup } from "solid-js"
import { FREE_API_SUNSET_AT, isFreeApiModel, isFreeApiSunset } from "@/util/free-api-sunset"

export { FREE_API_SUNSET_AT, isFreeApiModel, isFreeApiSunset }

export function shouldBlockFreeApiRequest(
  model: { providerID: string; modelID: string } | undefined,
  options: { sunset?: boolean; localOnly?: boolean; shell?: boolean } = {},
) {
  if (!(options.sunset ?? isFreeApiSunset())) return false
  if (!isFreeApiModel(model)) return false
  return !options.localOnly && !options.shell
}

export function freeApiModelNameKey(sunset = isFreeApiSunset()) {
  return sunset ? ("tui.model.mimo_auto.sunset_name" as const) : ("tui.model.mimo_auto.name" as const)
}

export function createFreeApiSunsetSignal(
  now = Date.now(),
  timer: {
    set(callback: () => void, delay: number): ReturnType<typeof setTimeout>
    clear(handle: ReturnType<typeof setTimeout>): void
  } = {
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle),
  },
) {
  const [sunset, setSunset] = createSignal(isFreeApiSunset(now))
  if (sunset()) return sunset
  const timeout = timer.set(() => setSunset(true), FREE_API_SUNSET_AT - now)
  onCleanup(() => timer.clear(timeout))
  return sunset
}
