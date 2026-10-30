import { expect, test } from "bun:test"
import { $ } from "bun"
import { Effect, Exit, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import fs from "node:fs/promises"
import { applyPatch } from "diff"
import { Snapshot } from "../../src/snapshot"
import { PreviewBuilder, PreviewLimits, boundPreview, type PreviewSummary } from "../../src/snapshot/preview"
import { ByteLimitError, readLimited } from "../../src/util/bounded-stream"
import { Instance } from "../../src/project/instance"
import { provideInstance, tmpdir } from "../fixture/fixture"

test("preview counts 100000 files without retaining more than 500 rows", () => {
  const preview = new PreviewBuilder()
  for (let i = 0; i < 100_000; i++) preview.add({ file: `file-${i}.ts`, patch: "", additions: 2, deletions: 1 })
  expect(preview.value.diffs).toHaveLength(500)
  expect(preview.value.summary).toEqual({
    files: 100_000,
    additions: 200_000,
    deletions: 100_000,
    omittedFiles: 99_500,
    omittedPatches: 0,
  })
  expect(Buffer.byteLength(JSON.stringify(preview.value))).toBeLessThanOrEqual(PreviewLimits.payload)
})

test("small patches are valid with three lines of context", () => {
  const before = Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join("")
  const after = before.replace("line 500\n", "changed\n")
  const preview = new PreviewBuilder()
  const item = preview.add({ file: "example.txt", patch: "", additions: 1, deletions: 1 })!
  preview.patch(item, before, after)
  expect(applyPatch(before, item.patch)).toBe(after)
  expect(item.patch).not.toContain("line 100\n")
  expect(item.patchOmitted).toBeUndefined()
})

test("patch limits omit complete patches instead of returning invalid fragments", () => {
  const preview = new PreviewBuilder()
  for (let i = 0; i < 100; i++) {
    const item = preview.add({ file: `file-${i}`, patch: "", additions: 1, deletions: 0 })!
    preview.patch(item, "", "a".repeat(32 * 1024) + "\n")
  }
  const value = boundPreview(preview.value.diffs, preview.value.summary)
  expect(value.summary.omittedPatches).toBeGreaterThan(0)
  expect(value.diffs.reduce((sum, item) => sum + Buffer.byteLength(item.patch), 0)).toBeLessThanOrEqual(
    PreviewLimits.patches,
  )
  for (const item of value.diffs) {
    if (item.patchOmitted) expect(item.patch).toBe("")
    else expect(applyPatch("", item.patch)).toBe("a".repeat(32 * 1024) + "\n")
  }
})

test("legacy previews respect encoded payload and per-patch limits", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    file: `file-${i}`,
    additions: 1,
    deletions: 0,
    patch: '"'.repeat(60 * 1024),
  }))
  const value = boundPreview(rows)
  expect(value.summary.files).toBe(1000)
  expect(value.diffs.length).toBeLessThanOrEqual(500)
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(PreviewLimits.payload)
  expect(value.summary.omittedFiles).toBeGreaterThanOrEqual(500)
})

test("expensive edits and oversized individual patches retain metadata with an omission marker", () => {
  const preview = new PreviewBuilder()
  const complex = preview.add({ file: "complex.txt", patch: "", additions: 6000, deletions: 6000 })!
  preview.patch(complex, "before\n".repeat(6000), "after\n".repeat(6000))
  const large = preview.add({ file: "long-line.txt", patch: "", additions: 1, deletions: 0 })!
  preview.patch(large, "", "x".repeat(100 * 1024))
  expect(complex).toMatchObject({ patch: "", patchOmitted: true, additions: 6000, deletions: 6000 })
  expect(large).toMatchObject({ patch: "", patchOmitted: true, additions: 1 })
  expect(preview.value.summary.omittedPatches).toBe(2)
})

test("byte limits stop a stream before its remaining chunks are consumed", async () => {
  let consumed = 0
  const source = Stream.fromIterable([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)]).pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        consumed++
      }),
    ),
  )
  const exit = await Effect.runPromise(Effect.exit(readLimited(source, 10)))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(consumed).toBe(2)
  const single = await Effect.runPromise(readLimited(Stream.make(Buffer.from("valid")), 5))
  expect(single.toString()).toBe("valid")
  expect(new ByteLimitError()._tag).toBe("ByteLimitError")
})

function run<A>(
  directory: string,
  fn: (snapshot: Snapshot.Interface) => Effect.Effect<A>,
  layer = Snapshot.defaultLayer,
) {
  return Effect.runPromise(Snapshot.Service.use(fn).pipe(provideInstance(directory), Effect.provide(layer)))
}

