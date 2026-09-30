import { expect, test } from "bun:test"

// Other MCP suites mock the SDK process-wide. Keep this real protocol/stdio
// regression in a fresh process so it cannot silently exercise their fake client.
if (process.env.MIMO_ELICITATION_PROTOCOL_TEST === "1") {
  await import("./fixtures/elicitation-suite")
} else {
  test("real MCP confirmation protocol and cancellation", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, MIMO_ELICITATION_PROTOCOL_TEST: "1" },
      timeout: 45_000,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
  }, 60_000)
}
