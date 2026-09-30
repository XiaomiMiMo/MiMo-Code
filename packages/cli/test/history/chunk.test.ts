import { test, expect } from "bun:test"
import { basePartId } from "../../src/history/chunk"

test("basePartId strips chunk suffix only", () => {
  expect(basePartId("prt_abc")).toBe("prt_abc")
  expect(basePartId("prt_abc#0")).toBe("prt_abc")
  expect(basePartId("prt_abc#12")).toBe("prt_abc")
  expect(basePartId("prt_abc#x")).toBe("prt_abc#x")
  expect(basePartId("#0")).toBe("#0")
})
