import { describe, test, expect } from "bun:test"
import type { Route, SessionRoute } from "../../../src/cli/cmd/tui/context/route"

describe("SessionRoute.agentID", () => {
  test("type accepts agentID field", () => {
    const r: SessionRoute = {
      type: "session",
      sessionID: "ses_x",
      agentID: "actor_y",
    }
    expect(r.agentID).toBe("actor_y")
  })

  test("agentID is optional", () => {
    const r: SessionRoute = {
      type: "session",
      sessionID: "ses_x",
    }
    expect(r.agentID).toBeUndefined()
  })

  test("Route discriminated union still typechecks without agentID", () => {
    const r: Route = { type: "home" }
    expect(r.type).toBe("home")
  })
})
