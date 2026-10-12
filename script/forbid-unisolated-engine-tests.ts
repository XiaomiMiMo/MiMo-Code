/**
 * Root `bun test` guard: refuse `packages/**` tests without
 * packages/cli/test/preload.ts isolation (MIMOCODE_DB=:memory: + XDG_*).
 *
 * bun test runs this preload with argv = [bun, <testfile>, ...], so inspect
 * every argv entry. Discovery is limited by bunfig [test] root = ./script;
 * this also blocks explicit `bun test ./packages/...` paths.
 *
 * Legitimate entrypoints:
 *   - `bun run test` / `bun run --cwd packages/cli test` (loads packages/cli/test/preload.ts)
 *   - `bun test script/release.test.ts` (root release scripts; no engine DB)
 */
const engineTest = process.argv.some((a) => {
  const s = a.replace(/\\/g, "/")
  return /\/packages\/[^/]+\/(test\/.*\.(test|spec)\.|.*\.(test|spec)\.)/.test(s)
})
const isolated = Boolean(process.env.MIMOCODE_DB)

if (engineTest && !isolated) {
  console.error(
    [
      "Refusing to run packages/** tests from the repo root without isolation.",
      "  reason: packages/cli/test/preload.ts would not load (MIMOCODE_DB / XDG_* stay on your real home).",
      "  use:   bun run test",
      "      or bun run --cwd packages/cli test",
      "      or cd packages/cli && bun test <file>",
    ].join("\n"),
  )
  process.exit(1)
}
