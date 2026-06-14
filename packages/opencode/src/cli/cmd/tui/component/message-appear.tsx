import { createSignal, onMount, onCleanup, type JSX } from "solid-js"
import { RGBA } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { easing } from "../util/animation"

export function MessageAppear(props: {
  children: JSX.Element
  delay?: number
  duration?: number
  direction?: "up" | "down" | "left" | "right"
  distance?: number
  onComplete?: () => void
}) {
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const [opacity, setOpacity] = createSignal(animationsEnabled() ? 0 : 1)
  const [offsetY, setOffsetY] = createSignal(0)
  const [mounted, setMounted] = createSignal(false)

  const duration = props.duration ?? 200
  const delay = props.delay ?? 0
  const distance = props.distance ?? 2

  onMount(() => {
    setMounted(true)
    if (!animationsEnabled()) {
      setOpacity(1)
      props.onComplete?.()
      return
    }

    const direction = props.direction ?? "up"
    const startTime = performance.now() + delay
    let frame: number | undefined

    const tick = (time: number) => {
      if (!mounted()) return
      const elapsed = time - startTime
      if (elapsed < 0) {
        frame = requestAnimationFrame(tick)
        return
      }

      const t = Math.min(1, elapsed / duration)
      const easedT = easing.easeOutCubic(t)

      setOpacity(easedT)

      if (direction === "up") {
        setOffsetY(Math.round((1 - easedT) * distance))
      } else if (direction === "down") {
        setOffsetY(-Math.round((1 - easedT) * distance))
      }

      if (t < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        props.onComplete?.()
      }
    }

    frame = requestAnimationFrame(tick)
    onCleanup(() => {
      if (frame) cancelAnimationFrame(frame)
    })
  })

  return (
    <box
      paddingTop={offsetY() > 0 ? offsetY() : 0}
      paddingBottom={offsetY() < 0 ? -offsetY() : 0}
    >
      {props.children}
    </box>
  )
}

export function TypingIndicator(props: {
  color?: RGBA
  dotCount?: number
  speed?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const dotCount = props.dotCount ?? 3
  const speed = props.speed ?? 150
  const color = () => props.color ?? theme.textMuted

  const [activeDot, setActiveDot] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) return
    timer = setInterval(() => {
      setActiveDot((prev) => (prev + 1) % (dotCount + 2))
    }, speed)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box flexDirection="row" gap={1}>
      {Array.from({ length: dotCount }, (_, i) => (
        <text
          fg={color()}
          opacity={animationsEnabled() ? (activeDot() === i ? 1 : 0.3) : 1}
          bold={activeDot() === i}
        >
          ●
        </text>
      ))}
    </box>
  )
}

export function ProgressBar(props: {
  progress: () => number
  width?: number
  color?: RGBA
  backgroundColor?: RGBA
  showPercentage?: boolean
  animated?: boolean
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const width = props.width ?? 20
  const color = () => props.color ?? theme.primary
  const bgColor = () => props.backgroundColor ?? theme.backgroundElement
  const showPercentage = props.showPercentage ?? true
  const animated = props.animated ?? true

  const [displayProgress, setDisplayProgress] = createSignal(props.progress())
  let frame: number | undefined

  onMount(() => {
    if (!animated || !animationsEnabled()) {
      setDisplayProgress(props.progress())
      return
    }

    const tick = () => {
      const target = props.progress()
      const current = displayProgress()
      const diff = target - current
      if (Math.abs(diff) < 0.001) {
        setDisplayProgress(target)
      } else {
        setDisplayProgress(current + diff * 0.1)
      }
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
  })

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame)
  })

  const filledWidth = Math.round(width * displayProgress())
  const emptyWidth = width - filledWidth

  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text fg={bgColor()}>
        {"█".repeat(filledWidth)}
      </text>
      <text fg={theme.background}>
        {"░".repeat(emptyWidth)}
      </text>
      {showPercentage && (
        <text fg={theme.textMuted}>
          {Math.round(displayProgress() * 100)}%
        </text>
      )}
    </box>
  )
}

export function PulseGlow(props: {
  children: JSX.Element
  color?: RGBA
  intensity?: number
  speed?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const color = () => props.color ?? theme.primary
  const intensity = props.intensity ?? 0.3
  const speed = props.speed ?? 1000

  const [glow, setGlow] = createSignal(0)
  let frame: number | undefined

  onMount(() => {
    if (!animationsEnabled()) {
      setGlow(intensity)
      return
    }

    const tick = () => {
      const t = (performance.now() % speed) / speed
      setGlow(intensity * (0.5 + 0.5 * Math.sin(t * Math.PI * 2)))
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
  })

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame)
  })

  return (
    <box
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      {props.children}
    </box>
  )
}

export function SlideIn(props: {
  children: JSX.Element
  direction?: "left" | "right" | "up" | "down"
  duration?: number
  delay?: number
  distance?: number
  onComplete?: () => void
}) {
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const direction = props.direction ?? "right"
  const duration = props.duration ?? 300
  const delay = props.delay ?? 0
  const distance = props.distance ?? 10

  const [offsetY, setOffsetY] = createSignal(0)
  const [mounted, setMounted] = createSignal(false)

  onMount(() => {
    setMounted(true)
    if (!animationsEnabled()) {
      setOffsetY(0)
      props.onComplete?.()
      return
    }

    if (direction === "up") setOffsetY(-distance)
    else if (direction === "down") setOffsetY(distance)

    const startTime = performance.now() + delay
    let frame: number | undefined

    const tick = (time: number) => {
      if (!mounted()) return
      const elapsed = time - startTime
      if (elapsed < 0) {
        frame = requestAnimationFrame(tick)
        return
      }

      const t = Math.min(1, elapsed / duration)
      const easedT = easing.easeOutCubic(t)

      if (direction === "up") {
        setOffsetY(-distance * (1 - easedT))
      } else if (direction === "down") {
        setOffsetY(distance * (1 - easedT))
      }

      if (t < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        props.onComplete?.()
      }
    }

    frame = requestAnimationFrame(tick)
    onCleanup(() => {
      if (frame) cancelAnimationFrame(frame)
    })
  })

  return (
    <box
      paddingTop={offsetY() > 0 ? offsetY() : 0}
      paddingBottom={offsetY() < 0 ? -offsetY() : 0}
    >
      {props.children}
    </box>
  )
}
