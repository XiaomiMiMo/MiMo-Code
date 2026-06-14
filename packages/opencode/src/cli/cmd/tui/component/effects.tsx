import { createSignal, For, onMount, onCleanup, type JSX } from "solid-js"
import { RGBA } from "@opentui/core"
import { useTheme, tint } from "../context/theme"
import { useKV } from "../context/kv"

export function MatrixRain(props: {
  width: () => number
  height: () => number
  color?: RGBA
  speed?: number
  density?: number
  enabled?: boolean
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true) && (props.enabled ?? true)
  const color = () => props.color ?? tint(theme.background, theme.primary, 0.3)
  const speed = props.speed ?? 50
  const density = props.density ?? 0.1

  type Drop = { x: number; y: number; speed: number; char: string; opacity: number }
  const [drops, setDrops] = createSignal<Drop[]>([])
  let timer: ReturnType<typeof setInterval> | undefined

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*()"

  onMount(() => {
    if (!animationsEnabled()) return

    const w = props.width()
    const h = props.height()
    const initialDrops: Drop[] = Array.from({ length: Math.floor(w * density) }, () => ({
      x: Math.floor(Math.random() * w),
      y: Math.floor(Math.random() * h),
      speed: 0.5 + Math.random() * 1.5,
      char: chars[Math.floor(Math.random() * chars.length)],
      opacity: 0.3 + Math.random() * 0.4,
    }))
    setDrops(initialDrops)

    timer = setInterval(() => {
      setDrops((prev) =>
        prev.map((drop) => ({
          ...drop,
          y: (drop.y + drop.speed) % (h + 5),
          char: Math.random() > 0.95 ? chars[Math.floor(Math.random() * chars.length)] : drop.char,
        })),
      )
    }, speed)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <For each={drops()}>
        {(drop) => (
          <text
            position="absolute"
            left={drop.x}
            top={Math.floor(drop.y)}
            fg={color()}
            opacity={drop.opacity}
          >
            {drop.char}
          </text>
        )}
      </For>
    </box>
  )
}

export function ParticleSystem(props: {
  count?: number
  color?: RGBA
  speed?: number
  size?: number
  spread?: number
  gravity?: number
  enabled?: boolean
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true) && (props.enabled ?? true)
  const count = props.count ?? 20
  const color = () => props.color ?? theme.primary
  const speed = props.speed ?? 0.02
  const spread = props.spread ?? 10
  const gravity = props.gravity ?? 0.001

  type Particle = {
    id: number
    x: number
    y: number
    vx: number
    vy: number
    life: number
    maxLife: number
    char: string
  }

  const [particles, setParticles] = createSignal<Particle[]>([])
  let idCounter = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const createParticle = (): Particle => ({
    id: idCounter++,
    x: spread / 2 + (Math.random() - 0.5) * spread,
    y: 0,
    vx: (Math.random() - 0.5) * speed * 2,
    vy: Math.random() * speed,
    life: 1,
    maxLife: 50 + Math.random() * 50,
    char: ["●", "○", "◉", "◎", "★", "☆"][Math.floor(Math.random() * 6)],
  })

  onMount(() => {
    if (!animationsEnabled()) return

    timer = setInterval(() => {
      setParticles((prev) => {
        const updated = prev
          .map((p) => ({
            ...p,
            x: p.x + p.vx,
            y: p.y + p.vy,
            vy: p.vy + gravity,
            life: p.life - 1 / p.maxLife,
          }))
          .filter((p) => p.life > 0)

        if (updated.length < count && Math.random() > 0.7) {
          updated.push(createParticle())
        }

        return updated
      })
    }, 16)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <For each={particles()}>
        {(particle) => (
          <text
            position="absolute"
            left={particle.x}
            top={particle.y}
            fg={color()}
            opacity={particle.life}
          >
            {particle.char}
          </text>
        )}
      </For>
    </box>
  )
}

export function ScanLine(props: {
  color?: RGBA
  speed?: number
  opacity?: number
  enabled?: boolean
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true) && (props.enabled ?? true)
  const color = () => props.color ?? tint(theme.background, theme.primary, 0.1)
  const speed = props.speed ?? 0.001
  const lineOpacity = props.opacity ?? 0.3

  const [position, setPosition] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) return

    timer = setInterval(() => {
      setPosition((prev) => (prev + speed * 100) % 100)
    }, 16)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <box
        position="absolute"
        top={position()}
        left={0}
        width="100%"
        height={1}
        backgroundColor={color()}
      />
    </box>
  )
}

export function GlitchEffect(props: {
  children: JSX.Element
  intensity?: number
  speed?: number
  enabled?: boolean
}) {
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true) && (props.enabled ?? true)
  const intensity = props.intensity ?? 0.1
  const speed = props.speed ?? 100

  const [glitching, setGlitching] = createSignal(false)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) return

    timer = setInterval(() => {
      setGlitching(Math.random() > 0.95)
    }, speed)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box>
      {props.children}
    </box>
  )
}

export function NeonGlow(props: {
  children: JSX.Element
  color?: RGBA
  intensity?: number
  speed?: number
  enabled?: boolean
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true) && (props.enabled ?? true)
  const color = () => props.color ?? theme.primary
  const intensity = props.intensity ?? 0.5
  const speed = props.speed ?? 1000

  const [glow, setGlow] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) {
      setGlow(intensity)
      return
    }

    timer = setInterval(() => {
      const t = (performance.now() % speed) / speed
      setGlow(intensity * (0.8 + 0.2 * Math.sin(t * Math.PI * 2)))
    }, 16)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box
      paddingTop={1}
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
    >
      {props.children}
    </box>
  )
}

export function TypewriterText(props: {
  text: string
  speed?: number
  delay?: number
  onComplete?: () => void
  enabled?: boolean
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true) && (props.enabled ?? true)
  const speed = props.speed ?? 50
  const delay = props.delay ?? 0

  const [displayText, setDisplayText] = createSignal("")
  const [cursor, setCursor] = createSignal(true)
  let timer: ReturnType<typeof setTimeout> | undefined
  let cursorTimer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) {
      setDisplayText(props.text)
      props.onComplete?.()
      return
    }

    timer = setTimeout(() => {
      let index = 0
      const type = () => {
        if (index <= props.text.length) {
          setDisplayText(props.text.slice(0, index))
          index++
          timer = setTimeout(type, speed)
        } else {
          props.onComplete?.()
        }
      }
      type()
    }, delay)

    cursorTimer = setInterval(() => {
      setCursor((prev) => !prev)
    }, 500)
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    if (cursorTimer) clearInterval(cursorTimer)
  })

  return (
    <text>
      {displayText()}
      <text fg={theme.primary} opacity={cursor() ? 1 : 0}>
        █
      </text>
    </text>
  )
}
