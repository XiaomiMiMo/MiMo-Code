import { describe, expect, test } from "bun:test"
import { spinnerFrames } from "../../../../src/cli/cmd/tui/component/spinner"

describe("status spinner", () => {
  test("uses one-column frames for stable prompt status layout", async () => {
    expect(spinnerFrames.map((frame) => Bun.stringWidth(frame))).toEqual(spinnerFrames.map(() => 1))

    const prompt = await Bun.file("src/cli/cmd/tui/component/prompt/index.tsx").text()
    expect(prompt).not.toContain('style: "plane"')
    expect(prompt).not.toContain("createFrames")
    expect(prompt).not.toContain("createColors")
    expect(prompt).toContain('import { Spinner } from "../spinner"')
  })
})
