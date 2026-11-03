import { expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import yargs from "yargs/yargs"
import { RunCommand } from "../../src/cli/cmd/run"
import { ImportCommand } from "../../src/cli/cmd/import"
import { OpencodeClient as V1 } from "../../../sdk/src/gen/sdk.gen"
import { OpencodeClient as V2 } from "../../../sdk/src/v2/gen/sdk.gen"

const src = path.resolve(import.meta.dir, "../../src")
const read = (file: string) => readFileSync(path.join(src, file), "utf8")

// engine-runtime [TP-R14-02]
test("CLI and both SDK generations expose no share operations", async () => {
  if (typeof RunCommand.builder !== "function") throw new Error("Missing run builder")
  const parser = await RunCommand.builder(yargs([]))
  expect(await parser.getHelp()).not.toContain("--share")
  for (const client of [new V1(), new V2()]) {
    expect("share" in client.session).toBe(false)
    expect("unshare" in client.session).toBe(false)
  }
})

// engine-runtime [TP-R14-02]
test("URL import is rejected before bootstrap or HTTP access", async () => {
  const calls: string[] = []
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      calls.push(req.url)
      return Response.json([])
    },
  })
  try {
    await expect(ImportCommand.handler({ file: `${upstream.url}share/example` } as Parameters<typeof ImportCommand.handler>[0]))
      .rejects.toThrow("Import accepts local JSON files only")
    expect(calls).toEqual([])
  } finally {
    upstream.stop(true)
  }
})

// engine-runtime [TP-R14-02]: guard all shipped entry points against reintroduction.
test("transport, runtime registrations, GitHub and TUI affordances are removed", () => {
  expect(existsSync(path.join(src, "share"))).toBe(false)
  for (const file of ["effect/app-runtime.ts", "effect/bootstrap-runtime.ts", "project/bootstrap.ts"]) {
    expect(read(file)).not.toMatch(/ShareNext|SessionShare/)
  }
  expect(read("cli/cmd/github.ts")).not.toMatch(/normalizeShare|shareId|shareBaseUrl|opencode-share/)
  for (const file of [
    "cli/cmd/tui/routes/session/index.tsx", "cli/cmd/tui/routes/session/sidebar.tsx",
    "cli/cmd/tui/feature-plugins/home/tips-view.tsx", "server/routes/instance/tui.ts",
    "config/keybinds.ts",
  ]) {
    expect(read(file)).not.toMatch(/session[._](?:un)?share|share_url|tui\.tips\.(?:share|unshare)/)
  }
  for (const language of ["en", "zh", "zht", "ja", "ru", "fr", "es"]) {
    expect(read(`cli/cmd/tui/i18n/${language}.ts`)).not.toMatch(/tui\.(?:command\.session\.(?:un)?share|tips\.(?:share|unshare))/)
  }
})
