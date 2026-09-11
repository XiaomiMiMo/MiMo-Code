import { describe, expect, test, mock } from "bun:test"

// Mock the 'electron' module before importing install-cli
const mockApp = {
  getPath: (name: string) => `/tmp/test-user-data`,
}

mock.module("electron", () => ({
  app: mockApp,
}))

describe("install-cli", () => {
  test("module compiles and exports installCli function", async () => {
    const mod = await import("./install-cli")
    expect(mod.installCli).toBeDefined()
    expect(typeof mod.installCli).toBe("function")
  })

  test("installCli returns a path string", async () => {
    const mod = await import("./install-cli")
    const result = await mod.installCli()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })
})
