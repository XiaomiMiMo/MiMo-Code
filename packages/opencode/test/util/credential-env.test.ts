import { test, expect } from "bun:test"
import path from "path"
import { credentialEnvKeys, withoutCredentials } from "../../src/util/credential-env"

const SRC = path.join(import.meta.dir, "..", "..", "src")

// Bun.Glob yields posix-separated relative paths on every platform, so exemptions are spelled that way.
const lines = async (file: string) => (await Bun.file(path.join(SRC, file)).text()).split("\n")
const files = () => [...new Bun.Glob("**/*.ts").scanSync(SRC)]

async function scan(pattern: RegExp, skip: Set<string>) {
  const hits = await Promise.all(
    files()
      .filter((file) => !skip.has(file))
      .map(async (file) =>
        (await lines(file)).flatMap((line, index) =>
          pattern.test(line) && !line.includes("withoutCredentials") ? [`${file}:${index + 1}`] : [],
        ),
      ),
  )
  return hits.flat()
}

test("withoutCredentials drops every credential var and keeps the rest", () => {
  const secrets = Object.fromEntries(credentialEnvKeys().map((key) => [key, "sk-secret"]))
  const env = withoutCredentials({ PATH: "/usr/bin", HOME: "/home/user", ...secrets })

  expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"])
  expect(JSON.stringify(env)).not.toContain("sk-secret")
})

test("withoutCredentials leaves non-credential keys alone", () => {
  const env = withoutCredentials({ PATH: "/usr/bin", EMPTY: undefined })
  expect(env.PATH).toBe("/usr/bin")
  expect("EMPTY" in env).toBe(true)
})

// Every child process must get a scrubbed copy of the inherited environment. Asserting at the call
// sites (not just on the helper) is the point: the regression this catches is a *new* spawn site
// handing the environment over untouched, which no behavioral test of the helper would notice.
//
// The pattern covers `globalThis.process.env` and `env: process.env`, not just `...process.env` — the
// spawner funnel every `extendEnv: true` caller goes through is written the first way, and a narrower
// pattern reports a clean tree while the widest leak path stays open.
//
// Known limit: a call that omits `env` entirely inherits by default and matches nothing here. Those
// spawn either fixed tooling with no attacker-controlled command (taskkill, gh, sqlite3) or go through
// the wrappers below; a structural rule ("only wrappers may import child_process") would close it and
// is the natural next step if the list grows.
test("no spawn site hands the inherited environment over without scrubbing credentials", async () => {
  // In-process snapshot for the Env service, not an environment handed to a child.
  const offenders = await scan(
    /\.\.\.\s*(?:globalThis\.)?process\.env|env:\s*(?:globalThis\.)?process\.env\b/,
    new Set(["env/index.ts"]),
  )
  expect(offenders).toEqual([])
})

// `sanitizedProcessEnv` only filters undefined values (it exists to satisfy `Record<string, string>`),
// so it is a full copy of the environment. That is legitimate for the TUI worker — itself an engine
// process that needs the credentials — so the function stays; this pins down who else may use it.
test("sanitizedProcessEnv is only used where the child is an engine process, or scrubbed at the call site", async () => {
  const unscrubbed = await scan(/sanitizedProcessEnv\(/, new Set(["util/mimo-process.ts", "cli/cmd/tui/thread.ts"]))
  expect(unscrubbed).toEqual([])
})
