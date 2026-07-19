import { PNG } from "pngjs"
import jpeg from "jpeg-js"

// Provider hard limit is 5 MiB (Bedrock/Anthropic reject a single image whose
// decoded base64 exceeds 5242880 bytes with a non-retryable 400). We compress
// below a slightly smaller ceiling so re-encode jitter can't push us back over.
export const DEFAULT_MAX_IMAGE_BYTES = 4_500_000

type Pixels = { data: Uint8Array | Buffer; width: number; height: number }

// jpeg-js only understands JPEG; pngjs only PNG. Anything else (webp, gif, ...)
// has no pure-JS decoder available here, so it can't be recompressed and the
// caller must fall back to a text placeholder.
function decode(mime: string, bytes: Buffer): Pixels | undefined {
  if (mime === "image/jpeg" || mime === "image/jpg") {
    const out = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 512 })
    return { data: out.data, width: out.width, height: out.height }
  }
  if (mime === "image/png") {
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
  const scales = [1, 0.75, 0.5, 0.35, 0.25, 0.15, 0.1]
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
