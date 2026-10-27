import { expect, test } from "bun:test"

// Real HTTP/SSE and native TUI resources need a fresh process, as with the
// real MCP protocol suite, so other tests cannot leave native state behind.
if (process.env.MIMOCODE_QUESTION_RECONNECT_TEST === "1") {
  await import("./question-reconnect.fixture")
} else {
  test("question prompts recover across real HTTP/SSE reconnects", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, MIMOCODE_QUESTION_RECONNECT_TEST: "1" },
      timeout: 100_000,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
  }, 120_000)
}
