import { expect, test } from "bun:test"
import { mountQuestionTui, waitFor } from "./question-reconnect.fixture"

test("an actual pending modal survives HTTP instance dispose and remains answerable", async () => {
  const h = await mountQuestionTui()
  try {
    const question = await h.ask()
    expect(await h.wire("/instance/dispose")).toEqual({ status: 200, result: true })
    expect((await h.pending()).map((q) => q.id)).toEqual([question.id])
    expect(h.sync.data.question[h.session.id]?.[0]?.id).toBe(question.id)
    h.app.mockInput.pressEnter()
    await waitFor(async () => (await h.pending()).length === 0, "valid answer removes backend request")
    await waitFor(() => !h.sync.data.question[h.session.id]?.length, "valid answer closes actual modal")
    await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("NO_PENDING_QUESTION")
  } finally {
    await h.close()
  }
}, 30000)

test("a rejection lost during SSE disconnection is reconciled after reconnect and closes the modal", async () => {
  const h = await mountQuestionTui()
  try {
    const question = await h.ask()
    const connectedBefore = h.connected
    h.transport.pause()
    expect(await h.wire(`/question/${question.id}/reject`)).toEqual({ status: 200, result: true })
    expect(await h.pending()).toHaveLength(0)
    // The stale question stays visible while its terminal event is lost.
    expect(h.sync.data.question[h.session.id]?.[0]?.id).toBe(question.id)
    const readsBefore = h.transport.requests.filter((r) => r.path === "/question").length
    h.transport.resume()
    await waitFor(() => h.connected > connectedBefore, "real SSE reconnect after lost rejection")
    await waitFor(() => !h.sync.data.question[h.session.id]?.length, "reconnect clears the orphaned modal")
    await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("NO_PENDING_QUESTION")
    expect(h.receivedEvents).not.toContain("question.rejected")
    expect(h.transport.requests.filter((r) => r.path === "/question").slice(readsBefore)).toContainEqual({
      method: "GET",
      path: "/question",
      status: 200,
      result: [],
    })
  } finally {
    await h.close()
  }
}, 30000)

test("a still-pending modal survives a real SSE reconnect and can be rejected", async () => {
  const h = await mountQuestionTui()
  try {
    const question = await h.ask()
    const connectedBefore = h.connected
    h.transport.pause()
    expect((await h.pending()).map((q) => q.id)).toEqual([question.id])
    h.transport.resume()
    await waitFor(() => h.connected > connectedBefore, "actual SDK SSE reconnect")
    expect(h.sync.data.question[h.session.id]?.[0]?.id).toBe(question.id)
    await h.app.mockInput.pressKeys(["ESCAPE"])
    await waitFor(async () => (await h.pending()).length === 0, "valid rejection removes backend request")
    await waitFor(() => !h.sync.data.question[h.session.id]?.length, "valid rejection closes actual modal")
    await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("NO_PENDING_QUESTION")
  } finally {
    await h.close()
  }
}, 30000)
