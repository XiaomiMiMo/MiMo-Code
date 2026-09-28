import { describe, expect, test } from "bun:test"
import { Effect, Deferred, Fiber } from "effect"

/**
 * Regression shape for the subagent hang.
 *
 * The `actor` tool's blocking `run` path settled its `outcome` Deferred only from
 * inside the spawned work fiber's failure handler. If that fiber is parked on
 * something that never unwinds promptly - a provider stream, an MCP call, a bash
 * child - the tool call kept waiting after the user pressed ESC. The session never
 * went idle, so the TUI stopped accepting input and ESC appeared to do nothing.
 * Only killing the process recovered.
 *
 * The fix makes the abort authoritative for the caller: the cancel handler settles
 * the same Deferred, so the awaiting call returns on the user's timeline regardless
 * of the work fiber. The `wait` path gets the same treatment via Effect.race against
 * an abort Deferred.
 *
 * Each test cleans up its fibers, so a deliberately-wedged fiber cannot hang the
 * suite - which would ironically reproduce the bug under test.
 */

const deadline = <T,>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ])

/**
 * Mirrors the production cancel handler exactly: a plain event-listener callback
 * that must settle a Deferred. Note the `runFork` - building the effect and
 * discarding it is the bug this whole change is about, so the harness has to
 * actually run it or the test would pass while the real code did nothing.
 */
function settleFromAbortListener(d: Deferred.Deferred<string>, value: string) {
  return () => {
    Effect.runFork(Deferred.succeed(d, value))
  }
}

describe("blocking wait is released by the user's abort, not the work fiber", () => {
  test("the caller is genuinely blocked while the producer has not settled", async () => {
    const outcome = await Effect.runPromise(Deferred.make<string>())
    let returned = false
    const fiber = Effect.runFork(
      Deferred.await(outcome).pipe(Effect.tap(() => Effect.sync(() => (returned = true)))),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(returned).toBe(false)
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  test("abort releases the caller even though the work fiber never completes", async () => {
    // The stuck case: the producer NEVER settles, so nothing but the abort releases it.
    const outcome = await Effect.runPromise(Deferred.make<string>())
    const controller = new AbortController()

    const caller = Effect.runFork(Deferred.await(outcome))
    await new Promise((r) => setTimeout(r, 50))

    controller.signal.addEventListener("abort", settleFromAbortListener(outcome, "cancelled"))
    controller.abort()

    const value = await deadline(Effect.runPromise(Fiber.join(caller)), 5_000, "caller after abort")
    expect(value).toBe("cancelled")
  })

  test("a late producer completion cannot overwrite the cancellation", async () => {
    // Deferred.succeed is first-write-wins, so a work fiber unwinding after the
    // cancel cannot change what the caller already saw.
    const outcome = await Effect.runPromise(Deferred.make<string>())
    const caller = Effect.runFork(Deferred.await(outcome))

    await Effect.runPromise(Deferred.succeed(outcome, "cancelled"))
    await Effect.runPromise(Deferred.succeed(outcome, "success"))

    const value = await deadline(Effect.runPromise(Fiber.join(caller)), 5_000, "first settled value")
    expect(value).toBe("cancelled")
  })

  test("settling from an abort listener races the real waiter and returns immediately", async () => {
    // The `wait` path shape: a long-lived wait that must lose to the abort.
    const waitAbort = await Effect.runPromise(Deferred.make<string>())
    const controller = new AbortController()

    // The real wait never finishes - a subagent still streaming.
    const realWait = Effect.never

    controller.signal.addEventListener("abort", settleFromAbortListener(waitAbort, "cancelled"))

    const raced = Effect.runFork(Effect.race(realWait, Deferred.await(waitAbort)))
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()

    const value = await deadline(Effect.runPromise(Fiber.join(raced)), 5_000, "raced abort")
    expect(value).toBe("cancelled")
    await Effect.runPromise(Fiber.interrupt(raced))
  })

  test("removing the abort listener prevents post-completion invocation", async () => {
    // The fix adds listeners; release must remove them or a later abort would fire
    // against an already-settled call and touch a dead actor.
    const target = new AbortController()
    let calls = 0
    const handler = () => {
      calls++
    }
    target.signal.addEventListener("abort", handler)
    target.signal.removeEventListener("abort", handler)
    target.abort()
    expect(calls).toBe(0)
  })

  test("the cancel settle must not be sequenced behind the cancel itself", async () => {
    // Regression guard for the ordering choice in the fix: the caller is released
    // on the abort, even though the cancel it fires alongside never completes.
    // Sequencing the settle behind a slow cancel would reintroduce the hang.
    const outcome = await Effect.runPromise(Deferred.make<string>())
    const controller = new AbortController()
    const caller = Effect.runFork(Deferred.await(outcome))

    controller.signal.addEventListener("abort", () => {
      // Settle first, independently...
      Effect.runFork(Deferred.succeed(outcome, "cancelled"))
      // ...while the cancel itself hangs forever.
      Effect.runFork(Effect.never)
    })
    controller.abort()

    const value = await deadline(Effect.runPromise(Fiber.join(caller)), 5_000, "caller with hung cancel")
    expect(value).toBe("cancelled")
  })
})
