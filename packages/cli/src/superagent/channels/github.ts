import z from "zod"
import { createHash } from "node:crypto"
import type { ChannelAdapter, ChannelInput, ChannelReply } from "../channel"
import { Database, eq } from "@/storage"
import { StateTable } from "../superagent.sql"
import { command, type Command } from "./command"

export const GithubConfig = z.strictObject({
  kind: z.literal("github"),
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  directory: z.string(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  allowedSenders: z.array(z.string().min(1)).min(1),
  cli: z.string().min(1).default("gh"),
  pollMs: z.number().int().min(5000).max(300000).default(15000),
})
export type GithubConfig = z.infer<typeof GithubConfig>
const Comment = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable(),
  updated_at: z.string().datetime(),
  issue_url: z.string(),
  user: z.object({ login: z.string(), type: z.string().optional() }),
})
const Listed = z.union([z.array(Comment), z.array(z.array(Comment))]).transform((pages) => pages.flat())
const marker = (id: string) => `<!-- mimo-superagent:${id} -->`
const Issue = z.object({
  number: z.number(),
  state: z.string(),
  html_url: z.string(),
  pull_request: z.object({ url: z.string() }).optional(),
})
const Pull = z.object({
  state: z.string(),
  merged: z.boolean(),
  updated_at: z.string(),
  html_url: z.string(),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
})
const Review = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user: z.object({ login: z.string(), type: z.string().optional() }),
  state: z.string().optional(),
  submitted_at: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  html_url: z.string().optional(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
})
const Check = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  completed_at: z.string().nullable(),
  html_url: z.string().nullable(),
})
const CommitStatus = z.object({
  id: z.number(),
  context: z.string(),
  state: z.string(),
  updated_at: z.string(),
  target_url: z.string().nullable(),
})
export function githubInput(raw: unknown, repository: string, login: string): ChannelInput | undefined {
  const comment = Comment.parse(raw),
    senderId = comment.user.login.toLowerCase()
  if (senderId === login.toLowerCase()) return
  const match = new RegExp(`/repos/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/(\\d+)$`).exec(
    comment.issue_url,
  )
  if (!match) return
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return {
    eventId: `comment-${comment.id}:${comment.updated_at}`,
    threadId: `${repository}#${match[1]}`,
    scopeId: repository,
    senderId,
    text: comment.body ?? "",
    human: comment.user.type !== "Bot",
    addressed: new RegExp(`(^|\\W)@${escaped}(?![A-Za-z0-9-])`, "i").test(comment.body ?? ""),
  }
}
export class GithubChannel implements ChannelAdapter {
  readonly idempotentSend = true
  private controller = new AbortController()
  private timer?: ReturnType<typeof setInterval>
  private busy = false
  private login = ""
  private status = { connected: false, detail: "Waiting for the first GitHub poll" }
  private receive?: (input: ChannelInput) => Promise<void>
  private watched = new Map<number, boolean | undefined>()
  constructor(
    private readonly config: GithubConfig,
    private readonly run: Command = command,
  ) {}
  health() {
    return this.status
  }
  watch(threadId: string) {
    const prefix = `${this.config.repository}#`
    if (!threadId.startsWith(prefix) || !/^\d+$/.test(threadId.slice(prefix.length))) return
    const number = Number(threadId.slice(prefix.length))
    if (!this.watched.has(number)) this.watched.set(number, undefined)
  }
  private async api(path: string, pages = false): Promise<unknown> {
    return JSON.parse(
      await this.run(
        this.config.cli,
        ["api", `repos/${this.config.repository}/${path}`, ...(pages ? ["--paginate", "--slurp"] : [])],
        undefined,
        this.controller.signal,
      ),
    )
  }
  async resolveThread(reference: string) {
    const escaped = this.config.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = new RegExp(`^(?:https://github\\.com/${escaped}/(?:pull|issues)/|${escaped}#)([1-9]\\d*)$`).exec(
      reference,
    )
    if (!match) throw new Error("Reference is outside the configured GitHub repository")
    const issue = Issue.parse(await this.api(`issues/${match[1]}`))
    this.watched.set(issue.number, !!issue.pull_request)
    const pull = issue.pull_request ? Pull.parse(await this.api(`pulls/${issue.number}`)) : undefined
    return {
      threadId: `${this.config.repository}#${issue.number}`,
      scopeId: this.config.repository,
      kind: pull ? ("deliverable" as const) : ("context" as const),
      url: issue.html_url,
      closed: pull?.state === "closed" ? (pull.merged ? ("merged" as const) : ("closed" as const)) : undefined,
    }
  }
  private async pollThreads() {
    if (!this.receive) return
    for (const [number, known] of this.watched) {
      const isPull = known ?? !!Issue.parse(await this.api(`issues/${number}`)).pull_request
      this.watched.set(number, isPull)
      if (!isPull) continue
      const pull = Pull.parse(await this.api(`pulls/${number}`))
      const base = {
        threadId: `${this.config.repository}#${number}`,
        scopeId: this.config.repository,
        addressed: false,
        threadKind: "deliverable" as const,
        url: pull.html_url,
      }
      if (pull.state === "closed") {
        await this.receive({
          ...base,
          eventId: `pull-${number}:${pull.updated_at}`,
          senderId: "github",
          human: false,
          text: pull.merged ? "PR merged" : "PR closed",
          closed: pull.merged ? "merged" : "closed",
        })
        continue
      }
      for (const kind of ["reviews", "comments"] as const) {
        const pages = z.array(z.array(Review)).parse(await this.api(`pulls/${number}/${kind}?per_page=100`, true))
        for (const review of pages.flat()) {
          if (review.user.login.toLowerCase() === this.login.toLowerCase() || review.state === "PENDING") continue
          await this.receive({
            ...base,
            eventId: `${kind}-${review.id}:${review.updated_at ?? review.submitted_at}`,
            senderId: review.user.login.toLowerCase(),
            human: review.user.type !== "Bot",
            text: JSON.stringify({ type: kind === "reviews" ? "review" : "inline_review", ...review }),
          })
        }
      }
      const checks = z
        .array(z.object({ check_runs: z.array(Check) }))
        .parse(await this.api(`commits/${pull.head.sha}/check-runs?per_page=100`, true))
        .flatMap((p) => p.check_runs)
      const statuses = z
        .array(z.array(CommitStatus))
        .parse(await this.api(`commits/${pull.head.sha}/statuses?per_page=100`, true))
        .flat()
      // CI is a snapshot, not one model wake for each check in a suite.
      const text = JSON.stringify({ type: "ci", commit: pull.head.sha, checks, statuses })
      if (checks.length || statuses.length)
        await this.receive({
          ...base,
          eventId: `ci-${number}:${createHash("sha256").update(text).digest("hex")}`,
          senderId: "github",
          human: false,
          text,
        })
    }
  }
  async start(ingest: (input: ChannelInput) => Promise<void>) {
    this.receive = ingest
    this.controller = new AbortController()
    const id = `channel:${this.config.id}:${this.config.repository}`
    Database.use((db) =>
      db.insert(StateTable).values({ id, enabled: true, cursor: new Date().toISOString() }).onConflictDoNothing().run(),
    )
    this.timer = setInterval(() => void this.poll(), this.config.pollMs)
    this.timer.unref()
    void this.poll()
  }
  async poll() {
    if (this.busy || this.controller.signal.aborted || !this.receive) return
    this.busy = true
    try {
      if (!this.login)
        this.login = z
          .object({ login: z.string().regex(/^[A-Za-z0-9-]+$/) })
          .parse(JSON.parse(await this.run(this.config.cli, ["api", "user"], undefined, this.controller.signal))).login
      const id = `channel:${this.config.id}:${this.config.repository}`
      const cursor =
        Database.use((db) => db.select().from(StateTable).where(eq(StateTable.id, id)).get())?.cursor ??
        new Date().toISOString()
      const since = new Date(Date.parse(cursor) - 5000).toISOString()
      const items = Listed.parse(
        JSON.parse(
          await this.run(
            this.config.cli,
            [
              "api",
              `repos/${this.config.repository}/issues/comments?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`,
              "--paginate",
              "--slurp",
            ],
            undefined,
            this.controller.signal,
          ),
        ),
      )
      let latest = cursor
      for (const item of items) {
        if (this.controller.signal.aborted) return
        const input = githubInput(item, this.config.repository, this.login)
        if (input?.text.trim()) {
          if (input.addressed && input.human) {
            const number = Number(input.threadId.split("#").at(-1))
            const issue = Issue.parse(await this.api(`issues/${number}`))
            this.watched.set(number, !!issue.pull_request)
            input.threadKind = issue.pull_request ? "deliverable" : "discussion"
            input.url = issue.html_url
          }
          await this.receive(input)
        }
        if (Date.parse(item.updated_at) > Date.parse(latest)) latest = item.updated_at
      }
      await this.pollThreads()
      Database.use((db) => db.update(StateTable).set({ cursor: latest }).where(eq(StateTable.id, id)).run())
      this.status = { connected: true, detail: `Polling ${this.config.repository} as ${this.login}` }
    } catch (error) {
      if (!this.controller.signal.aborted)
        this.status = { connected: false, detail: error instanceof Error ? error.message : "GitHub poll failed" }
    } finally {
      this.busy = false
    }
  }
  async stop() {
    this.controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.status = { connected: false, detail: "Stopped" }
  }
  async send(reply: ChannelReply) {
    if (!this.login)
      this.login = z
        .object({ login: z.string() })
        .parse(JSON.parse(await this.run(this.config.cli, ["api", "user"], undefined, this.controller.signal))).login
    const prefix = `${this.config.repository}#`
    if (!reply.source.threadId.startsWith(prefix)) throw new Error("GitHub reply is outside configured repository")
    const issue = reply.source.threadId.slice(prefix.length)
    if (!/^\d+$/.test(issue)) throw new Error("Invalid GitHub reply target")
    const target = `repos/${this.config.repository}/issues/${issue}/comments`
    const listed = Listed.parse(
      JSON.parse(
        await this.run(
          this.config.cli,
          ["api", `${target}?per_page=100`, "--paginate", "--slurp"],
          undefined,
          this.controller.signal,
        ),
      ),
    )
    const existing = listed.find(
      (c) => c.body?.includes(marker(reply.id)) && c.user.login.toLowerCase() === this.login.toLowerCase(),
    )
    if (existing) return { messageId: String(existing.id) }
    const posted = z
      .object({ id: z.number() })
      .parse(
        JSON.parse(
          await this.run(
            this.config.cli,
            ["api", target, "--method", "POST", "--input", "-"],
            JSON.stringify({ body: `${reply.text}\n\n${marker(reply.id)}` }),
            this.controller.signal,
          ),
        ),
      )
    return { messageId: String(posted.id) }
  }
}
