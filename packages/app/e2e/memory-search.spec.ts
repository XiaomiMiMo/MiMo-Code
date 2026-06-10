import { expect, test } from "@playwright/test"
import {
  base64Encode,
  createGitProject,
  seedProjectMemory,
  waitForServer,
} from "./helpers"

const serverUrl = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const token = `e2e-memory-token-${Date.now()}`

test("memory search sidebar finds indexed project memory", async ({ page, request }) => {
  await waitForServer(request, serverUrl)

  const projectDir = await createGitProject()
  await seedProjectMemory(projectDir, `# Memory\n\n${token} lives in project memory`)

  const encoded = base64Encode(projectDir)
  await page.goto(`/${encoded}/session`)

  const fileTreeToggle = page.getByRole("button", { name: "Toggle file tree" })
  await expect(fileTreeToggle).toBeVisible()
  if ((await fileTreeToggle.getAttribute("aria-expanded")) !== "true") {
    await fileTreeToggle.click()
  }

  await page.getByTestId("filetree-tab-memory").click()
  await page.getByTestId("memory-search-input").locator("input").fill(token)

  const result = page.getByTestId("memory-search-result").first()
  await expect(result).toBeVisible({ timeout: 15_000 })
  await expect(result).toContainText("MEMORY.md")

  await result.click()
  await expect(page.getByTestId("memory-search-preview")).toContainText(token)
})
