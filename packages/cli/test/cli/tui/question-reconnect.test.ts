import { expect, test } from "bun:test"
import path from "node:path"

// Keep native TUI + live HTTP/SSE resources in a fresh process, without
// top-level dynamic imports in the test entry point (oven-sh/bun#32178).
test("question prompts recover across real HTTP/SSE reconnects", async () => {
  const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, "question-reconnect.fixture.tsx")], {
    timeout: 100_000,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stdout + stderr).toBe(0)
}, 120_000)