test("snapshot previews omit large tracked blobs and preserve Unicode, binary and change metadata", async () => {
  await using tmp = await tmpdir({ git: true })
  try {
    await fs.writeFile(`${tmp.path}/large.txt`, "a".repeat(512 * 1024))
    await fs.writeFile(`${tmp.path}/delete.txt`, "delete\n")
    await fs.writeFile(`${tmp.path}/normal.txt`, "before\n")
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git commit -m "tracked files"`.cwd(tmp.path).quiet()
    const before = await run(tmp.path, (snapshot) => snapshot.track())
    await fs.writeFile(`${tmp.path}/large.txt`, "b".repeat(512 * 1024))
    await fs.writeFile(`${tmp.path}/normal.txt`, "after\n")
    await fs.writeFile(`${tmp.path}/日本語.txt`, "unicode\n")
    await fs.writeFile(`${tmp.path}/binary.dat`, Buffer.from([0, 1, 2, 3]))
    await fs.rm(`${tmp.path}/delete.txt`)
    const after = await run(tmp.path, (snapshot) => snapshot.track())
    let summary: PreviewSummary | undefined
    const diffs = await run(tmp.path, (snapshot) =>
      snapshot.diffFull(before!, after!, {
        onSummary: (value) => {
          summary = value
        },
      }),
    )
    expect(diffs).toHaveLength(5)
    expect(diffs.find((item) => item.file === "large.txt")).toMatchObject({
      patch: "",
      patchOmitted: true,
      status: "modified",
    })
    expect(summary?.files).toBe(5)
    expect(diffs.find((item) => item.file === "日本語.txt")?.status).toBe("added")
    expect(diffs.find((item) => item.file === "binary.dat")?.patch).toBe("")
    expect(diffs.find((item) => item.file === "delete.txt")?.status).toBe("deleted")
    expect(applyPatch("before\n", diffs.find((item) => item.file === "normal.txt")!.patch)).toBe("after\n")
    let truncated = false
    const revertPreview = await run(tmp.path, (snapshot) =>
      snapshot.diff(before!, {
        onTruncated: () => {
          truncated = true
        },
      }),
    )
    expect(truncated).toBe(true)
    expect(revertPreview).not.toContain("large.txt")
    expect(Buffer.byteLength(revertPreview)).toBeLessThanOrEqual(PreviewLimits.patches)
    await run(tmp.path, (snapshot) => snapshot.restore(before!))
    expect((await fs.readFile(`${tmp.path}/large.txt`, "utf8"))[0]).toBe("a")
  } finally {
    await Instance.disposeAll()
  }
}, 30_000)

test("snapshot row cap preserves exact totals and revert data beyond the preview", async () => {
  await using tmp = await tmpdir({ git: true })
  try {
    const before = await run(tmp.path, (snapshot) => snapshot.track())
    for (let i = 0; i < 510; i++) await fs.writeFile(`${tmp.path}/file-${String(i).padStart(4, "0")}.txt`, "added\n")
    const after = await run(tmp.path, (snapshot) => snapshot.track())
    let summary: PreviewSummary | undefined
    const diffs = await run(tmp.path, (snapshot) =>
      snapshot.diffFull(before!, after!, {
        onSummary: (value) => {
          summary = value
        },
      }),
    )
    expect(diffs).toHaveLength(500)
    expect(summary).toMatchObject({ files: 510, additions: 510, deletions: 0, omittedFiles: 10 })
    const recovery = await run(tmp.path, (snapshot) => snapshot.patch(before!))
    expect(recovery.files).toHaveLength(510)
    await run(tmp.path, (snapshot) => snapshot.revert([recovery]))
    expect(
      await fs.stat(`${tmp.path}/file-0509.txt`).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    await Instance.disposeAll()
  }
}, 60_000)

test("failed batch reads fall back only for blobs within the source budget", async () => {
  await using tmp = await tmpdir({ git: true })
  const shown: string[] = []
  let failedBatches = 0
  const spawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make(
        Effect.fnUntraced(function* (command) {
          if (ChildProcess.isStandardCommand(command) && command.command === "git") {
            if (command.args.includes("show")) shown.push(command.args.at(-1)!)
            if (command.args.includes("--batch")) {
              failedBatches++
              return yield* real.spawn(ChildProcess.make("git", ["invalid-preview-test-command"], command.options))
            }
          }
          return yield* real.spawn(command)
        }),
      )
    }),
  ).pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))
  const layer = Snapshot.layer.pipe(
    Layer.provide(spawner),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Config.defaultLayer),
  )
  try {
    await fs.writeFile(`${tmp.path}/large.txt`, "a".repeat(512 * 1024))
    await fs.writeFile(`${tmp.path}/small.txt`, "before\n")
    const beforeHash = (await $`git hash-object large.txt`.cwd(tmp.path).quiet().text()).trim()
    const before = await run(tmp.path, (snapshot) => snapshot.track(), layer)
    await fs.writeFile(`${tmp.path}/large.txt`, "b".repeat(512 * 1024))
    await fs.writeFile(`${tmp.path}/small.txt`, "after\n")
    const afterHash = (await $`git hash-object large.txt`.cwd(tmp.path).quiet().text()).trim()
    const after = await run(tmp.path, (snapshot) => snapshot.track(), layer)
    const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!), layer)
    expect(failedBatches).toBeGreaterThan(0)
    expect(shown).toHaveLength(2)
    expect(shown).not.toContain(beforeHash)
    expect(shown).not.toContain(afterHash)
    expect(diffs.find((item) => item.file === "large.txt")?.patchOmitted).toBe(true)
    expect(applyPatch("before\n", diffs.find((item) => item.file === "small.txt")!.patch)).toBe("after\n")
  } finally {
    await Instance.disposeAll()
  }
}, 30_000)
