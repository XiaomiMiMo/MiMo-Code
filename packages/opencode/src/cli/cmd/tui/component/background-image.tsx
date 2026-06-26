import { createEffect, createMemo, createResource, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { RGBA, StyledText, type TextChunk, type TextRenderable } from "@opentui/core"
import { tint, useTheme } from "@tui/context/theme"
import { StarryBackground } from "./starry-background"
import { PNG } from "pngjs"
import jpeg from "jpeg-js"
import path from "path"
import { allocImageId, detectImageProtocol, kittyClear, kittyDisplay } from "../util/image-protocol"

const HALF_BLOCK = "▀"
const PROTOCOL = detectImageProtocol()
const IMAGE_ALPHA = 0.45
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"])

type Pixels = {
  data: Uint8Array | Buffer
  width: number
  height: number
}

async function decode(filePath: string): Promise<Pixels | undefined> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  const buf = Buffer.from(await file.arrayBuffer())
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".png") {
    const png = PNG.sync.read(buf)
    return { data: png.data, width: png.width, height: png.height }
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    const decoded = jpeg.decode(buf, { useTArray: true })
    return { data: decoded.data, width: decoded.width, height: decoded.height }
  }
  return undefined
}

function pixelAt(p: Pixels, x: number, y: number) {
  const cx = Math.max(0, Math.min(p.width - 1, Math.floor(x)))
  const cy = Math.max(0, Math.min(p.height - 1, Math.floor(y)))
  const i = (cy * p.width + cx) * 4
  return {
    r: p.data[i] ?? 0,
    g: p.data[i + 1] ?? 0,
    b: p.data[i + 2] ?? 0,
    a: p.data[i + 3] ?? 255,
  }
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function sample(p: Pixels, sx: number, sy: number) {
  const x0 = Math.floor(sx)
  const y0 = Math.floor(sy)
  const x1 = x0 + 1
  const y1 = y0 + 1
  const fx = sx - x0
  const fy = sy - y0

  const tl = pixelAt(p, x0, y0)
  const tr = pixelAt(p, x1, y0)
  const bl = pixelAt(p, x0, y1)
  const br = pixelAt(p, x1, y1)

  const topR = lerp(tl.r, tr.r, fx)
  const topG = lerp(tl.g, tr.g, fx)
  const topB = lerp(tl.b, tr.b, fx)
  const topA = lerp(tl.a, tr.a, fx)

  const botR = lerp(bl.r, br.r, fx)
  const botG = lerp(bl.g, br.g, fx)
  const botB = lerp(bl.b, br.b, fx)
  const botA = lerp(bl.a, br.a, fx)

  return {
    r: Math.round(lerp(topR, botR, fy)),
    g: Math.round(lerp(topG, botG, fy)),
    b: Math.round(lerp(topB, botB, fy)),
    a: Math.round(lerp(topA, botA, fy)),
  }
}

function pixelChunk(fg: RGBA, bg: RGBA): TextChunk {
  return { __isChunk: true, text: HALF_BLOCK, fg, bg, attributes: 0 }
}

function StyledBackgroundText(props: { content: () => StyledText | undefined }) {
  let text: TextRenderable | undefined

  createEffect(() => {
    const content = props.content()
    if (!text || !content) return
    text.content = content
  })

  return (
    <text
      ref={(item: TextRenderable) => {
        text = item
        const content = props.content()
        if (content) item.content = content
      }}
      width="100%"
      height="100%"
      wrapMode="none"
      selectable={false}
    />
  )
}

export function BackgroundImage(props: { path: string }) {
  const kitty = createMemo(() => PROTOCOL === "kitty" && IMAGE_EXT.has(path.extname(props.path).toLowerCase()))
  return (
    <Show when={kitty()} fallback={<BackgroundImageHalfBlock path={props.path} />}>
      <BackgroundImageKitty path={props.path} />
    </Show>
  )
}

function BackgroundImageKitty(props: { path: string }) {
  const dimensions = useTerminalDimensions()
  const id = allocImageId()
  createEffect(() => {
    const W = dimensions().width
    const H = dimensions().height
    const p = props.path
    if (!W || !H || !p) return
    kittyClear(id)
    void kittyDisplay({ id, filePath: p, cols: W, rows: H }).catch(() => {})
  })
  onCleanup(() => kittyClear(id))
  return null
}

function BackgroundImageHalfBlock(props: { path: string }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [pixels] = createResource(
    () => props.path,
    (p) => decode(p).catch(() => undefined),
  )

  const content = createMemo(() => {
    const p = pixels()
    const W = dimensions().width
    const H = dimensions().height
    if (!p || !W || !H) return undefined

    // "cover" fit: scale image to fully fill the screen, cropping excess.
    // Half-block doubles vertical resolution: each terminal row = 2 image rows.
    const targetW = W
    const targetH = H * 2
    const ratio = Math.max(targetW / p.width, targetH / p.height)
    const offsetX = (p.width * ratio - targetW) / 2
    const offsetY = (p.height * ratio - targetH) / 2
    const bg = theme.background
    const chunks: TextChunk[] = []

    Array.from({ length: H }).forEach((_, y) => {
      Array.from({ length: W }).forEach((_, x) => {
        const sx = (x + offsetX) / ratio
        const top = sample(p, sx, (y * 2 + offsetY) / ratio)
        const bot = sample(p, sx, (y * 2 + 1 + offsetY) / ratio)
        chunks.push(
          pixelChunk(
            top.a < 16 ? bg : tint(bg, RGBA.fromInts(top.r, top.g, top.b), IMAGE_ALPHA),
            bot.a < 16 ? bg : tint(bg, RGBA.fromInts(bot.r, bot.g, bot.b), IMAGE_ALPHA),
          ),
        )
      })
      if (y < H - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    })

    return new StyledText(chunks)
  })

  return (
    <Show when={content()} fallback={<StarryBackground />}>
      <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
        <StyledBackgroundText content={content} />
      </box>
    </Show>
  )
}
