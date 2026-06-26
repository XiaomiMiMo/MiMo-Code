import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { RGBA, StyledText, type BoxRenderable, type TextChunk, type TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/context/theme"

const FRAME_INTERVAL = 50
const PHASE_SPEED = 0.1

function hueToRgb(h: number): { r: number; g: number; b: number } {
  const s = 0.6
  const v = 0.5
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0: return { r: v * 255, g: t * 255, b: p * 255 }
    case 1: return { r: q * 255, g: v * 255, b: p * 255 }
    case 2: return { r: p * 255, g: v * 255, b: t * 255 }
    case 3: return { r: p * 255, g: q * 255, b: v * 255 }
    case 4: return { r: t * 255, g: p * 255, b: v * 255 }
    case 5: return { r: v * 255, g: p * 255, b: q * 255 }
  }
  return { r: 0, g: 0, b: 0 }
}

export function WavesBackground() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal({ w: 80, h: 24 })
  const [phase, setPhase] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true
    sync()
    box?.on("resize", sync)
    timer = setInterval(() => {
      if (!mounted) return
      setPhase((p) => p + PHASE_SPEED)
    }, FRAME_INTERVAL)
  })

  onCleanup(() => {
    mounted = false
    box?.off("resize", sync)
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  })

  const content = createMemo(() => {
    const p = phase()
    const { w, h } = size()
    const chunks: TextChunk[] = []
    const bg = theme.background

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ny = y / h
        const nx = x / w
        const wave1 = Math.sin(nx * 8 + ny * 4 + p)
        const wave2 = Math.sin(nx * 5 - ny * 3 + p * 0.7)
        const wave3 = Math.sin(nx * 12 + ny * 2 + p * 1.3)
        const brightness = (wave1 + wave2 + wave3) / 6 + 0.5
        const hue = (nx * 0.5 + ny * 0.3 + p * 0.02) % 1
        const rgb = hueToRgb(hue)
        const r = Math.round(rgb.r * brightness + (1 - brightness) * bg.r!)
        const g = Math.round(rgb.g * brightness + (1 - brightness) * bg.g!)
        const b = Math.round(rgb.b * brightness + (1 - brightness) * bg.b!)
        const shade = brightness > 0.55 ? "░" : brightness > 0.45 ? "▒" : "▓"
        chunks.push({ __isChunk: true, text: shade, fg: RGBA.fromInts(r, g, b), attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })

  createEffect(() => {
    if (!text) return
    text.content = content()
  })

  return (
    <box
      ref={(item: BoxRenderable) => (box = item)}
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={0}
    >
      <text
        ref={(item: TextRenderable) => {
          text = item
          item.content = content()
        }}
        width="100%"
        height="100%"
        wrapMode="none"
        selectable={false}
      />
    </box>
  )
}
