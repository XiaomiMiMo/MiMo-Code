import { expect, test } from "bun:test"
import { Hono } from "hono"
import { tmpdir } from "../fixture/fixture"
import { InstanceMiddleware } from "../../src/server/routes/instance/middleware"
import { Instance } from "../../src/project/instance"
import * as D from "../../src/superagent/dispatcher"

test("directory fence admits an owned task worktree but rejects unrelated directories", async () => {
  await using root = await tmpdir({ outsideGit: true })
  await using owned = await tmpdir({ outsideGit: true })
  await using unrelated = await tmpdir({ outsideGit: true })
  const cwd = process.cwd()
  try {
    process.chdir(root.path)
    const input = D.request(
      root.path,
      { channel: "local", eventId: "example", threadId: "example", senderId: "user" },
      "Example",
    )
    const ticket = D.create(root.path, input.id, "Example")
    ticket.worktree = owned.path
    D.save(ticket)
    const app = new Hono().use(InstanceMiddleware()).get("/", (c) => c.json({ ok: true }))
    expect((await app.request(`/?directory=${encodeURIComponent(owned.path)}`)).status).toBe(200)
    expect((await app.request(`/?directory=${encodeURIComponent(unrelated.path)}`)).status).toBe(403)
    expect(() => D.get(unrelated.path, ticket.id)).toThrow("not found")
  } finally {
    process.chdir(cwd)
    await Instance.disposeAll()
  }
})
