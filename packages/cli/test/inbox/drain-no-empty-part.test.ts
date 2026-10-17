import { describe, expect, test } from "bun:test"
import { renderInboxRow } from "../../src/inbox/render"

describe("Inbox rendered input content", () => {
  for (const content of [null, {}, { text: "" }, { text: " \n\t " }]) {
    test(`notification placeholder for ${JSON.stringify(content)}`, () => {
      expect(renderInboxRow({ type: "actor_notification", content, created_at: 0 })).toBe("(no notification body)")
    })
    test(`text placeholder for ${JSON.stringify(content)}`, () => {
      const rendered = renderInboxRow({ type: "text", content, created_at: 0, sender_session_id: "session", sender_actor_id: "sender" })
      expect(rendered).toBe('<inbox from="session:sender" sent_at="1970-01-01T00:00:00.000Z">\n(empty)\n</inbox>')
    })
  }
  test("notification content passes through unchanged", () => {
    const text = "<actor-notification>\nchild completed\n</actor-notification>"
    expect(renderInboxRow({ type: "actor_notification", content: { text }, created_at: 0 })).toBe(text)
  })
})
