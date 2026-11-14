import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

test("the session cost product query runs on the Node SQLite adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-cost-node-"))
  try {
    const fixture = fileURLToPath(new URL("./fixtures/node-cost.ts", import.meta.url))
    const output = join(dir, "node-cost.mjs")
    const build = spawnSync(process.execPath, ["build", fixture, "--target=node", "--outfile", output], {
      encoding: "utf8",
    })
    expect(build.status, build.stderr).toBe(0)
    const run = spawnSync("node", [output], { encoding: "utf8" })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout.trim())).toEqual({ ok: true, cost: 103 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
