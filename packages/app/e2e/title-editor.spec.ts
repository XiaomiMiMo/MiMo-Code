import { expect, test } from "@playwright/test"

// ST-R3: opening snapshot, explicit conflict confirmation, and response lifetime.
test("golden rename waits for the SDK PATCH and applies the committed title", async ({ page }) => {
  const requests: unknown[] = []
  await page.route("**/session/ses_a", async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ json: { id: "ses_a", title: "My title", titleSource: "user", titleRevision: 2 } })
  })
  await page.goto("/e2e/title-editor.html")
  await page.getByRole("button", { name: "Rename", exact: true }).click()
  await page.getByRole("textbox").fill(" My title ")
  await page.getByRole("textbox").press("Enter")
  await expect(page.getByRole("textbox")).toHaveCount(0)
  await expect(page.getByRole("heading")).toHaveText("My title")
  expect(requests).toEqual([{ title: "My title", expectedRevision: 1 }])
})

test("unchanged fallback stays uninitialized without a rename request", async ({ page }) => {
  const requests: string[] = []
  page.on("request", request => { if (request.method() === "PATCH") requests.push(request.url()) })
  await page.goto("/e2e/title-editor.html?fallback=1")
  await page.getByRole("button", { name: "Rename", exact: true }).click()
  await page.getByRole("textbox").press("Enter")
  await expect(page.getByRole("textbox")).toHaveCount(0)
  await expect(page.getByRole("heading")).toHaveText("Untitled")
  await expect(page.getByTestId("revision")).toHaveText("0")
  expect(requests).toEqual([])
})

test("unchanged Enter after an AI update closes without PATCH",  async ({ page }) => {
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.method() === "PATCH") requests.push(request.url())
  })
  await page.goto("/e2e/title-editor.html")
  await page.getByRole("button", { name: "Rename", exact: true }).click()
  await page.getByRole("textbox").fill("  Opening title  ")
  await page.getByRole("button", { name: "AI update" }).click()
  await page.getByRole("textbox").press("Enter")
  await expect(page.getByRole("textbox")).toHaveCount(0)
  await expect(page.getByRole("heading")).toHaveText("AI title")
  expect(requests).toEqual([])
})

test("409 retains the draft and requires a visible confirmation before using the new revision", async ({ page }) => {
  const requests: unknown[] = []
  await page.route("**/session/ses_a", async (route) => {
    requests.push(route.request().postDataJSON())
    if (requests.length === 1) {
      await route.fulfill({
        status: 409,
        json: {
          name: "TitleConflictError",
          data: { current: { sessionID: "ses_a", title: "Other writer", titleSource: "user", titleRevision: 3 } },
        },
      })
      return
    }
    await route.fulfill({ json: { id: "ses_a", title: "My draft", titleSource: "user", titleRevision: 4 } })
  })
  await page.goto("/e2e/title-editor.html")
  await page.getByRole("button", { name: "Rename", exact: true }).click()
  await page.getByRole("textbox").fill("My draft")
  await page.getByRole("textbox").press("Enter")
  await expect(page.getByRole("alert")).toContainText("Other writer")
  await expect(page.getByRole("textbox")).toHaveValue("My draft")
  await expect(page.getByRole("heading")).toHaveText("Other writer")
  await page.screenshot({ path: test.info().outputPath("title-conflict.png") })
  await page.getByRole("textbox").press("Enter")
  expect(requests).toHaveLength(1)
  await page.getByRole("button", { name: "Save my title instead" }).click()
  await expect(page.getByRole("textbox")).toHaveCount(0)
  await expect(page.getByRole("heading")).toHaveText("My draft")
  expect(requests).toEqual([
    { title: "My draft", expectedRevision: 1 },
    { title: "My draft", expectedRevision: 3 },
  ])
})

test("explicit conflict confirmation can restore the opening title", async ({ page }) => {
  const requests: unknown[] = []
  await page.route("**/session/ses_a", async route => {
    requests.push(route.request().postDataJSON())
    await route.fulfill(requests.length === 1
      ? { status: 409, json: { name: "TitleConflictError", data: { current: { sessionID: "ses_a", title: "Other writer", titleSource: "user", titleRevision: 3 } } } }
      : { json: { id: "ses_a", title: "Opening title", titleSource: "user", titleRevision: 4 } })
  })
  await page.goto("/e2e/title-editor.html")
  await page.getByRole("button", { name: "Rename", exact: true }).click()
  await page.getByRole("textbox").fill("My draft")
  await page.getByRole("textbox").press("Enter")
  await expect(page.getByRole("alert")).toContainText("Other writer")
  await page.getByRole("textbox").fill("Opening title")
  await page.getByRole("textbox").press("Enter")
  expect(requests).toHaveLength(1)
  await page.getByRole("button", { name: "Save my title instead" }).click()
  await expect(page.getByRole("textbox")).toHaveCount(0)
  expect(requests[1]).toEqual({ title: "Opening title", expectedRevision: 3 })
})

test("missing response snapshot retains the unsaved draft", async ({ page }) => {
  await page.route("**/session/ses_a", route => route.fulfill({ json: {} }))
  await page.goto("/e2e/title-editor.html")
  await page.getByRole("button", { name: "Rename", exact: true }).click()
  await page.getByRole("textbox").fill("My draft")
  await page.getByRole("textbox").press("Enter")
  await expect(page.getByRole("textbox")).toHaveValue("My draft")
  await expect(page.getByText(/Title update returned no matching session snapshot/)).toBeVisible()
})

for (const response of ["success", "conflict"] as const) {
  for (const action of ["Switch session", "Close editor"]) {
    test(`late ${response} after ${action} cannot affect a new editor`, async ({ page }) => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route("**/session/ses_a", async (route) => {
        await gate
        await route.fulfill(
          response === "success"
            ? { json: { id: "ses_a", title: "Late title", titleSource: "user", titleRevision: 4 } }
            : {
                status: 409,
                json: {
                  name: "TitleConflictError",
                  data: {
                    current: { sessionID: "ses_a", title: "Late conflict", titleSource: "user", titleRevision: 4 },
                  },
                },
              },
        )
      })
      await page.goto("/e2e/title-editor.html")
      await page.getByRole("button", { name: "Rename", exact: true }).click()
      await page.getByRole("textbox").fill("First draft")
      const sent = page.waitForRequest((request) => request.method() === "PATCH")
      await page.getByRole("textbox").press("Enter")
      await sent
      await page.getByRole("button", { name: action, exact: true }).click()
      await page.getByRole("button", { name: "Rename", exact: true }).click()
      await page.getByRole("textbox").fill("New draft")
      const received = page.waitForResponse((response) => response.request().method() === "PATCH")
      release()
      await received
      await expect(page.getByRole("textbox")).toHaveValue("New draft")
      await expect(page.getByRole("alert")).toHaveCount(0)
      await expect(page.getByRole("heading")).toHaveText(
        action === "Switch session" ? "Second session" : "Opening title",
      )
    })
  }
}
