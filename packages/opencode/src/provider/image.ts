import { PNG } from "pngjs"
import jpeg from "jpeg-js"

// Provider hard limit is 5 MiB (Bedrock/Anthropic reject a single image whose
// decoded base64 exceeds 5242880 bytes with a non-retryable 400). We compress
// below a slightly smaller ceiling so re-encode jitter can't push us back over.
export const DEFAULT_MAX_IMAGE_BYTES = 4_500_000
export const DEFAULT_MAX_IMAGE_DIMENSION = 2_000
export const MAX_DECODE_IMAGE_PIXELS = 64_000_000
export const MAX_JPEG_DECODE_MEMORY_MB = 512

type Pixels = { data: Uint8Array | Buffer; width: number; height: number }
export type ImageDimensions = { width: number; height: number }

const jpegFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function pngDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 24) return undefined
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return undefined
  if (bytes.readUInt32BE(8) !== 13) return undefined
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return undefined
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height) return undefined
  return { width, height }
}

function jpegDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined

  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    while (bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return undefined
    const marker = bytes[offset++]
    if (marker === 0xd9 || marker === 0xda) return undefined
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 2 > bytes.length) return undefined
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return undefined
    if (jpegFrameMarkers.has(marker)) {
      if (length < 8) return undefined
      const height = bytes.readUInt16BE(offset + 3)
      const width = bytes.readUInt16BE(offset + 5)
      if (!width || !height) return undefined
      return { width, height }
    }
    offset += length
  }
  return undefined
}

function gifDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined
  const signature = bytes.toString("ascii", 0, 6)
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined
  const width = bytes.readUInt16LE(6)
  const height = bytes.readUInt16LE(8)
  if (!width || !height) return undefined
  return { width, height }
}

function webpDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP")
    return undefined
  const chunk = bytes.toString("ascii", 12, 16)
  if (chunk === "VP8X") {
    const width = bytes.readUIntLE(24, 3) + 1
    const height = bytes.readUIntLE(27, 3) + 1
    return { width, height }
  }
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    const width = bytes.readUInt16LE(26) & 0x3fff
    const height = bytes.readUInt16LE(28) & 0x3fff
    if (!width || !height) return undefined
    return { width, height }
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return undefined
    const width = 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8))
    const height = 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10))
    return { width, height }
  }
  return undefined
}

const dimensionMimes = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])

export function supportsImageDimensions(mime: string) {
  return dimensionMimes.has(mime.split(";", 1)[0]?.toLowerCase() ?? "")
}

// Reads dimensions from container headers only. This deliberately avoids image
// pixel decoding so normal, in-limit images stay on a cheap allocation-free path.
export function imageDimensions(mime: string, bytes: Buffer): ImageDimensions | undefined {
  const normalized = mime.split(";", 1)[0]?.toLowerCase()
  if (normalized === "image/png") return pngDimensions(bytes)
  if (normalized === "image/jpeg" || normalized === "image/jpg") return jpegDimensions(bytes)
  if (normalized === "image/webp") return webpDimensions(bytes)
  if (normalized === "image/gif") return gifDimensions(bytes)
  return undefined
}

function safeDimensions(mime: string, bytes: Buffer): ImageDimensions | undefined {
  const dimensions = imageDimensions(mime, bytes)
  if (!dimensions || dimensions.width * dimensions.height > MAX_DECODE_IMAGE_PIXELS) return undefined
  return dimensions
}

export function jpegMemoryBudget(dimensions: ImageDimensions) {
  // jpeg-js accounts DCT blocks, component planes, color conversion buffers and
  // the RGBA result against this value. Scale the guard with the actual image
  // while retaining the former 512 MiB hard ceiling against compressed bombs.
  return Math.min(
    MAX_JPEG_DECODE_MEMORY_MB,
    Math.max(32, Math.ceil((dimensions.width * dimensions.height * 24) / 1024 / 1024)),
  )
}

// jpeg-js only understands JPEG; pngjs only PNG. Anything else (webp, gif, ...)
// has no pure-JS decoder available here, so it can't be recompressed and the
// caller must fall back to a text placeholder.
function decode(mime: string, bytes: Buffer): Pixels | undefined {
  const normalized = mime.split(";", 1)[0]?.toLowerCase()
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    const dimensions = safeDimensions(normalized, bytes)
    if (!dimensions) return undefined
    const out = jpeg.decode(bytes, {
      useTArray: true,
      maxResolutionInMP: MAX_DECODE_IMAGE_PIXELS / 1_000_000,
      maxMemoryUsageInMB: jpegMemoryBudget(dimensions),
    })
    return { data: out.data, width: out.width, height: out.height }
  }
  if (normalized === "image/png") {
    if (!safeDimensions(normalized, bytes)) return undefined
    const png = PNG.sync.read(bytes)
    return { data: png.data, width: png.width, height: png.height }
  }
  return undefined
}

