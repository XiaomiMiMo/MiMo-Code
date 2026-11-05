import { expect, test } from "bun:test"
import { directoryA, directoryB, mountQuestions, question, waitFor } from "./question-sync.fixture"

test("bootstrap restores questions that were asked before this TUI connected", async () => {
  const first = question("que_example_1")
  const second = question("que_example_2", "ses_other")
  const view = await mountQuestions([second, first])
  try {
    expect(view.ids()).toEqual([first.id, second.id])
    expect(view.reads).toHaveLength(1)
  } finally {
    view.app.renderer.destroy()
  }
})

test("an empty snapshot cannot remove a question asked while the snapshot was in flight", async () => {
  const request = question("que_example_1")
  const view = await mountQuestions()
  const gate = view.holdNextRead()
  try {
    await view.connected()
    await waitFor(() => gate.started)
    view.setSnapshot([request])
    await view.asked(request)
    const afterAsk = view.history.length
    gate.release()
    await waitFor(() => view.reads.length === 3 && view.reads.every((r) => r.completed))
    expect(view.ids()).toEqual([request.id])
    expect(view.history.slice(afterAsk).every((ids) => ids.includes(request.id))).toBe(true)
  } finally {
    gate.release()
    view.app.renderer.destroy()
  }
})

test("a late snapshot cannot resurrect a question rejected while it was in flight", async () => {
  const request = question("que_example_1")
  const view = await mountQuestions([request])
  const gate = view.holdNextRead()
  try {
    await view.connected()
    await waitFor(() => gate.started)
    view.setSnapshot([])
    await view.rejected(request)
    const afterReject = view.history.length
    gate.release()
    await waitFor(() => view.reads.length === 3 && view.reads.every((r) => r.completed))
    expect(view.ids()).toEqual([])
    expect(view.history.slice(afterReject).every((ids) => !ids.includes(request.id))).toBe(true)
  } finally {
    gate.release()
    view.app.renderer.destroy()
  }
})

test("an older reconnect response cannot overwrite a newer snapshot", async () => {
  const request = question("que_example_1")
  const view = await mountQuestions()
  const gate = view.holdNextRead()
  try {
    await view.connected()
    await waitFor(() => gate.started)
    view.setSnapshot([request])
    await view.connected()
    await waitFor(() => view.ids().includes(request.id))
    const afterNewer = view.history.length
    gate.release()
    await waitFor(() => view.reads.every((r) => r.completed))
    await view.app.renderOnce()
    expect(view.ids()).toEqual([request.id])
    expect(view.history.slice(afterNewer).every((ids) => ids.includes(request.id))).toBe(true)
  } finally {
    gate.release()
    view.app.renderer.destroy()
  }
})

test("a snapshot from the previous directory cannot clear the current directory's questions", async () => {
  const request = question("que_example_b")
  const view = await mountQuestions()
  const gate = view.holdNextRead(directoryA)
  try {
    await view.connected()
    await waitFor(() => gate.started)
    view.setSnapshot([request], directoryB)
    view.sdk.switchDirectory(directoryB)
    await view.sync.bootstrap({ fatal: false })
    await waitFor(() => view.ids().includes(request.id))
    gate.release()
    await waitFor(() => view.reads.every((r) => r.completed))
    await view.app.renderOnce()
    expect(view.ids()).toEqual([request.id])
    expect(view.project.instance.directory()).toBe(directoryB)
  } finally {
    gate.release()
    view.app.renderer.destroy()
  }
})

test("a failed list request preserves pending state and a later reconnect retries", async () => {
  const request = question("que_example_1")
  const view = await mountQuestions([request])
  try {
    view.setSnapshot([])
    view.failNextRead()
    await view.connected()
    await waitFor(() => view.reads.some((r) => r.status === 503 && r.completed))
    await view.app.renderOnce()
    expect(view.ids()).toEqual([request.id])
    await view.connected()
    await waitFor(() => view.ids().length === 0)
    expect(view.ids()).toEqual([])
  } finally {
    view.app.renderer.destroy()
  }
})

test("a response from a prior client is stale even after switching back to the same directory", async () => {
  const request = question("que_example_1")
  const view = await mountQuestions()
  const gate = view.holdNextRead()
  try {
    view.setSnapshot([request])
    await view.connected()
    await waitFor(() => gate.started)
    view.sdk.switchDirectory(directoryB)
    view.sdk.switchDirectory(directoryA)
    gate.release()
    await waitFor(() => view.reads.every((r) => r.completed))
    await view.app.renderOnce()
    expect(view.ids()).toEqual([])
  } finally {
    gate.release()
    view.app.renderer.destroy()
  }
})

test("changing workspace invalidates a pending question snapshot before another bootstrap starts", async () => {
  const request = question("que_example_1")
  const view = await mountQuestions()
  const gate = view.holdNextRead()
  try {
    view.setSnapshot([request])
    await view.connected()
    await waitFor(() => gate.started)
    view.project.workspace.set("example-workspace")
    gate.release()
    await waitFor(() => view.reads.every((r) => r.completed))
    await view.app.renderOnce()
    expect(view.ids()).toEqual([])
  } finally {
    gate.release()
    view.app.renderer.destroy()
  }
})

test("a list response finishing after unmount cannot update disposed question state", async () => {
  const request = question("que_example_1")
  const view = await mountQuestions([request])
  const gate = view.holdNextRead()
  try {
    view.setSnapshot([])
    await view.connected()
    await waitFor(() => gate.started)
    view.app.renderer.destroy()
    gate.release()
    await waitFor(() => view.reads.every((r) => r.completed))
    await Bun.sleep(10)
    expect(view.ids()).toEqual([request.id])
  } finally {
    gate.release()
  }
})
