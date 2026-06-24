import { expect, test } from "bun:test"
import path from "path"

const source = () => Bun.file(path.join(__dirname, "../../src/cli/cmd/run.ts")).text()

test("dangerously-skip-permissions does not auto-approve manual approval requests", async () => {
  expect(await source()).toContain(
    'args["dangerously-skip-permissions"] && !Permission.requiresManualApproval(permission.metadata)',
  )
})
