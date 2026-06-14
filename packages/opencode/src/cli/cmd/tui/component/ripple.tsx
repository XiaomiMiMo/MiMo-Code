import { createSignal, For, onMount, onCleanup } from "solid-js"
import { RGBA } from "@opentui/core"
import { useTheme, tint } from "../context/theme"
import { useKV } from "../context/kv"
import { easing } from "../util/animation"
import type { JSX } from "@opentui/solid"

type Ripple = {
  id: number
  x: number
  y: number
  startTime: number
  color: RGBA
}

export function RippleEffect(props: {
  x: () => number
  y: () => number
  trigger?: () => boolean
  color?: RGBA
  duration?: number
  maxRadius?: number
  intensity?: number
  enabled?: boolean
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true) && (props.enabled ?? true)
  const duration = props.duration ?? 800
  const maxRadius = props.maxRadius ?? 5
  const intensity = props.intensity ?? 0.5

  const [ripples, setRipples] = createSignal<Ripple[]>([])
  let idCounter = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const addRipple = () => {
    if (!animationsEnabled()) return
    const rippleColor = props.color ?? tint(theme.background, theme.primary, 0.3)
    setRipples((prev) => [
      ...prev,
      {
        id: idCounter++,
        x: props.x(),
        y: props.y(),
        startTime: performance.now(),
        color: rippleColor,
      },
    ])
  }

  onMount(() => {
    if (props.trigger) {
      const prevTrigger = props.trigger
      const interval = setInterval(() => {
        if (prevTrigger()) addRipple()
      }, 50)
      onCleanup(() => clearInterval(interval))
    }

    timer = setInterval(() => {
      setRipples((prev) => prev.filter((r) => performance.now() - r.startTime < duration))
    }, 16)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <For each={ripples()}>
      {(ripple) => {
        const elapsed = () => performance.now() - ripple.startTime
        const progress = () => Math.min(1, elapsed() / duration)
        const radius = () => maxRadius * easing.easeOutCubic(progress())
        const opacity = () => intensity * (1 - progress())

        return (
          <box
            position="absolute"
            left={ripple.x - radius()}
            top={ripple.y - radius()}
            width={radius() * 2}
            height={radius() * 2}
            borderStyle="round"
            borderColor={ripple.color}
          />
        )
      }}
    </For>
  )
}

export function WaveEffect(props: {
  width: () => number
  color?: RGBA
  amplitude?: number
  frequency?: number
  speed?: number
  phase?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const color = () => props.color ?? tint(theme.background, theme.primary, 0.2)
  const amplitude = props.amplitude ?? 2
  const frequency = props.frequency ?? 0.1
  const speed = props.speed ?? 0.002
  const phase = props.phase ?? 0

  const [frame, setFrame] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) return
    timer = setInterval(() => {
      setFrame((n) => n + 1)
    }, 16)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const waveHeight = (x: number): number => {
    const t = performance.now() * speed + phase
    return amplitude * Math.sin(x * frequency + t)
  }

  return (
    <box flexDirection="column">
      {Array.from({ length: amplitude * 2 + 1 }, (_, y) => (
        <box flexDirection="row">
          {Array.from({ length: props.width() }, (_, x) => {
            const waveY = amplitude + waveHeight(x)
            const dist = Math.abs(y - waveY)
            const cellOpacity = dist < 1 ? 1 - dist : 0
            return (
              <text
                bg={color()}
                fg={color()}
                opacity={cellOpacity * 0.5}
              >
                {" "}
              </text>
            )
          })}
        </box>
      ))}
    </box>
  )
}

export function BreathingBorder(props: {
  children: JSX.Element
  color?: RGBA
  width?: number
  height?: number
  period?: number
  intensity?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const color = () => props.color ?? theme.primary
  const period = props.period ?? 2000
  const intensity = props.intensity ?? 0.3

  const [borderOpacity, setBorderOpacity] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) {
      setBorderOpacity(intensity)
      return
    }

    timer = setInterval(() => {
      const t = (performance.now() % period) / period
      setBorderOpacity(intensity * (0.5 + 0.5 * Math.sin(t * Math.PI * 2)))
    }, 16)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box
      borderColor={color()}
      borderStyle="round"
      padding={1}
    >
      {props.children}
    </box>
  )
}

export function FloatingDots(props: {
  count?: number
  color?: RGBA
  speed?: number
  radius?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const count = props.count ?? 5
  const color = () => props.color ?? theme.textMuted
  const speed = props.speed ?? 0.001
  const radius = props.radius ?? 3

  const [dots, setDots] = createSignal<Array<{ angle: number; offset: number }>>(
    Array.from({ length: count }, (_, i) => ({
      angle: (i / count) * Math.PI * 2,
      offset: Math.random() * Math.PI * 2,
    })),
  )
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) return

    timer = setInterval(() => {
      setDots((prev) =>
        prev.map((dot) => ({
          ...dot,
          angle: dot.angle + speed,
        })),
      )
    }, 16)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box flexDirection="row" gap={1}>
      <For each={dots()}>
        {(dot) => {
          const opacity = 0.5 + 0.5 * Math.sin(dot.angle + dot.offset)
          return (
            <text fg={color()} opacity={opacity}>
              ●
            </text>
          )
        }}
      </For>
    </box>
  )
}
