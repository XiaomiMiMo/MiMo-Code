import { afterEach, expect, test } from "bun:test"
import yargs from "yargs/yargs"
import { RunCommand } from "../../src/cli/cmd/run"
import { ImportCommand } from "../../src/cli/cmd/import"
import { OpencodeClient as V1 } from "../../../sdk/src/gen/sdk.gen"
import { OpencodeClient as V2 } from "../../../sdk/src/v2/gen/sdk.gen"

afterEach(() => {
  process.exitCode = 0
})

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
    await ImportCommand.handler({ file: `${upstream.url}share/example` } as Parameters<typeof ImportCommand.handler>[0])
    expect(process.exitCode).toBe(1)
    expect(calls).toEqual([])
  } finally {
    upstream.stop(true)
  }
})
