import { describe, expect, it } from "bun:test"
/**
 * [C-01] Runner has no pending-attach dual owner.
 * [C-02] Inbox admits wake without a dual loop() path (covered in inbox tests).
 * [C-04] prompt_async returns 202 + receiptId.
 * [C-08] /message busy path is admit+202, not assertNotBusy TOCTOU 409.
 */
describe("turn-queue full migration contracts", () => {
  it("RunHandle has no pending field (C-01 source guard)", async () => {
    const src = await Bun.file(
      new URL("../../src/effect/runner.ts", import.meta.url).pathname,
    ).text()
    expect(src).not.toContain("pending?:")
    expect(src).not.toContain("ShellThenRun")
    expect(src).toContain("NO pending-attach")
  })

  it("inbox wake admits durable Intent and epoch-guards claim-aware dispatch (C-02)", async () => {
    const src = await Bun.file(new URL("../../src/inbox/inbox.ts", import.meta.url).pathname).text()
    expect(src).toMatch(/const admitted = yield\* tq\s*\.admit\(/)
    expect(src).toContain("kind: \"wake\"")
    expect(src).toContain("expectedEpoch: input.wakeEpoch")
    expect(src).toContain("promptRef.loop({")
    expect(src).toContain("wakeEpoch = admitted.epoch")
    expect(src).toContain("{ requireClaim: true, expectedEpoch: wakeEpoch }")
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
    expect(src).toContain("extendClaim")
    expect(src).toContain("C-01: claim eligible receipts")
  })
})
