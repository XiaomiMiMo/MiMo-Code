import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
const command = `bun run dev -- --host 0.0.0.0 --port ${port}`
const reuse = !process.env.CI
const e2eHome = process.env.MIMOCODE_HOME ?? path.join(os.tmpdir(), "mimocode-playwright")
process.env.MIMOCODE_HOME = e2eHome
const opencodeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../opencode")
const serverUrl = `http://${serverHost}:${serverPort}`
const workers = Number(process.env.PLAYWRIGHT_WORKERS ?? (process.env.CI ? 5 : 0)) || undefined
const reporter = [["html", { outputFolder: "e2e/playwright-report", open: "never" }], ["line"]] as const

if (process.env.PLAYWRIGHT_JUNIT_OUTPUT) {
  reporter.push(["junit", { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT }])
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: process.env.PLAYWRIGHT_FULLY_PARALLEL === "1",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter,
  webServer: [
    {
      command: `bun run --conditions=browser ./src/index.ts serve --port ${serverPort}`,
      cwd: opencodeRoot,
      url: `${serverUrl}/global/health`,
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: {
        ...process.env,
        MIMOCODE_HOME: e2eHome,
      },
    },
    {
      command,
      url: baseURL,
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: {
        VITE_OPENCODE_SERVER_HOST: serverHost,
        VITE_OPENCODE_SERVER_PORT: serverPort,
      },
    },
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
