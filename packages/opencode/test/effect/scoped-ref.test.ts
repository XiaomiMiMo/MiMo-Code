import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { bindScopedRef } from "../../src/effect/scoped-ref"
import { it } from "../lib/effect"

// turn-queue: late-bound service lifetime; local refs isolate all-owner teardown.
describe("scoped ref owners", () => {
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    it.live(`restores only live owners when scopes close in order ${order.join(",")}`, Effect.gen(function* () {
      const ref: { current: object | undefined } = { current: undefined }
      const values = [{}, {}, {}]
      const scopes = yield* Effect.forEach(values, (value) => Effect.gen(function* () {
        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        yield* bindScopedRef(ref, value).pipe(Effect.provideService(Scope.Scope, scope))
        expect(ref.current).toBe(value)
        return scope
      }))
      const live = new Set([0, 1, 2])
      for (const index of order) {
        yield* Scope.close(scopes[index], Exit.void)
        live.delete(index)
        expect(ref.current).toBe(values[[...live].at(-1)!])
      }
      expect(ref.current).toBeUndefined()
      const next = {}
      yield* bindScopedRef(ref, next).pipe(Effect.scoped)
      expect(ref.current).toBeUndefined()
    }))
  }

  it.live("external overrides survive old finalizers and are not registered as owners", Effect.gen(function* () {
    const first = {}
    const second = {}
    const override = {}
    const ref: { current: object | undefined } = { current: undefined }
    const older = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
    const newer = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
    yield* bindScopedRef(ref, first).pipe(Effect.provideService(Scope.Scope, older))
    yield* bindScopedRef(ref, second).pipe(Effect.provideService(Scope.Scope, newer))
    ref.current = override
    yield* Scope.close(older, Exit.void)
    expect(ref.current).toBe(override)
    ref.current = second
    yield* Scope.close(newer, Exit.void)
    expect(ref.current).toBeUndefined()
  }))

  it.live("external override survives the last owner's release", Effect.gen(function* () {
    const override = {}
    const ref: { current: object | undefined } = { current: undefined }
    yield* Effect.gen(function* () {
      yield* bindScopedRef(ref, {})
      ref.current = override
    }).pipe(Effect.scoped)
    expect(ref.current).toBe(override)
  }))

  it.live("separate bindings of the same value remain live until both scopes close", Effect.gen(function* () {
    const value = {}
    const ref: { current: object | undefined } = { current: undefined }
    const older = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
    const newer = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
    yield* bindScopedRef(ref, value).pipe(Effect.provideService(Scope.Scope, older))
    yield* bindScopedRef(ref, value).pipe(Effect.provideService(Scope.Scope, newer))
    yield* Scope.close(older, Exit.void)
    expect(ref.current).toBe(value)
    yield* Scope.close(newer, Exit.void)
    expect(ref.current).toBeUndefined()
  }))
})
