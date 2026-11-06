import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import { GithubChannel, GithubConfig, githubInput } from "../../src/superagent/channels/github"
import { FeishuChannel, FeishuConfig, feishuInput } from "../../src/superagent/channels/feishu"
import type { ChannelInput } from "../../src/superagent/channel"
import type { Command } from "../../src/superagent/channels/command"
import { tmpdir } from "../fixture/fixture"

const comment = {
  id: 1,
  updated_at: "2026-01-01T00:00:00Z",
  issue_url: "https://api.github.com/repos/example/project/issues/12",
  body: "@example-bot fix the example",
  user: { login: "EXAMPLE-DEV", type: "User" },
}
const event = {
  message_id: "om_example",
  chat_id: "oc_example",
  chat_type: "group",
  sender_id: "ou_example_user",
  sender_type: "user",
  content: "Fix the example",
  mentions: [{ id: "ou_example_bot" }],
}
const bot = { botId: "ou_example_bot", appId: "cli_example" }
const wait = async (ready: () => boolean) => {
  const until = Date.now() + 3000
  while (!ready() && Date.now() < until) await Bun.sleep(10)
  expect(ready()).toBe(true)
}

test("GitHub adapter verifies mention boundaries, repository scope, self messages and bot messages", () => {
  expect(githubInput(comment, "example/project", "example-bot")).toMatchObject({
    senderId: "example-dev",
    threadId: "example/project#12",
    scopeId: "example/project",
    addressed: true,
  })
  expect(githubInput({ ...comment, body: "@example-bot-extra" }, "example/project", "example-bot")?.addressed).toBe(
    false,
  )
  expect(
    githubInput(
      { ...comment, issue_url: "https://api.github.com/repos/other/project/issues/12" },
      "example/project",
      "example-bot",
    ),
  ).toBeUndefined()
  expect(githubInput({ ...comment, user: { login: "EXAMPLE-BOT" } }, "example/project", "example-bot")).toBeUndefined()
  expect(
    githubInput({ ...comment, user: { login: "another-bot", type: "Bot" } }, "example/project", "example-bot"),
  ).toMatchObject({ human: false })
})
test("GitHub polling uses durable overlap and outgoing marker deduplication", async () => {
  const received: ChannelInput[] = [],
    writes: string[] = []
  let listed = [comment]
  const run: Command = async (_program, args, input) => {
    if (args[1] === "user") return JSON.stringify({ login: "example-bot" })
    if (args[1] === "repos/example/project/issues/12")
      return JSON.stringify({ number: 12, state: "open", html_url: "https://github.com/example/project/issues/12" })
    if (args.includes("POST")) {
      writes.push(input!)
      return JSON.stringify({ id: 42 })
    }
    return JSON.stringify([listed])
  }
  const adapter = new GithubChannel(
    GithubConfig.parse({
      kind: "github",
      id: "github-example",
      directory: "/tmp/example",
      repository: "example/project",
      allowedSenders: ["example-dev"],
    }),
    run,
  )
  try {
    await adapter.start(async (input) => {
      received.push(input)
    })
    await wait(() => received.length > 0)
    expect(adapter.health().connected).toBe(true)
    expect(received[0].threadId).toBe("example/project#12")
    const reply = {
      id: "reply-example",
      source: {
        channel: "github-example",
        eventId: "event-example",
        threadId: "example/project#12",
        senderId: "example-dev",
      },
      text: "Work finished",
    }
    expect(await adapter.send(reply)).toEqual({ messageId: "42" })
    expect(JSON.parse(writes[0]).body).toContain("mimo-superagent:reply-example")
    listed = [{ ...comment, id: 42, body: JSON.parse(writes[0]).body, user: { login: "example-bot", type: "User" } }]
    expect(await adapter.send(reply)).toEqual({ messageId: "42" })
    expect(writes).toHaveLength(1)
    await expect(adapter.send({ ...reply, source: { ...reply.source, threadId: "other/project#12" } })).rejects.toThrow(
      "outside",
    )
  } finally {
    await adapter.stop()
  }
})
test("Feishu normalization identifies direct and mentioned messages and retains topic roots", () => {
  expect(feishuInput({ ...event, root_id: "om_root" }, bot)).toMatchObject({
    threadId: "oc_example:om_root",
    scopeId: "oc_example",
    addressed: true,
  })
  expect(feishuInput({ ...event, mentions: [] }, bot)?.addressed).toBe(false)
  expect(feishuInput({ ...event, chat_type: "p2p", mentions: [] }, bot)?.addressed).toBe(true)
  expect(feishuInput({ ...event, sender_type: "bot" }, bot)).toBeUndefined()
  expect(feishuInput({ ...event, sender_id: bot.botId }, bot)).toBeUndefined()
})
test("followed PRs normalize inline reviews, CI snapshots and closure with stable event keys", async () => {
  const received: ChannelInput[] = []
  let closed = false
  const run: Command = async (_program, args) => {
    const path = args[1]
    if (path === "user") return JSON.stringify({ login: "example-bot" })
    if (path === "repos/example/project/issues/12")
      return JSON.stringify({
        number: 12,
        state: "open",
        html_url: "https://github.com/example/project/pull/12",
        pull_request: { url: "https://api.github.com/repos/example/project/pulls/12" },
      })
    if (path === "repos/example/project/pulls/12")
      return JSON.stringify({
        state: closed ? "closed" : "open",
        merged: closed,
        updated_at: "2026-01-02T00:00:00Z",
        html_url: "https://github.com/example/project/pull/12",
        head: { sha: "a".repeat(40) },
      })
    if (path.includes("/reviews?"))
      return JSON.stringify([
        [
          {
            id: 2,
            user: { login: "example-dev", type: "User" },
            state: "CHANGES_REQUESTED",
            submitted_at: "2026-01-01T00:00:00Z",
            body: "Cover the edge case",
          },
        ],
      ])
    if (path.includes("/pulls/12/comments?"))
      return JSON.stringify([
        [
          {
            id: 3,
            user: { login: "example-dev", type: "User" },
            updated_at: "2026-01-01T00:00:00Z",
            body: "Null is possible here",
            path: "src/example.ts",
            line: 4,
          },
        ],
      ])
    if (path.includes("/check-runs?"))
      return JSON.stringify([
        {
          check_runs: [
            {
              id: 4,
              name: "tests",
              status: "completed",
              conclusion: "failure",
              completed_at: "2026-01-01T00:00:00Z",
              html_url: null,
            },
          ],
        },
      ])
    return JSON.stringify([[]])
  }
  const adapter = new GithubChannel(
    GithubConfig.parse({
      kind: "github",
      id: "github-pr-example",
      directory: "/tmp/example",
      repository: "example/project",
      allowedSenders: ["example-dev"],
    }),
    run,
  )
  expect(await adapter.resolveThread("https://github.com/example/project/pull/12")).toMatchObject({
    threadId: "example/project#12",
    kind: "deliverable",
  })
  await expect(adapter.resolveThread("https://github.com/other/project/pull/12")).rejects.toThrow("outside")
  try {
    await adapter.start(async (input) => {
      received.push(input)
    })
    await wait(() => received.length === 3 && adapter.health().connected)
    expect(received[1].text).toContain("inline_review")
    expect(received[2]).toMatchObject({ human: false, addressed: false })
    expect(JSON.parse(received[2].text).checks[0].conclusion).toBe("failure")
    const keys = received.map((event) => event.eventId)
    await adapter.poll()
    expect(received.slice(3).map((event) => event.eventId)).toEqual(keys)
    closed = true
    await adapter.poll()
    expect(received.at(-1)).toMatchObject({ closed: "merged", threadId: "example/project#12" })
  } finally {
    await adapter.stop()
  }
})
test("Feishu consumer supervises a real CLI process and sends idempotent bot topic replies", async () => {
  await using tmp = await tmpdir()
  const file = `${tmp.path}/example-lark`
  await Bun.write(
    file,
    `#!/usr/bin/env bun\nprocess.stderr.write('[event] ready\\n');process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")});process.stdin.resume();process.stdin.on('end',()=>process.exit(0));\n`,
  )
  await chmod(file, 0o755)
  const received: ChannelInput[] = [],
    sent: string[][] = []
  const run: Command = async (_program, args) => {
    sent.push(args)
    return JSON.stringify({ ok: true, data: { message_id: "om_reply" } })
  }
  const config = FeishuConfig.parse({
    kind: "feishu",
    id: "feishu-example",
    directory: tmp.path,
    cli: file,
    ...bot,
    allowedSenders: [event.sender_id],
    chats: [event.chat_id],
  })
  const adapter = new FeishuChannel(config, run)
  try {
    await adapter.start(async (input) => {
      received.push(input)
    })
    await wait(() => received.length === 1 && adapter.health().connected)
    const receipt = await adapter.send({
      id: "reply-example",
      source: {
        channel: "feishu-example",
        eventId: event.message_id,
        threadId: received[0].threadId,
        senderId: event.sender_id,
      },
      text: "Result ready",
    })
    expect(receipt.messageId).toBe("om_reply")
    expect(sent[0]).toContain("--reply-in-thread")
    expect(sent[0]).toContain("--idempotency-key")
    expect(sent[0].slice(-4)).toEqual(["--as", "bot", "--format", "json"])
  } finally {
    await adapter.stop()
  }
  expect(adapter.health().connected).toBe(false)
})
