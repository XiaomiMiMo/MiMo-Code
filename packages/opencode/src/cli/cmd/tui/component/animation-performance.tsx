import { createSignal, createMemo, onMount, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { useLanguage } from "../context/language"

export type PerformanceMetrics = {
  fps: number
  frameTime: number
  memoryUsage: number
  animationCount: number
  renderTime: number
}

export function useAnimationPerformance() {
  const [metrics, setMetrics] = createSignal<PerformanceMetrics>({
    fps: 60,
    frameTime: 16.67,
    memoryUsage: 0,
    animationCount: 0,
    renderTime: 0,
  })

  let lastTime = performance.now()
  let frameCount = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let rafFrame: number | undefined

  onMount(() => {
    timer = setInterval(() => {
      const now = performance.now()
      const delta = now - lastTime
      const fps = Math.round((frameCount * 1000) / delta)
      const frameTime = delta / Math.max(1, frameCount)

      setMetrics({
        fps,
        frameTime: Math.round(frameTime * 100) / 100,
        memoryUsage: (performance as any).memory?.usedJSHeapSize ?? 0,
        animationCount: document.querySelectorAll("[data-animation]").length,
        renderTime: Math.round(frameTime * 100) / 100,
      })

      frameCount = 0
      lastTime = now
    }, 1000)

    const tick = () => {
      frameCount++
      rafFrame = requestAnimationFrame(tick)
    }
    rafFrame = requestAnimationFrame(tick)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
    if (rafFrame) cancelAnimationFrame(rafFrame)
  })

  return metrics
}

export function PerformanceMonitor(props: { visible?: boolean }) {
  const { theme } = useTheme()
  const metrics = useAnimationPerformance()
  const [expanded, setExpanded] = createSignal(false)

  const fpsColor = createMemo(() => {
    const fps = metrics().fps
    if (fps >= 50) return theme.success
    if (fps >= 30) return theme.warning
    return theme.error
  })

  const frameTimeColor = createMemo(() => {
    const frameTime = metrics().frameTime
    if (frameTime <= 16.67) return theme.success
    if (frameTime <= 33.33) return theme.warning
    return theme.error
  })

  const memoryColor = createMemo(() => {
    const memory = metrics().memoryUsage / 1024 / 1024
    if (memory <= 50) return theme.success
    if (memory <= 100) return theme.warning
    return theme.error
  })

  return (
    <Show when={props.visible ?? false}>
      <box
        position="absolute"
        top={1}
        right={1}
        zIndex={1000}
        backgroundColor={theme.backgroundPanel}
        borderStyle="round"
        padding={1}
        minWidth={20}
      >
        <box
          flexDirection="row"
          gap={1}
          alignItems="center"
          onClick={() => setExpanded(!expanded())}
        >
          <text fg={theme.textMuted}>Performance</text>
          <text fg={theme.textMuted}>{expanded() ? "▼" : "▶"}</text>
        </box>

        <Show when={expanded()}>
          <box flexDirection="column" gap={1} marginTop={1}>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>FPS:</text>
              <text fg={fpsColor()}>{metrics().fps}</text>
            </box>

            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>Frame:</text>
              <text fg={frameTimeColor()}>{metrics().frameTime}ms</text>
            </box>

            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>Memory:</text>
              <text fg={memoryColor()}>
                {Math.round(metrics().memoryUsage / 1024 / 1024)}MB
              </text>
            </box>

            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>Animations:</text>
              <text fg={theme.text}>{metrics().animationCount}</text>
            </box>

            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>Render:</text>
              <text fg={theme.text}>{metrics().renderTime}ms</text>
            </box>
          </box>
        </Show>
      </box>
    </Show>
  )
}

export function FpsGraph(props: { visible?: boolean }) {
  const { theme } = useTheme()
  const metrics = useAnimationPerformance()
  const [history, setHistory] = createSignal<number[]>([])

  onMount(() => {
    const timer = setInterval(() => {
      setHistory((prev) => {
        const newHistory = [...prev, metrics().fps]
        if (newHistory.length > 30) newHistory.shift()
        return newHistory
      })
    }, 100)

    onCleanup(() => clearInterval(timer))
  })

  const graphHeight = 5
  const graphWidth = 30

  const graphData = createMemo(() => {
    const h = history()
    if (h.length === 0) return []

    const maxFps = Math.max(...h, 60)
    const minFps = Math.min(...h, 0)
    const range = maxFps - minFps || 1

    return Array.from({ length: graphWidth }, (_, i) => {
      const idx = Math.floor((i / graphWidth) * h.length)
      const value = h[idx] ?? 0
      const normalized = (value - minFps) / range
      return Math.round(normalized * graphHeight)
    })
  })

  return (
    <Show when={props.visible ?? false}>
      <box
        position="absolute"
        top={8}
        right={1}
        zIndex={1000}
        backgroundColor={theme.backgroundPanel}
        borderStyle="round"
        padding={1}
      >
        <text fg={theme.textMuted}>FPS History</text>
        <box flexDirection="column" marginTop={1}>
          {Array.from({ length: graphHeight }, (_, row) => (
            <box flexDirection="row">
              {graphData().map((value) => {
                const filled = value >= graphHeight - row
                return (
                  <text fg={filled ? theme.primary : theme.backgroundElement}>
                    {filled ? "█" : "░"}
                  </text>
                )
              })}
            </box>
          ))}
        </box>
      </box>
    </Show>
  )
}
