/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@mimo-ai/sdk/v2"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"
import { DIRECTORY_DENIED_CODE } from "../../../src/server/routes/instance/access"

const DENIED = "/somewhere/outside/the/server/cwd"

afterEach(() => {
  delete process.env.MIMOCODE_FAST_BOOT
})

async function wait(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

/**
 * Stands in for a server whose instance middleware refuses the requested
 * directory. Shape matches `InstanceMiddleware`: HTTP 403 + a JSON body carrying
 * the stable `code`.
 */
function denyingFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
}

const events = {
  subscribe: async () => () => {},
}

async function mount(fetchDouble: typeof fetch) {
  // SyncProvider gates its children behind `ready` (status !== "loading"), which a
  // failing bootstrap never reaches — reuse the fast-boot escape hatch so the probe
  // mounts and can drive bootstrap directly.
  process.env.MIMOCODE_FAST_BOOT = "1"
  const exits: unknown[] = []
  let sync!: ReturnType<typeof useSync>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  const app = await testRender(() => (
    <ExitProvider
      onExit={async () => {
        exits.push("exit")
      }}
    >
      <ArgsProvider>
        <SDKProvider url="http://test" directory="/tmp/root" fetch={fetchDouble} events={events as never}>
          <ProjectProvider>
            <SyncProvider>
              <Probe
                onReady={(ctx) => {
                  sync = ctx
                  ready()
                }}
              />
            </SyncProvider>
          </ProjectProvider>
        </SDKProvider>
      </ArgsProvider>
    </ExitProvider>
  ))

  await mounted
  return { app, exits, sync }
}

function Probe(props: { onReady: (sync: ReturnType<typeof useSync>) => void }) {
  const sync = useSync()
  onMount(() => props.onReady(sync))
  return <box />
}

describe("tui bootstrap directory rejection", () => {
  test("a 403 from the instance middleware never reaches the fatal-exit path", async () => {
    const { app, exits, sync } = await mount(
      denyingFetch(403, {
        code: DIRECTORY_DENIED_CODE,
        error: "Access denied: directory must be within the server's working directory",
        directory: DENIED,
      }),
    )

    try {
      const failure = await sync.bootstrap().then(
        () => undefined,
        (e) => e,
      )

      // Surfaced to the caller so it can restore the previous directory + toast...
      expect(failure).toBeDefined()
      expect((failure as { code?: string }).code).toBe(DIRECTORY_DENIED_CODE)
      expect((failure as { directory?: string }).directory).toBe(DENIED)
      // ...and the TUI is still alive: exit() was never invoked.
      await Bun.sleep(50)
      expect(exits).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })

  test("a genuinely fatal bootstrap failure still exits", async () => {
    const { app, exits } = await mount(denyingFetch(500, { error: "boom" }))

    try {
      // The mount-time bootstrap is enough: a 500 is not a recoverable policy
      // rejection, so the fatal path must still fire.
      await wait(() => exits.length > 0)
      expect(exits).toEqual(["exit"])
    } finally {
      app.renderer.destroy()
    }
  })
})
