import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { RGBA, StyledText, type BoxRenderable, type TextChunk, type TextRenderable } from "@opentui/core"
import { tint, useTheme } from "@tui/context/theme"

const CHARS = "日月山水火金木土天地人物风雨雷电龙虎凤龟麟鹿鹤鹰山川海洋星辰春秋冬夏云雪霜露"
const FALL_SPEED = 80
const DENSITY = 0.6

type Drop = {
  col: number
  head: number
  length: number
  speed: number
}

export function MatrixBackground() {
  const { theme } = useTheme()
  const [drops, setDrops] = createSignal<Drop[]>([])
  const [size, setSize] = createSignal({ w: 80, h: 24 })
  const [frame, setFrame] = createSignal(0)
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
    const cols = next.w
    const dropsArr: Drop[] = []
    for (let c = 0; c < cols; c++) {
      if (Math.random() < DENSITY) {
        dropsArr.push({
          col: c,
          head: Math.floor(Math.random() * next.h * -1),
          length: 4 + Math.floor(Math.random() * 8),
          speed: 1 + Math.random() * 2,
        })
      }
    }
    setDrops(dropsArr)
  }

  onMount(() => {
    mounted = true
    sync()
    box?.on("resize", sync)
    timer = setInterval(() => {
      if (!mounted) return
      setDrops((prev) => {
        const { h } = size()
        return prev.map((d) => {
          if (d.head - d.length >= h) {
            return {
              col: d.col,
              head: Math.floor(Math.random() * h * -1),
              length: 4 + Math.floor(Math.random() * 8),
              speed: 1 + Math.random() * 2,
            }
          }
          return { ...d, head: d.head + d.speed }
        })
      })
      setFrame((n) => n + 1)
    }, FALL_SPEED)
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
    void frame()
    const { w, h } = size()
    const ds = drops()
    const chunks: TextChunk[] = []
    const brightGreen = RGBA.fromInts(0, 255, 65)
    const dimGreen = RGBA.fromInts(0, 100, 30)
    const bg = theme.background

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const drop = ds.find((d) => d.col === x)
        if (!drop || y < drop.head - drop.length || y > drop.head) {
          chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 })
          continue
        }
        const distFromHead = drop.head - y
        const char = CHARS[Math.floor(Math.random() * CHARS.length)]
        if (distFromHead === 0) {
          chunks.push({ __isChunk: true, text: char, fg: RGBA.fromInts(255, 255, 255), bg, attributes: 0 })
        } else if (distFromHead === 1) {
          chunks.push({ __isChunk: true, text: char, fg: brightGreen, bg, attributes: 0 })
        } else {
          const t = distFromHead / drop.length
          const r = Math.round(0 * (1 - t))
          const g = Math.round(255 * (1 - t * 0.7))
          const b = Math.round(65 * (1 - t * 0.8))
          chunks.push({ __isChunk: true, text: char, fg: RGBA.fromInts(r, g, b), bg, attributes: 0 })
        }
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
