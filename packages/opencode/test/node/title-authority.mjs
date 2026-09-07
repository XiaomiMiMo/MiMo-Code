// Run after `bun run script/build-node.ts`: node --test test/node/title-authority.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"
const exec = promisify(execFile)
const engine = new URL("../../dist/node/node.js", import.meta.url).href

// [TP-ST-R1-01, TP-ST-R1-05, TP-ST-R2-06] Two real Node processes / SQLite connections.
for (const logging of ["0", "1"])
  test(`Node durable CAS/restart across connections (sync log=${logging})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "mimo-title-node-"))
    await mkdir(join(dir, "home"))
    const env = {
      ...process.env,
      HOME: join(dir, "home"),
      USERPROFILE: join(dir, "home"),
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_STATE_HOME: join(dir, "state"),
      MIMOCODE_TEST_MANAGED_CONFIG_DIR: join(dir, "managed"),
      MIMOCODE_DB: join(dir, "engine.db"),
      MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true",
      MIMOCODE_EXPERIMENTAL: "0",
      MIMOCODE_EXPERIMENTAL_WORKSPACES: logging,
      MIMOCODE_CONFIG_CONTENT: "{}",
      MIMOCODE_CONFIG_DEFAULTS: "{}",
      MIMOCODE_SERVER_PASSWORD: "",
    }
    async function request(path, body, method = "GET") {
      const script = `const {Server}=await import(${JSON.stringify(engine)}); const r=await Server.Default().app.request(${JSON.stringify(path)}, {method:${JSON.stringify(method)},headers:{'content-type':'application/json'},${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))}`} }); console.log('TITLE_RESULT:'+JSON.stringify({status:r.status,data:await r.json()})); process.exit(0);`
      const result = await exec(process.execPath, ["--input-type=module", "-e", script], {
        cwd: dir,
        env,
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
      })
      const line = result.stdout.split("\n").find((line) => line.startsWith("TITLE_RESULT:"))
      assert.ok(line, result.stdout + result.stderr)
      return JSON.parse(line.slice("TITLE_RESULT:".length))
    }
    try {
      const created = await request("/session", {}, "POST")
      assert.equal(created.status, 200, JSON.stringify(created))
      assert.equal(created.data.titleSource, "fallback")
      assert.equal(created.data.titleRevision, 0)
      const url = `/session/${created.data.id}`
      const outcomes = await Promise.all([
        request(url, { title: "First writer", expectedRevision: 0 }, "PATCH"),
        request(url, { title: "Second writer", expectedRevision: 0 }, "PATCH"),
      ])
      assert.deepEqual(outcomes.map((x) => x.status).sort(), [200, 409], JSON.stringify(outcomes))
      const winner = outcomes.find((x) => x.status === 200).data
      const readback = await request(url)
      assert.equal(readback.status, 200)
      assert.equal(readback.data.title, winner.title)
      assert.equal(readback.data.titleSource, "user")
      assert.equal(readback.data.titleRevision, 1)
      const same = await request(url, { title: winner.title, expectedRevision: 0 }, "PATCH")
      assert.equal(same.status, 409)
      assert.equal(same.data.data.current.titleRevision, 1)
      const db = new DatabaseSync(env.MIMOCODE_DB)
      try {
        const titleEvents = db
          .prepare(
            "SELECT count(*) AS n FROM event WHERE type='session.updated.2' AND json_extract(data, '$.previousRevision') IS NOT NULL",
          )
          .get()
        assert.equal(titleEvents.n, logging === "1" ? 1 : 0)
      } finally {
        db.close()
      }
      assert.equal((await request(url, undefined, "DELETE")).status, 200)
      assert.equal((await request(url, { title: "Late", expectedRevision: 1 }, "PATCH")).status, 404)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
