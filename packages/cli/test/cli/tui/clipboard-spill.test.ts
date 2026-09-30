import { test, expect } from "bun:test"
import { spillImage } from "../../../src/cli/cmd/tui/util/clipboard"
import fs from "fs/promises"

test("spillImage writes base64 to a temp png and returns its path", async () => {
  const onePxPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  const p = await spillImage({ data: onePxPng, mime: "image/png" })
  expect(p.endsWith(".png")).toBe(true)
  const bytes = await fs.readFile(p)
  expect(bytes.length).toBeGreaterThan(0)
  await fs.rm(p, { force: true })
})
