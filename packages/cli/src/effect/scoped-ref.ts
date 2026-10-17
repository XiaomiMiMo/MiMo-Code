import { Effect } from "effect"

const owners = new WeakMap<object, { value: unknown }[]>()

export function bindScopedRef<T>(ref: { current: T | undefined }, value: T) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const bindings = owners.get(ref) ?? []
      const binding = { value }
      bindings.push(binding)
      owners.set(ref, bindings)
      ref.current = value
      return { bindings, binding }
    }),
    ({ bindings, binding }) => Effect.sync(() => {
      bindings.splice(bindings.indexOf(binding), 1)
      // An external override is not owned by this scope.
      if (ref.current === value) ref.current = bindings.at(-1)?.value as T | undefined
      if (bindings.length === 0) owners.delete(ref)
    }),
  ).pipe(Effect.as(undefined))
}
