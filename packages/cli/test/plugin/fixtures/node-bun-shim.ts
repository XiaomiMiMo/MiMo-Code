// Mirrors an embedder that defines only part of the Bun global on Node.
if (process.env.BUN_SHIM) (globalThis as { Bun?: unknown }).Bun = { version: "polyfill", file() {}, write() {} }
