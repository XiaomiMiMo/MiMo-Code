import { expect, test } from "bun:test"
import path from "node:path"
import z from "zod"
import { tmpdir } from "../fixture/fixture"

const reportSchema = z.object({
  kind: z.enum(["ready", "result", "finished", "error"]),
  sessionID: z.string().optional(),
  message: z.string().optional(),
  actor: z.object({ status: z.string(), lastOutcome: z.string().optional(), lastError: z.string().optional(), resultMessageID: z.string().optional() }).optional(),
  waited: z.object({ status: z.string(), lastOutcome: z.string().optional(), result: z.string().optional(), error: z.string().optional() }).optional(),
})

function launch(mode: string, directory: string, sessionID?: string) {
  const first = Promise.withResolvers<z.infer<typeof reportSchema>>()
  let received = false
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../fixture/actor-process.ts"), mode, directory, ...(sessionID ? [sessionID] : [])], {
    env: { ...process.env, MIMOCODE_DB: path.join(directory, "shared.db") },
    stdout: "ignore",
    stderr: "pipe",
    ipc(message) {
      const parsed = reportSchema.safeParse(message)
      if (!parsed.success) { first.reject(parsed.error); return }
      received = true
      if (parsed.data.kind === "error") first.reject(new Error(parsed.data.message))
      else first.resolve(parsed.data)
    },
  })
  const errors = new Response(child.stderr).text()
  void child.exited.then(async code => {
    if (!received) first.reject(new Error(`actor process exited ${code}: ${await errors}`))
  })
  return { child, first: first.promise }
}

async function stop(child: ReturnType<typeof launch>["child"]) {
  if (child.exitCode === null) child.kill("SIGKILL")
  await child.exited
}

// Desktop tool-step-schema [TP-R14-10].
test("a second real process sharing the database does not terminate a live actor", async () => {
  await using dir = await tmpdir({ git: true })
  const owner = launch("hold", dir.path)
  let observer: ReturnType<typeof launch> | undefined
  try {
    const ready = await owner.first
    expect(ready.kind).toBe("ready")
    observer = launch("inspect", dir.path, ready.sessionID)
    const result = await observer.first
    expect(result.actor?.status).toBe("running")
    expect(result.actor?.lastOutcome).toBeUndefined()
    expect(result.actor?.lastError).toBeUndefined()
    expect(result.waited?.status).toBe("timeout")
    expect(owner.child.exitCode).toBeNull()
    expect(await observer.child.exited).toBe(0)
    owner.child.send("finish")
    expect(await owner.child.exited).toBe(0)
  } finally { if (observer) await stop(observer.child); await stop(owner.child) }
}, 30000)

// Desktop tool-step-schema [TP-R14-10]: current crash boundary, not automatic recovery.
test("a killed executor remains unconfirmed after restart rather than being guessed failed", async () => {
  await using dir = await tmpdir({ git: true })
  const owner = launch("hold", dir.path)
  let restarted: ReturnType<typeof launch> | undefined
  try {
    const ready = await owner.first
    owner.child.kill("SIGKILL")
    expect(await owner.child.exited).not.toBe(0)
    restarted = launch("inspect", dir.path, ready.sessionID)
    const result = await restarted.first
    expect(result.actor?.status).toBe("running")
    expect(result.actor?.lastOutcome).toBeUndefined()
    expect(result.actor?.resultMessageID).toBeUndefined()
    expect(result.waited?.status).toBe("timeout")
    expect(await restarted.child.exited).toBe(0)
  } finally { if (restarted) await stop(restarted.child); await stop(owner.child) }
}, 30000)

// Desktop tool-step-schema [TP-R14-11].
test("a persisted failure delivery is read by a fresh operating-system process", async () => {
  await using dir = await tmpdir({ git: true })
  const writer = launch("settle", dir.path)
  let reader: ReturnType<typeof launch> | undefined
  try {
    const saved = await writer.first
    expect(await writer.child.exited).toBe(0)
    reader = launch("inspect", dir.path, saved.sessionID)
    const result = await reader.first
    expect(result.actor?.status).toBe("idle")
    expect(result.actor?.lastOutcome).toBe("failure")
    expect(result.actor?.resultMessageID).toBeDefined()
    expect(result.waited?.lastOutcome).toBe("failure")
    expect(result.waited?.result).toBe("PERSISTED-PARTIAL")
    expect(result.waited?.error).toContain("controlled failure")
    expect(await reader.child.exited).toBe(0)
  } finally { if (reader) await stop(reader.child); await stop(writer.child) }
}, 30000)
