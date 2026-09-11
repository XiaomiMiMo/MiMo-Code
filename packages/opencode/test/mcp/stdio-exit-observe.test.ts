import { test, expect } from "bun:test"
import { ObservingStdioTransport } from "../../src/mcp/stdio-transport"

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition was not met in time")
}

test("ObservingStdioTransport keeps exit code after close()", async () => {
  const transport = new ObservingStdioTransport({
    command: process.execPath,
    args: ["-e", "console.error('startup dead'); process.exit(23)"],
  })
  await transport.start()
  await waitFor(() => transport.exitSnapshot()?.exitCode === 23)
  const beforeClose = transport.exitSnapshot()
  expect(beforeClose?.exitCode).toBe(23)
  expect(beforeClose?.hostShutdown).toBe(false)
  expect(typeof beforeClose?.pid).toBe("number")

  await transport.close()
  expect(transport.pid).toBeNull()
  // Natural exit is retained; close() does not rewrite it as our SIGTERM.
  expect(transport.exitSnapshot()).toEqual(beforeClose)
  expect(transport.stderrSnapshot()).toContain("startup dead")
})

test("ObservingStdioTransport records external SIGTERM", async () => {
  const transport = new ObservingStdioTransport({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  })
  await transport.start()
  await waitFor(() => typeof transport.exitSnapshot()?.pid === "number")
  const pid = transport.exitSnapshot()!.pid!
  process.kill(pid, "SIGTERM")
  await waitFor(() => transport.exitSnapshot()?.signalCode === "SIGTERM" || transport.exitSnapshot()?.exitCode != null)
  const after = transport.exitSnapshot()
  expect(after?.pid).toBe(pid)
  expect(after?.hostShutdown).toBe(false)
  expect(after?.signalCode === "SIGTERM" || after?.exitCode != null).toBe(true)

  await transport.close().catch(() => undefined)
})

test("close() SIGTERM is flagged as hostShutdown, not the child's failure cause", async () => {
  const transport = new ObservingStdioTransport({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  })
  await transport.start()
  await waitFor(() => typeof transport.exitSnapshot()?.pid === "number")
  const pid = transport.exitSnapshot()!.pid!

  await transport.close()
  const after = transport.exitSnapshot()
  expect(after?.pid).toBe(pid)
  expect(after?.hostShutdown).toBe(true)
})

test("ObservingStdioTransport captures fast native exits", async () => {
  const transport = new ObservingStdioTransport({
    command: "/bin/sh",
    args: ["-c", "echo startup-dead >&2; exit 42"],
  })
  await transport.start()
  await waitFor(() => transport.exitSnapshot()?.exitCode === 42)
  expect(transport.exitSnapshot()?.pid).toEqual(expect.any(Number))
  expect(transport.stderrSnapshot()).toContain("startup-dead")

  await transport.close().catch(() => undefined)
  expect(transport.exitSnapshot()?.exitCode).toBe(42)
  expect(transport.exitSnapshot()?.hostShutdown).toBe(false)
})

test("close() after SIGKILL leaves hostShutdown set, not an empty natural exit", async () => {
  // Ignores SIGTERM so close() must escalate to SIGKILL.
  const transport = new ObservingStdioTransport({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  })
  await transport.start()
  await transport.close()
  const after = transport.exitSnapshot()
  expect(after?.hostShutdown).toBe(true)
  // Never look like a natural exit with no code after host-initiated teardown.
  if (after?.exitCode == null && after?.signalCode == null) {
    expect(after?.hostShutdown).toBe(true)
  } else {
    expect(after?.signalCode === "SIGKILL" || after?.exitCode != null).toBe(true)
  }
})

test("natural exit then close() fires onclose exactly once", async () => {
  const transport = new ObservingStdioTransport({
    command: "/bin/sh",
    args: ["-c", "exit 0"],
  })
  let oncloseCount = 0
  transport.onclose = () => {
    oncloseCount += 1
  }
  await transport.start()
  await waitFor(() => oncloseCount === 1)
  expect(transport.exitSnapshot()?.exitCode).toBe(0)

  // Client may still close() after the transport already reported onclose.
  await transport.close()
  await transport.close()
  expect(oncloseCount).toBe(1)
  expect(transport.exitSnapshot()?.hostShutdown).toBe(false)
})
