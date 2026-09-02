/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta } from "@mimo-ai/plugin/tui"
import plugin from "../../../src/cli/cmd/tui/feature-plugins/sidebar/files"

function api(files: Array<{ file: string; additions: number; deletions: number }>) {
  let slot: ((ctx: unknown, props: { session_id: string }) => unknown) | undefined
  return {
    value: {
      theme: {
        current: {
          text: "white",
          textMuted: "gray",
          diffAdded: "green",
          diffRemoved: "red",
        },
      },
      state: {
        session: {
          diff: () => files,
        },
      },
      slots: {
        register(input: { slots: { sidebar_content: typeof slot } }) {
          slot = input.slots.sidebar_content
        },
      },
    },
    view() {
      if (!slot) throw new Error("sidebar slot was not registered")
      return slot({}, { session_id: "session-id" })
    },
  }
}

test("modified file paths wrap in narrow sidebars without hiding diff counts", async () => {
  const sidebar = api([
    {
      file: "packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/files.tsx",
      additions: 12,
      deletions: 3,
    },
  ])

  await plugin.tui(sidebar.value as unknown as TuiPluginApi, undefined, {
    id: "internal:sidebar-files",
    source: "internal",
    spec: "internal:sidebar-files",
    target: "internal:sidebar-files",
    first_time: 0,
    last_time: 0,
    time_changed: 0,
    load_count: 1,
    fingerprint: "",
    state: "same",
  } satisfies TuiPluginMeta)

  const app = await testRender(() => <box width={28}>{sidebar.view()}</box>, { width: 28, height: 8 })

  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("plugins/sidebar/files")
    expect(frame).toContain(".tsx")
    expect(frame).toContain("+12")
    expect(frame).toContain("-3")
  } finally {
    app.renderer.destroy()
  }
})
