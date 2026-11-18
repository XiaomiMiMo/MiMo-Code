import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

const root = await mkdtemp(join(tmpdir(), "semindex-fixture-"))
afterAll(async () => rm(root, { recursive: true, force: true }))

test("legacy indexes are refused without modifying their artifacts", async () => {
  await writeFile(join(root, "memory.manifest.json"), JSON.stringify({ corpus: "memory", model: "test/model", chunks: 0 }))
  const helper = new URL("../../script/semindex-semantic.py", import.meta.url).pathname
  const child = spawn("python3", [helper], {
    env: { ...process.env, SEMINDEX_HOME: root, SEMINDEX_MODEL: "test/model" },
    stdio: ["pipe", "ignore", "ignore"],
  })
  child.stdin.end(JSON.stringify({ corpus: "memory", query: "synthetic query", allowed: ["/tmp/example"], limit: 2 }))
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
  expect(code).not.toBe(0)
})
