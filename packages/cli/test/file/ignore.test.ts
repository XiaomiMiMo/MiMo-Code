import { test, expect } from "bun:test"
import { FileIgnore } from "../../src/file/ignore"

test("match nested and non-nested", () => {
  expect(FileIgnore.match("node_modules/index.js")).toBe(true)
  expect(FileIgnore.match("node_modules")).toBe(true)
  expect(FileIgnore.match("node_modules/")).toBe(true)
  expect(FileIgnore.match("node_modules/bar")).toBe(true)
  expect(FileIgnore.match("node_modules/bar/")).toBe(true)
})

test("ignores .mypy_cache", () => {
  expect(FileIgnore.match(".mypy_cache/foo.json")).toBe(true)
  expect(FileIgnore.match(".mypy_cache")).toBe(true)
  expect(FileIgnore.match("src/.mypy_cache/cache.data")).toBe(true)
  expect(FileIgnore.match(".mypy_cache\\foo.json")).toBe(true)
})
