import { expect, test } from "bun:test"
import path from "path"
import ts from "typescript"
import { makeChildProcessEnv } from "../../src/util/child-process-env"

test("configured baseline is copied and explicit env wins", () => {
  const inherited = { PATH: "/terminal/bin", NODE_ENV: "user-value", KEEP: "base" }
  const env = makeChildProcessEnv(() => ({ FALLBACK: "unused" }))

  env.set(inherited)
  inherited.PATH = "/mutated"

  expect(env.resolve({ KEEP: "explicit", EXTRA: "yes" })).toEqual({
    PATH: "/terminal/bin",
    NODE_ENV: "user-value",
    KEEP: "explicit",
    EXTRA: "yes",
  })
})

test("setting a new baseline replaces the environment for future spawns", () => {
  const env = makeChildProcessEnv(() => ({}))
  env.set({ VALUE: "first" })
  expect(env.resolve()).toEqual({ VALUE: "first" })

  env.set({ VALUE: "second" })
  expect(env.resolve()).toEqual({ VALUE: "second" })
})

test("no-set callers keep reading the current process environment", () => {
  let inherited = { VALUE: "first" }
  const env = makeChildProcessEnv(() => inherited)

  expect(env.resolve()).toEqual({ VALUE: "first" })
  inherited = { VALUE: "second" }
  expect(env.resolve()).toEqual({ VALUE: "second" })
})

test("credential scrub applies only to inherited baseline", () => {
  const env = makeChildProcessEnv(() => ({
    MIMOCODE_AUTH_CONTENT: "inherited-secret",
    MIMOCODE_CONFIG_CONTENT: "inherited-config",
    USER_VAR: "kept",
  }))

  expect(env.resolve({ MIMOCODE_AUTH_CONTENT: "explicit-secret" })).toEqual({
    USER_VAR: "kept",
    MIMOCODE_AUTH_CONTENT: "explicit-secret",
  })
})

test("Server.listen sets childEnv before creating the runtime", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "server", "server.ts")).text()
  const install = source.indexOf("setChildProcessEnv(opts.childEnv)")
  const create = source.indexOf("const built = create(opts)")

  expect(install).toBeGreaterThan(-1)
  expect(create).toBeGreaterThan(install)
})

test("node embedding entry exports the runtime child env setter", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "node.ts")).text()
  expect(source).toContain('export { ChildProcessEnv } from "./util/child-process-env"')
})

test("all inherited external process paths use childProcessEnv", async () => {
  const root = path.join(import.meta.dir, "..", "..", "src")
  const funnels = [
    "util/process.ts",
    "effect/cross-spawn-spawner.ts",
    "tool/bash.ts",
    "pty/index.ts",
    "mcp/index.ts",
    "file/ripgrep.ts",
  ]

  for (const file of funnels) {
    const source = await Bun.file(path.join(root, file)).text()
    expect(source, file).toContain("childProcessEnv")
    expect(source, file).not.toContain("withoutCredentials(process.env)")
    expect(source, file).not.toContain("withoutCredentials(globalThis.process.env)")
  }

  const effectSpawner = await Bun.file(path.join(root, "effect", "cross-spawn-spawner.ts")).text()
  expect(effectSpawner).toContain("opts.extendEnv || Predicate.isUndefined(opts.env) ? childProcessEnv(opts.env) : opts.env")

  const bash = await Bun.file(path.join(root, "tool", "bash.ts")).text()
  expect(bash).toContain("const inherited = childProcessEnv()")
  expect(bash).not.toMatch(/!process\.env\["GIT_(?:AUTHOR|COMMITTER)_/)

  const lsp = await Bun.file(path.join(root, "lsp", "server.ts")).text()
  expect(lsp).not.toContain("childProcessEnv")
  expect(lsp).not.toContain('const env = childProcessEnv({ MIX_ENV: "prod" })')
  expect(lsp).toContain("env: { GOBIN: Global.Path.bin }")

  const lspConfig = await Bun.file(path.join(root, "lsp", "lsp.ts")).text()
  expect(lspConfig).not.toContain("childProcessEnv")
  expect(lspConfig).toContain("env: item.env")

  const lspLaunch = await Bun.file(path.join(root, "lsp", "launch.ts")).text()
  expect(lspLaunch).toContain("Process.spawn")
  expect(lspLaunch).toContain("...cfg")

  const uninstall = await Bun.file(path.join(root, "cli", "cmd", "uninstall.ts")).text()
  expect(uninstall).not.toContain("childProcessEnv")
  expect(uninstall).toContain("env: { MIMOCODE_UNINSTALL_DIR: installDir }")

  const ripgrep = await Bun.file(path.join(root, "file", "ripgrep.ts")).text()
  expect(ripgrep).not.toMatch(/env: env\(\),\s*extendEnv: true/)
})

test("native child_process calls explicitly use childProcessEnv", async () => {
  const root = path.join(import.meta.dir, "..", "..", "src")
  const files = [...new Bun.Glob("**/*.ts").scanSync(root)]
  const unchecked: string[] = []
  const apis = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])

  for (const file of files) {
    const source = await Bun.file(path.join(root, file)).text()
    const node = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const named = new Set<string>()
    const namespaces = new Set<string>()

    for (const statement of node.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
      if (!/^(?:node:)?child_process$/.test(statement.moduleSpecifier.text)) continue
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly || !clause.namedBindings) continue
      if (ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text)
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue
          if (apis.has((element.propertyName ?? element.name).text)) named.add(element.name.text)
        }
      }
    }

    const visit = (item: ts.Node) => {
      if (ts.isCallExpression(item)) {
        const required = (ts.isIdentifier(item.expression) && item.expression.text === "require") ||
          (ts.isPropertyAccessExpression(item.expression) && item.expression.name.text === "require")
        const module = item.arguments[0]
        if (required && module && ts.isStringLiteral(module) && /^(?:node:)?child_process$/.test(module.text)) {
          const pos = node.getLineAndCharacterOfPosition(item.getStart(node))
          unchecked.push(`${file}:${pos.line + 1}`)
        }
        const direct = ts.isIdentifier(item.expression) && named.has(item.expression.text)
        const namespaced = ts.isPropertyAccessExpression(item.expression) &&
          ts.isIdentifier(item.expression.expression) && namespaces.has(item.expression.expression.text) &&
          apis.has(item.expression.name.text)
        if (direct || namespaced) {
          const safe = item.arguments.some((arg) =>
            ts.isObjectLiteralExpression(arg) && arg.properties.some((prop) =>
              ts.isPropertyAssignment(prop) && prop.name.getText(node) === "env" &&
              prop.initializer.getText(node).includes("childProcessEnv("),
            ),
          )
          if (!safe) {
            const pos = node.getLineAndCharacterOfPosition(item.getStart(node))
            unchecked.push(`${file}:${pos.line + 1}`)
          }
        }
      }
      ts.forEachChild(item, visit)
    }
    visit(node)
  }

  expect(unchecked).toEqual([])
})
