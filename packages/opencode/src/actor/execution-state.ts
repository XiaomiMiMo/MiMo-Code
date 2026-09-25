import { Instance, type InstanceContext } from "@/project/instance"
import * as InstanceState from "@/effect/instance-state"
import type { Execution } from "./execution"

const instances = new WeakMap<InstanceContext, Map<string, Execution>>()

export function current() {
  return InstanceState.bind(() => {
    const context = Instance.current
    const existing = instances.get(context)
    if (existing) return existing
    const active = new Map<string, Execution>()
    instances.set(context, active)
    return active
  })()
}
