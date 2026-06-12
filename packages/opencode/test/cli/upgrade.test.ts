import { afterEach, describe, expect, mock, test } from "bun:test"

const errors: string[] = []
const warnings: string[] = []
const runtimeResults: unknown[] = []

mock.module("@clack/prompts", () => ({
  intro: mock(() => undefined),
  outro: mock(() => undefined),
  select: mock(() => Promise.resolve(false)),
  spinner: mock(() => ({
    start: mock(() => undefined),
    stop: mock(() => undefined),
  })),
  log: {
    error: mock((message: string) => errors.push(message)),
    info: mock(() => undefined),
    warn: mock((message: string) => warnings.push(message)),
  },
}))

mock.module("@/effect/app-runtime", () => ({
  AppRuntime: {
    runPromise: mock(() => Promise.resolve(runtimeResults.shift())),
  },
}))

import { UpgradeCommand } from "../../src/cli/cmd/upgrade"

describe("UpgradeCommand", () => {
  afterEach(() => {
    errors.length = 0
    warnings.length = 0
    runtimeResults.length = 0
  })

  test("uses the MiMoCode name when the install method is unknown", async () => {
    runtimeResults.push("unknown")

    await UpgradeCommand.handler({})

    expect(errors).toContain(`mimocode is installed to ${process.execPath} and may be managed by a package manager`)
    expect(errors.join("\n")).not.toContain("opencode")
  })

  test("uses the MiMoCode name when the target version is already installed", async () => {
    runtimeResults.push("unknown")

    await UpgradeCommand.handler({ method: "npm", target: "local" })

    expect(warnings).toContain("mimocode upgrade skipped: local is already installed")
    expect(warnings.join("\n")).not.toContain("opencode")
  })
})
