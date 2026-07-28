import { describe, test, expect } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { nextToast, type ToastOptions } from "../../../src/cli/cmd/tui/ui/toast"

// Each toast REPLACES the one on screen, but solid MERGES plain objects into the
// existing store node — so a toast that omits the optional `title` used to
// inherit the headline of the toast it replaced. `toast.error(err)` passes only
// { variant, message }, so a failure rendered under an unrelated success title.
function harness() {
  return createRoot((dispose) => {
    const [store, setStore] = createStore<{ currentToast: Omit<ToastOptions, "duration"> | null }>({
      currentToast: null,
    })
    return {
      store,
      // Mirrors toast.show(): duration is stripped, the rest becomes the toast.
      show: (options: Omit<ToastOptions, "duration">) => setStore("currentToast", nextToast(options)),
      expire: () => setStore("currentToast", null),
      dispose,
    }
  })
}

describe("nextToast", () => {
  test("a titled toast does not lend its title to the next untitled toast", () => {
    const h = harness()
    h.show({ title: "Session deleted", message: "3 sessions removed", variant: "success" })
    expect(h.store.currentToast).toEqual({
      title: "Session deleted",
      message: "3 sessions removed",
      variant: "success",
    })

    // toast.error(err) — raised before the 5s timer clears the previous toast.
    h.show({ message: "Failed to send message", variant: "error" })
    expect(h.store.currentToast?.title).toBeUndefined()
    expect(h.store.currentToast).toEqual({ message: "Failed to send message", variant: "error" })
    h.dispose()
  })

  test("a title is replaced, not accumulated, between titled toasts", () => {
    const h = harness()
    h.show({ title: "Plugin added", message: "acme", variant: "success" })
    h.show({ title: "Plugin removed", message: "acme", variant: "info" })
    expect(h.store.currentToast).toEqual({ title: "Plugin removed", message: "acme", variant: "info" })
    h.dispose()
  })

  test("the first toast after an expiry is stored as-is", () => {
    const h = harness()
    h.show({ title: "Export complete", message: "/tmp/out.md", variant: "success" })
    h.expire()
    h.show({ message: "Failed to send message", variant: "error" })
    expect(h.store.currentToast).toEqual({ message: "Failed to send message", variant: "error" })
    h.dispose()
  })

  test("the first toast for a fresh store is stored as-is", () => {
    const h = harness()
    h.show({ title: "Welcome", message: "hello", variant: "info" })
    expect(h.store.currentToast).toEqual({ title: "Welcome", message: "hello", variant: "info" })
    h.dispose()
  })
})
