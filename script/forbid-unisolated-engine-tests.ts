/**
 * Root `bun test` policy: do not run `packages/**` tests from the repo root.
 *
 * Those suites must run from packages/cli so packages/cli/test/preload.ts
 * loads (fixtures, Log, projectors). Even with test-isolation-env.ts setting
 * MIMOCODE_DB=:memory:, a root run still skips that fixture preload and can
 * produce misleading results.
 *
 * bun test invokes preloads with argv = [bun, <testfile>, ...].
 *
 * Legitimate entrypoints:
 *   - `bun run test` / `bun run --cwd packages/cli test`
 *   - `cd packages/cli && bun test <file>`
 *   - `bun test script/release.test.ts` (root release scripts only)
 */
const packagesTest = process.argv.some((a) => {
  const s = a.replace(/\\/g, "/")
  return /\/packages\/[^/]+\/.*\.(test|spec)\./.test(s) || /\/packages\/[^/]+\/test\//.test(s)
})

if (packagesTest) {
  console.error(
    [
      "Refusing to run packages/** tests from the repo root.",
      "  use:   bun run test",
      "      or bun run --cwd packages/cli test",
      "      or cd packages/cli && bun test <file>",
    ].join("\n"),
  )
  process.exit(1)
}
