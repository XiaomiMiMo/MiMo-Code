import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { createOpencodeServer as createServerV1 } from "@mimo-ai/sdk/server"
import { createOpencodeServer as createServerV2, createOpencodeTui } from "@mimo-ai/sdk/v2/server"
import { tmpdir } from "../fixture/fixture"

// The SDK launches the CLI by binary name. A fake `mimo` placed first on PATH
// records its argv and prints the CLI's real readiness line, so these tests
// observe which binary the SDK spawns and whether it recognises the CLI as up.
const fakeMimo = `#!/bin/sh
printf '%s\\n' "$@" > "$(dirname "$0")/argv"
case "$1" in
  serve)
    echo "mimocode server listening on http://127.0.0.1:4096"
    exec sleep 30
    ;;
esac
`

describe.skipIf(process.platform === "win32")("sdk launches the mimo binary", () => {
  const originalPath = process.env.PATH
  let bin: Awaited<ReturnType<typeof tmpdir>>

  beforeEach(async () => {
    bin = await tmpdir()
    const file = path.join(bin.path, "mimo")
    await fs.writeFile(file, fakeMimo)
    await fs.chmod(file, 0o755)
    process.env.PATH = `${bin.path}${path.delimiter}${originalPath}`
  })

  afterEach(async () => {
    process.env.PATH = originalPath
    await bin[Symbol.asyncDispose]()
  })

  const argv = async () => (await fs.readFile(path.join(bin.path, "argv"), "utf8")).trim().split("\n")

  for (const [name, create] of [
    ["v1", createServerV1],
    ["v2", createServerV2],
  ] as const) {
    test(`${name} server resolves once mimo reports it is listening`, async () => {
      const server = await create({ port: 4096, timeout: 5000 })
      try {
        expect(server.url).toBe("http://127.0.0.1:4096")
        expect(await argv()).toEqual(["serve", "--hostname=127.0.0.1", "--port=4096"])
      } finally {
        server.close()
      }
    })
  }

  test("tui launches mimo with the requested options", async () => {
    const tui = createOpencodeTui({ model: "test/model", agent: "build" })
    try {
      // The TUI launcher returns immediately, so wait for the fake to record its argv.
      const deadline = Date.now() + 5000
      while (!(await Bun.file(path.join(bin.path, "argv")).exists()) && Date.now() < deadline) await Bun.sleep(20)
      expect(await argv()).toEqual(["--model=test/model", "--agent=build"])
    } finally {
      tui.close()
    }
  })
})
