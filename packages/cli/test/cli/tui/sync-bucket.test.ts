import { describe, test, expect } from "bun:test"
import { bucketMessages } from "../../../src/cli/cmd/tui/context/sync"

describe("bucketMessages", () => {
  test("undefined agentID lands in main bucket", () => {
    const out = bucketMessages([{ id: "m1", agentID: undefined } as any])
    expect(out).toEqual({ main: [{ id: "m1", agentID: undefined }] })
  })

  test("explicit main lands in main", () => {
    const out = bucketMessages([{ id: "m1", agentID: "main" } as any])
    expect(out).toEqual({ main: [{ id: "m1", agentID: "main" }] })
  })

  test("subagent agentID lands in its own bucket", () => {
    const out = bucketMessages([
      { id: "m1", agentID: "main" } as any,
      { id: "m2", agentID: "explore-1" } as any,
      { id: "m3", agentID: "explore-1" } as any,
    ])
    expect(out).toEqual({
      main: [{ id: "m1", agentID: "main" }],
      "explore-1": [
        { id: "m2", agentID: "explore-1" },
        { id: "m3", agentID: "explore-1" },
      ],
    })
  })
})
