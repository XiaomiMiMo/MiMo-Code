import { afterAll, beforeAll } from "bun:test"

// Bun runs every file of a test invocation in one process, so a module-level
// `process.env` write leaks into all files scheduled after it. Flag getters read
// env lazily, so tests must set their flags in beforeAll and restore in afterAll.
export function withEnv(values: Record<string, string | undefined>) {
  const saved = Object.keys(values).map((key) => [key, process.env[key]] as const)

  const apply = (entries: readonly (readonly [string, string | undefined])[]) => {
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  beforeAll(() => apply(Object.entries(values)))
  afterAll(() => apply(saved))
}
