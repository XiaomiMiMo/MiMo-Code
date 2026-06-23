import type { MiddlewareHandler } from "hono"

const windows = new Map<string, { count: number; resetAt: number }>()

export function RateLimitMiddleware(opts: {
  windowMs: number
  max: number
  keyPrefix?: string
}): MiddlewareHandler {
  return async (c, next) => {
    const key = (opts.keyPrefix ?? c.req.path) + ":" + (c.req.header("x-forwarded-for") ?? "local")
    const now = Date.now()
    let entry = windows.get(key)
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + opts.windowMs }
      windows.set(key, entry)
    }
    entry.count++
    if (entry.count > opts.max) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)))
      return c.json({ error: "Too many requests" }, 429)
    }
    return next()
  }
}
