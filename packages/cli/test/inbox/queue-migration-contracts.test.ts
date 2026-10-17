import { describe, expect, it } from "bun:test"
describe("turn-queue full migration contracts", () => {
  it("RunHandle has no pending field (C-01 source guard)", async () => {
    const src = await Bun.file(
      new URL("../../src/effect/runner.ts", import.meta.url).pathname,
    ).text()
    expect(src).not.toContain("pending?:")
    expect(src).not.toContain("ShellThenRun")
    expect(src).toContain("NO pending-attach")
  })

  it("agent inputs use unified controller admission (C-02)", async () => {
    const src = await Bun.file(new URL("../../src/inbox/inbox.ts", import.meta.url).pathname).text()
    expect(src).toContain("controller.accept({")
    expect(src).not.toContain("promptRef.loop")
    expect(src).not.toContain("inboxWake")
  })

  it("prompt_async documents 202 + receiptId (C-04 source guard)", async () => {
    const src = await Bun.file(
      new URL("../../src/server/routes/instance/session.ts", import.meta.url).pathname,
    ).text()
    expect(src).toContain('operationId: "session.prompt_async"')
    expect(src).toContain("202")
    expect(src).toContain("receiptId")
  })

  it("/message busy path admits instead of 409 TOCTOU (C-08 source guard)", async () => {
    const src = await Bun.file(
      new URL("../../src/server/routes/instance/session.ts", import.meta.url).pathname,
    ).text()
    expect(src).toContain("C-08: no assertNotBusy TOCTOU")
    // resume routes no longer preflight assertNotBusy
    expect(src).not.toContain("SessionRoutes.resume.assertNotBusy")
    expect(src).not.toContain("SessionRoutes.resumeUser.assertNotBusy")
  })

  it("loop claims and acks via Controller (C-01)", async () => {
    const src = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url).pathname).text()
    expect(src).toContain("claimNext")
    expect(src).toContain("controller.extendClaim(")
    expect(src).toContain("controller.ack(")
    expect(src).toContain("settleClaims(")
  })
})
