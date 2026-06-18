import { describe, expect, test } from "bun:test"
import { createIssueURL } from "../../../src/cli/cmd/tui/component/error-component"

describe("createIssueURL", () => {
  test("points fatal error reports at the MiMo Code issue tracker", () => {
    const url = createIssueURL(new Error("boom"))
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/XiaomiMiMo/MiMo-Code/issues/new")
    expect(url.searchParams.get("template")).toBe("bug-report.yml")
    expect(url.searchParams.get("title")).toBe("opentui: fatal: boom")
  })
})
