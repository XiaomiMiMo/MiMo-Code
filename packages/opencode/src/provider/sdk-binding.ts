import { createHash } from "node:crypto"
import { isProxy } from "node:util/types"
import type { LanguageModelV3 } from "@ai-sdk/provider"

export type SDKBinding = { languageModel(modelID: string): LanguageModelV3 }

// Only this audited adapter can share pure constructor input without capturing a project.
const compatibleOptions = new Set([
  "name",
  "baseURL",
  "apiKey",
  "headers",
  "queryParams",
  "includeUsage",
  "supportsStructuredOutputs",
  "timeout",
  "headerTimeout",
  "chunkTimeout",
])

function isData(value: unknown, parents = new Set<object>()): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return typeof value === "string" || typeof value === "boolean"
  if (parents.has(value) || isProxy(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  parents.add(value)
  const result = Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    return "value" in descriptor && descriptor.enumerable === true && isData(descriptor.value, parents)
  })
  parents.delete(value)
  return result
}

export function canShareSDK(npm: string, options: Record<string, unknown>) {
  return (
    npm === "@ai-sdk/openai-compatible" &&
    typeof options.baseURL === "string" &&
    (options.apiKey === undefined || typeof options.apiKey === "string") &&
    Object.keys(options).every((key) => compatibleOptions.has(key)) &&
    isData(options)
  )
}

/** Owned by Provider.layer (or an Instance for unreviewed bindings), never a module singleton. */
export class SDKBindingCache {
  private readonly identities = new WeakMap<object | symbol, number>()
  private nextIdentity = 0
  private readonly entries = new Map<string, { promise: Promise<SDKBinding>; pending: boolean }>()

  private identity(value: object | symbol) {
    const existing = this.identities.get(value)
    if (existing != null) return existing
    const id = ++this.nextIdentity
    this.identities.set(value, id)
    return id
  }

  // SDK objects may hide configuration in WeakMaps while sharing all public methods.
  reference(value: object) {
    return this.identity(value)
  }

  // Preserve opaque identities without invoking getters or toJSON during key construction.
  key(value: unknown): string {
    const parents = new Set<object>()
    const encode = (value: unknown): unknown => {
      if (value === null) return ["null"]
      switch (typeof value) {
        case "symbol": {
          const registered = Symbol.keyFor(value)
          // Registered symbols cannot be weak keys; their registry names are unique.
          return registered === undefined ? ["symbol", this.identity(value)] : ["registered-symbol", registered]
        }
        case "function":
          return ["identity", this.identity(value)]
        case "undefined":
          return ["undefined"]
        case "string":
          return ["string", value]
        case "boolean":
          return ["boolean", value]
        case "number":
          return ["number", Object.is(value, -0) ? "-0" : String(value)]
        case "bigint":
          return ["bigint", String(value)]
      }
      const object = value
      if (isProxy(object)) return ["identity", this.identity(object)]
      const proto = Object.getPrototypeOf(object)
      const keys = Reflect.ownKeys(object)
      if (
        (proto !== Object.prototype && proto !== null && proto !== Array.prototype) ||
        parents.has(object) ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            !("value" in Object.getOwnPropertyDescriptor(object, key)!) ||
            (!Object.getOwnPropertyDescriptor(object, key)!.enumerable && !(Array.isArray(object) && key === "length")),
        )
      ) {
        return ["identity", this.identity(object)]
      }
      parents.add(object)
      // Enumeration order is observable (e.g. headers differing only in case).
      const result = [
        Array.isArray(object) ? "array" : proto === null ? "null-object" : "object",
        keys
          .filter((key): key is string => typeof key === "string")
          .map((key) => [key, encode(Object.getOwnPropertyDescriptor(object, key)!.value)]),
      ]
      parents.delete(object)
      return result
    }
    // Keys contain credential material: retain only the digest and never log it.
    return createHash("sha256")
      .update(JSON.stringify(encode(value)))
      .digest("hex")
  }

  async get(key: string, create: () => SDKBinding | Promise<SDKBinding>): Promise<SDKBinding> {
    for (;;) {
      const existing = this.entries.get(key)
      if (existing) {
        this.entries.delete(key)
        this.entries.set(key, existing)
        return existing.promise
      }
      if (this.entries.size < 128) break
      const idle = [...this.entries].find(([, entry]) => !entry.pending)
      if (idle) {
        // Models may still hold the binding, so eviction must not close it.
        this.entries.delete(idle[0])
        break
      }
      // Keep in-flight entries pinned; wait for a completed entry before eviction.
      await Promise.race([...this.entries.values()].map((entry) => entry.promise)).catch(() => undefined)
    }
    const entry = {
      pending: true,
      promise: Promise.resolve()
        .then(create)
        .then(
          (sdk) => {
            entry.pending = false
            return sdk
          },
          (error) => {
            if (this.entries.get(key) === entry) this.entries.delete(key)
            throw error
          },
        ),
    }
    this.entries.set(key, entry)
    return entry.promise
  }
}