// Area-averaging (box filter) downscale of an RGBA buffer. Pure JS, no dependency.
// Each destination pixel maps to a rectangular region of the source and takes the
// (alpha-weighted) average of every source pixel that overlaps it, instead of
// point-sampling a single source pixel like nearest-neighbor. This is the standard
// "BOX" resampling filter (cf. Pillow's Resampling.BOX) and dramatically reduces
// the aliasing/jagged-text artifacts nearest-neighbor produces when shrinking
// screenshots — important because the model still needs to read the result.
//
// Fractional source-pixel coverage at region edges is weighted by the overlap
// fraction, so the filter is continuous across scales rather than snapping to
// integer boundaries. RGB is averaged weighted by alpha (so fully-transparent
// pixels don't drag color toward black); alpha is a plain area average.
export function downscale(src: Pixels, scale: number): Pixels {
  const width = Math.max(1, Math.round(src.width * scale))
  const height = Math.max(1, Math.round(src.height * scale))
  // Upscaling / no-op: fall back to nearest-neighbor (area-averaging is a
  // downscale filter; callers here only ever pass scale <= 1).
  if (width >= src.width && height >= src.height) return nearest(src, width, height)

  const data = Buffer.alloc(width * height * 4)
  const xRatio = src.width / width
  const yRatio = src.height / height
  for (let dy = 0; dy < height; dy++) {
    const sy0 = dy * yRatio
    const sy1 = sy0 + yRatio
    const iy0 = Math.floor(sy0)
    const iy1 = Math.min(src.height, Math.ceil(sy1))
    for (let dx = 0; dx < width; dx++) {
      const sx0 = dx * xRatio
      const sx1 = sx0 + xRatio
      const ix0 = Math.floor(sx0)
      const ix1 = Math.min(src.width, Math.ceil(sx1))

      let rw = 0 // sum of (alpha * area) weights, for RGB
      let r = 0
      let g = 0
      let b = 0
      let aArea = 0 // sum of (alpha * area), for the alpha channel
      let area = 0 // sum of geometric overlap area
      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(sy1, sy + 1) - Math.max(sy0, sy)
        if (wy <= 0) continue
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(sx1, sx + 1) - Math.max(sx0, sx)
          if (wx <= 0) continue
          const w = wx * wy
          const si = (sy * src.width + sx) * 4
          const a = src.data[si + 3] ?? 255
          const aw = a * w
          r += (src.data[si] ?? 0) * aw
          g += (src.data[si + 1] ?? 0) * aw
          b += (src.data[si + 2] ?? 0) * aw
          rw += aw
          aArea += aw
          area += w
        }
      }
      const di = (dy * width + dx) * 4
      // rw == 0 means the whole region was fully transparent: keep RGB at 0.
      data[di] = rw > 0 ? Math.round(r / rw) : 0
      data[di + 1] = rw > 0 ? Math.round(g / rw) : 0
      data[di + 2] = rw > 0 ? Math.round(b / rw) : 0
      data[di + 3] = area > 0 ? Math.round(aArea / area) : 255
    }
  }
  return { data, width, height }
}

// Nearest-neighbor resample to explicit target dimensions. Used only as the
// upscale/no-op fallback for downscale() above.
function nearest(src: Pixels, width: number, height: number): Pixels {
  const data = Buffer.alloc(width * height * 4)
  const xRatio = src.width / width
  const yRatio = src.height / height
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * yRatio))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * xRatio))
      const si = (sy * src.width + sx) * 4
      const di = (y * width + x) * 4
      data[di] = src.data[si] ?? 0
      data[di + 1] = src.data[si + 1] ?? 0
      data[di + 2] = src.data[si + 2] ?? 0
      data[di + 3] = src.data[si + 3] ?? 255
    }
  }
  return { data, width, height }
}

// Re-encode oversized image bytes as JPEG below maxBytes. Always outputs JPEG
// (smaller than PNG for photos/screenshots and lets us trade quality for size).
// Returns { data (raw base64), mediaType } on success, or undefined if the
// format can't be decoded or we couldn't get under the limit — callers then
// strip the image to a text placeholder so a poison image can never wedge the
// session.
export function compressImage(
  mime: string,
  bytes: Buffer,
  maxBytes: number,
  maxDimension = Infinity,
): { data: string; mediaType: string } | undefined {
  let pixels: Pixels | undefined
  try {
    pixels = decode(mime, bytes)
  } catch {
    return undefined
  }
  if (!pixels) return undefined

  // Try progressively lower quality, then progressively smaller dimensions.
  // Each dimension halving cuts pixel count ~4x, so a handful of steps covers
  // even very large source images.
  const initialScale = Math.min(1, maxDimension / Math.max(pixels.width, pixels.height))
  const scales = [1, 0.75, 0.5, 0.35, 0.25, 0.15, 0.1].map((scale) => scale * initialScale)
  const qualities = [80, 60, 45, 30]
  for (const scale of scales) {
    const scaled = scale === 1 ? pixels : downscale(pixels, scale)
    for (const quality of qualities) {
      try {
        const encoded = jpeg.encode({ data: Buffer.from(scaled.data), width: scaled.width, height: scaled.height }, quality)
        if (encoded.data.length <= maxBytes) {
          return { data: Buffer.from(encoded.data).toString("base64"), mediaType: "image/jpeg" }
        }
      } catch {
        return undefined
      }
    }
  }
  return undefined
}
