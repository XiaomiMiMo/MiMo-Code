/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ContextSidebar } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/context"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

test("sidebar compares the configured context limit with the model limit", async () => {
  const api = createTuiPluginApi({
    state: {
      config: { compaction: { max_context: { "test/gpt": 300_000 } } } as never,
      provider: [
        {
          id: "test",
          models: {
            gpt: {
              id: "gpt",
              providerID: "test",
              limit: { context: 922_000, input: 922_000, output: 128_000 },
            },
          },
        },
      ] as never,
      session: {
        messages: () =>
          [
            {
              id: "msg",
              role: "assistant",
              providerID: "test",
              modelID: "gpt",
              cost: 0,
              tokens: { input: 100_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, completed: 2 },
            },
          ] as never,
      },
    },
  })

  const app = await testRender(() => <ContextSidebar api={api} session_id="ses" />)
  await app.renderOnce()

  expect(app.captureCharFrame()).toContain("33% used")
  expect(app.captureCharFrame()).toContain("limit 300K of 922K")
})
