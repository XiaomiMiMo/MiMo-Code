/** @jsxImportSource @opentui/solid */
import "./bootstrap-test-home"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, onMount, type ParentProps } from "solid-js"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { LanguageProvider } from "../../../src/cli/cmd/tui/context/language"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"
import { CommandProvider, useCommandDialog } from "../../../src/cli/cmd/tui/component/dialog-command"
import type { TuiConfig } from "../../../src/cli/cmd/tui/config/tui"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

const config: TuiConfig.Info = {
  plugin: [],
  plugin_origins: [],
  keybinds: {
    // The real defaults come from the config schema; only this binding matters
    // here — it is the one that stole ←/→ from the permission prompt.
    session_child_cycle: "right",
  },
}

// The Session route runs this exact effect against its pending-permission
// signal while the input (and its text-editing focus guard) is unmounted.
function ModalGate(props: ParentProps<{ pending: () => boolean }>) {
  const command = useCommandDialog()
  createEffect(() => {
    if (!props.pending()) return
    command.keybinds(false)
    onCleanup(() => command.keybinds(true))
  })
  return <>{props.children}</>
}

function Probe(props: { hits: number[]; onReady: () => void }) {
  const command = useCommandDialog()
  command.register(() => [
    {
      title: "probe",
      value: "test.probe.next",
      keybind: "session_child_cycle",
      hidden: true,
      onSelect: () => {
        props.hits.push(props.hits.length + 1)
      },
    },
  ])
  // useKeyboard subscribers register in onMount, which flushes after the first
  // render — wait for the innermost mount before the harness is handed back.
  onMount(() => props.onReady())
  return <box />
}

async function mount() {
  const hits: number[] = []
  const [pending, setPending] = createSignal(false)
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(
    () => (
      <KVProvider>
        <TuiConfigProvider config={config}>
          <LanguageProvider>
            <KeybindProvider>
              <ToastProvider>
                <DialogProvider>
                  <CommandProvider>
                    <ModalGate pending={pending}>
                      <Probe hits={hits} onReady={done} />
                    </ModalGate>
                  </CommandProvider>
                </DialogProvider>
              </ToastProvider>
            </KeybindProvider>
          </LanguageProvider>
        </TuiConfigProvider>
      </KVProvider>
    ),
    { width: 40, height: 10 },
  )
  await app.renderOnce()
  await ready
  return { app, hits, setPending }
}

test("command keybind fires normally while no modal is pending", async () => {
  const { app, hits } = await mount()
  try {
    app.mockInput.pressArrow("right")
    await wait(() => hits.length === 1)
    expect(hits).toEqual([1])
  } finally {
    app.renderer.destroy()
  }
})

test("command keybind is suspended while the modal gate is active", async () => {
  const { app, hits, setPending } = await mount()
  try {
    // positive control: the binding routes before the gate closes
    app.mockInput.pressArrow("right")
    await wait(() => hits.length === 1)

    setPending(true)
    await app.renderOnce()
    await Bun.sleep(30)
    app.mockInput.pressArrow("right")
    await Bun.sleep(50)
    expect(hits.length).toBe(1)

    // resumption: closing the modal gives the keybind back
    setPending(false)
    await app.renderOnce()
    app.mockInput.pressArrow("right")
    await wait(() => hits.length === 2)
  } finally {
    app.renderer.destroy()
  }
})
