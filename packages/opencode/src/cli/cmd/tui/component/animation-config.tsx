import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { useLanguage } from "../context/language"

export type AnimationConfig = {
  enabled: boolean
  reducedMotion: boolean
  particles: boolean
  transitions: boolean
  effects: boolean
  intensity: "low" | "medium" | "high"
  performance: "low" | "medium" | "high"
}

const DEFAULT_CONFIG: AnimationConfig = {
  enabled: true,
  reducedMotion: false,
  particles: true,
  transitions: true,
  effects: true,
  intensity: "medium",
  performance: "medium",
}

export function useAnimationConfig() {
  const kv = useKV()

  const get = (): AnimationConfig => {
    const stored = kv.get<AnimationConfig>("animation_config")
    return stored ?? DEFAULT_CONFIG
  }

  const set = (config: Partial<AnimationConfig>) => {
    kv.set("animation_config", { ...get(), ...config })
  }

  const isAnimationAllowed = (type: "particles" | "transitions" | "effects"): boolean => {
    const config = get()
    if (!config.enabled) return false
    if (config.reducedMotion) return false
    return config[type]
  }

  const getPerformanceMultiplier = (): number => {
    const config = get()
    switch (config.performance) {
      case "low":
        return 0.5
      case "medium":
        return 1
      case "high":
        return 1.5
      default:
        return 1
    }
  }

  return {
    get,
    set,
    isAnimationAllowed,
    getPerformanceMultiplier,
  }
}

export function AnimationSettings() {
  const { theme } = useTheme()
  const t = useLanguage().t
  const [config, setConfig] = useAnimationConfig()

  const toggleEnabled = () => {
    setConfig({ enabled: !config().enabled })
  }

  const toggleReducedMotion = () => {
    setConfig({ reducedMotion: !config().reducedMotion })
  }

  const toggleParticles = () => {
    setConfig({ particles: !config().particles })
  }

  const toggleTransitions = () => {
    setConfig({ transitions: !config().transitions })
  }

  const toggleEffects = () => {
    setConfig({ effects: !config().effects })
  }

  const cyclePerformance = () => {
    const current = config().performance
    const next = current === "low" ? "medium" : current === "medium" ? "high" : "low"
    setConfig({ performance: next })
  }

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <text fg={theme.text} bold>
        {t("tui.settings.animation.title")}
      </text>
      
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>Enable animations:</text>
        <text
          fg={config().enabled ? theme.success : theme.error}
          onClick={toggleEnabled}
        >
          {config().enabled ? "ON" : "OFF"}
        </text>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>Reduced motion:</text>
        <text
          fg={config().reducedMotion ? theme.warning : theme.text}
          onClick={toggleReducedMotion}
        >
          {config().reducedMotion ? "ON" : "OFF"}
        </text>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>Particles:</text>
        <text
          fg={config().particles ? theme.success : theme.error}
          onClick={toggleParticles}
        >
          {config().particles ? "ON" : "OFF"}
        </text>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>Transitions:</text>
        <text
          fg={config().transitions ? theme.success : theme.error}
          onClick={toggleTransitions}
        >
          {config().transitions ? "ON" : "OFF"}
        </text>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>Effects:</text>
        <text
          fg={config().effects ? theme.success : theme.error}
          onClick={toggleEffects}
        >
          {config().effects ? "ON" : "OFF"}
        </text>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>Performance:</text>
        <text
          fg={theme.primary}
          onClick={cyclePerformance}
        >
          {config().performance.toUpperCase()}
        </text>
      </box>
    </box>
  )
}

export function AnimationPerformanceIndicator() {
  const { theme } = useTheme()
  const [config] = useAnimationConfig()
  const [fps, setFps] = createSignal(60)
  let lastTime = performance.now()
  let frameCount = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let rafFrame: number | undefined

  onMount(() => {
    timer = setInterval(() => {
      const now = performance.now()
      const delta = now - lastTime
      if (delta >= 1000) {
        setFps(Math.round((frameCount * 1000) / delta))
        frameCount = 0
        lastTime = now
      }
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

  const color = () => {
    const currentFps = fps()
    if (currentFps >= 50) return theme.success
    if (currentFps >= 30) return theme.warning
    return theme.error
  }

  const shouldReduce = () => {
    return fps() < 30 && config().performance !== "low"
  }

  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text fg={theme.textMuted}>FPS:</text>
      <text fg={color()}>{fps()}</text>
      <Show when={shouldReduce()}>
        <text fg={theme.warning}>⚠ Low FPS</text>
      </Show>
    </box>
  )
}
