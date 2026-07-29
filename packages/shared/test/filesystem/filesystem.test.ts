import { describe, test, expect } from "bun:test"
import { Effect, Layer, FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { testEffect } from "../lib/effect"
import path from "path"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

const live = AppFileSystem.layer.pipe(Layer.provideMerge(NodeFileSystem.layer))
const { effect: it } = testEffect(live)

describe("AppFileSystem", () => {
  describe("isDir", () => {
    it(
      "returns true for directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        expect(yield* fs.isDir(tmp)).toBe(true)
      }),
    )

    it(
      "returns false for files",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "test.txt")
        yield* filesys.writeFileString(file, "hello")
        expect(yield* fs.isDir(file)).toBe(false)
      }),
    )

    it(
      "returns false for non-existent paths",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        expect(yield* fs.isDir("/tmp/nonexistent-" + Math.random())).toBe(false)
      }),
    )
  })

  describe("isFile", () => {
    it(
      "returns true for files",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "test.txt")
        yield* filesys.writeFileString(file, "hello")
        expect(yield* fs.isFile(file)).toBe(true)
      }),
    )

    it(
      "returns false for directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        expect(yield* fs.isFile(tmp)).toBe(false)
      }),
    )
  })

  describe("readJson / writeJson", () => {
    it(
      "round-trips JSON data",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "data.json")
        const data = { name: "test", count: 42, nested: { ok: true } }

        yield* fs.writeJson(file, data)
        const result = yield* fs.readJson(file)

        expect(result).toEqual(data)
      }),
    )
  })

  describe("ensureDir", () => {
    it(
      "creates nested directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const nested = path.join(tmp, "a", "b", "c")

        yield* fs.ensureDir(nested)

        const info = yield* filesys.stat(nested)
        expect(info.type).toBe("Directory")
      }),
    )

    it(
      "is idempotent",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const dir = path.join(tmp, "existing")
        yield* filesys.makeDirectory(dir)

        yield* fs.ensureDir(dir)

        const info = yield* filesys.stat(dir)
        expect(info.type).toBe("Directory")
      }),
    )
  })

  describe("writeWithDirs", () => {
    it(
      "creates parent directories if missing",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "deep", "nested", "file.txt")

        yield* fs.writeWithDirs(file, "hello")

        expect(yield* filesys.readFileString(file)).toBe("hello")
      }),
    )

    it(
      "writes directly when parent exists",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "direct.txt")

        yield* fs.writeWithDirs(file, "world")

        expect(yield* filesys.readFileString(file)).toBe("world")
      }),
    )

    it(
      "writes Uint8Array content",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "binary.bin")
        const content = new Uint8Array([0x00, 0x01, 0x02, 0x03])

        yield* fs.writeWithDirs(file, content)

        const result = yield* filesys.readFile(file)
        expect(new Uint8Array(result)).toEqual(content)
      }),
    )
  })

  describe("findUp", () => {
    it(
      "finds target in start directory",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "target.txt"), "found")

        const result = yield* fs.findUp("target.txt", tmp)
        expect(result).toEqual([path.join(tmp, "target.txt")])
      }),
    )

    it(
      "finds target in parent directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "marker"), "root")
        const child = path.join(tmp, "a", "b")
        yield* filesys.makeDirectory(child, { recursive: true })

        const result = yield* fs.findUp("marker", child, tmp)
        expect(result).toEqual([path.join(tmp, "marker")])
      }),
    )

    it(
      "returns empty array when not found",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const result = yield* fs.findUp("nonexistent", tmp, tmp)
        expect(result).toEqual([])
      }),
    )
  })

  describe("up", () => {
    it(
      "finds multiple targets walking up",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "a.txt"), "a")
        yield* filesys.writeFileString(path.join(tmp, "b.txt"), "b")
        const child = path.join(tmp, "sub")
        yield* filesys.makeDirectory(child)
        yield* filesys.writeFileString(path.join(child, "a.txt"), "a-child")

        const result = yield* fs.up({ targets: ["a.txt", "b.txt"], start: child, stop: tmp })

        expect(result).toContain(path.join(child, "a.txt"))
        expect(result).toContain(path.join(tmp, "a.txt"))
        expect(result).toContain(path.join(tmp, "b.txt"))
      }),
    )
  })

  describe("glob", () => {
    it(
      "finds files matching pattern",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "a.ts"), "a")
        yield* filesys.writeFileString(path.join(tmp, "b.ts"), "b")
        yield* filesys.writeFileString(path.join(tmp, "c.json"), "c")

        const result = yield* fs.glob("*.ts", { cwd: tmp })
        expect(result.sort()).toEqual(["a.ts", "b.ts"])
      }),
    )

    it(
      "supports absolute paths",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "file.txt"), "hello")

        const result = yield* fs.glob("*.txt", { cwd: tmp, absolute: true })
        expect(result).toEqual([path.join(tmp, "file.txt")])
      }),
    )
  })

  describe("globMatch", () => {
    it(
      "matches patterns",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        expect(fs.globMatch("*.ts", "foo.ts")).toBe(true)
        expect(fs.globMatch("*.ts", "foo.json")).toBe(false)
        expect(fs.globMatch("src/**", "src/a/b.ts")).toBe(true)
      }),
    )
  })

  describe("globUp", () => {
    it(
      "finds files walking up directories",
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "root.md"), "root")
        const child = path.join(tmp, "a", "b")
        yield* filesys.makeDirectory(child, { recursive: true })
        yield* filesys.writeFileString(path.join(child, "leaf.md"), "leaf")

        const result = yield* fs.globUp("*.md", child, tmp)
        expect(result).toContain(path.join(child, "leaf.md"))
        expect(result).toContain(path.join(tmp, "root.md"))
      }),
    )
  })

  describe("built-in passthrough", () => {
    it(
      "exists works",
      Effect.gen(function* () {
        yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "exists.txt")
        yield* filesys.writeFileString(file, "yes")

        expect(yield* filesys.exists(file)).toBe(true)
        expect(yield* filesys.exists(file + ".nope")).toBe(false)
      }),
    )

    it(
      "remove works",
      Effect.gen(function* () {
        yield* AppFileSystem.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "delete-me.txt")
        yield* filesys.writeFileString(file, "bye")

        yield* filesys.remove(file)

        expect(yield* filesys.exists(file)).toBe(false)
      }),
    )
  })

  describe("pure helpers", () => {
    test("mimeType returns correct types", () => {
      expect(AppFileSystem.mimeType("file.json")).toBe("application/json")
      expect(AppFileSystem.mimeType("image.png")).toBe("image/png")
      expect(AppFileSystem.mimeType("unknown.qzx")).toBe("application/octet-stream")
    })

    test("contains checks path containment", () => {
      expect(AppFileSystem.contains("/a/b", "/a/b/c")).toBe(true)
      expect(AppFileSystem.contains("/a/b", "/a/c")).toBe(false)
    })

    test("overlaps detects overlapping paths", () => {
      expect(AppFileSystem.overlaps("/a/b", "/a/b/c")).toBe(true)
      expect(AppFileSystem.overlaps("/a/b/c", "/a/b")).toBe(true)
      expect(AppFileSystem.overlaps("/a", "/b")).toBe(false)
    })
  })

  describe("withinTrustedRoot", () => {
    // A REAL symlinked prefix, not a stub of `contains`: <tmp>/link -> <tmp>/real,
    // so one file can be named through either. This is the shape the trust callers
    // actually hit — `Instance.provide` stores a realpath-resolved directory while
    // `Global.Path.data` keeps the symlinked form.
    function symlinkFixture() {
      const base = mkdtempSync(path.join(realpathSync(tmpdir()), "trusted-root-"))
      const real = path.join(base, "real")
      const link = path.join(base, "link")
      mkdirSync(path.join(real, "nested"), { recursive: true })
      writeFileSync(path.join(real, "nested", "file.ts"), "x")
      symlinkSync(real, link, "dir")
      return { base, real, link }
    }

    test("agrees with contains whenever the paths are lexically related", () => {
      expect(AppFileSystem.withinTrustedRoot("/a/b", "/a/b/c")).toBe(true)
      expect(AppFileSystem.withinTrustedRoot("/a/b", "/a/b")).toBe(true)
    })

    test("a genuinely foreign path is still outside", () => {
      expect(AppFileSystem.withinTrustedRoot("/a/b", "/a/c")).toBe(false)
      // A path that merely resembles the root by name must not be admitted.
      expect(AppFileSystem.withinTrustedRoot("/data/worktree", "/tmp/worktree/foreign")).toBe(false)
    })

    test("root named through a symlink still contains a child named through the real path", () => {
      const { real, link } = symlinkFixture()
      const child = path.join(real, "nested", "file.ts")

      // The defect being fixed: purely lexical arithmetic says "outside".
      expect(AppFileSystem.contains(link, child)).toBe(false)
      expect(AppFileSystem.withinTrustedRoot(link, child)).toBe(true)
    })

    test("root named through the real path still contains a child named through the symlink", () => {
      const { real, link } = symlinkFixture()
      const child = path.join(link, "nested", "file.ts")

      expect(AppFileSystem.contains(real, child)).toBe(false)
      expect(AppFileSystem.withinTrustedRoot(real, child)).toBe(true)
    })

    test("a child that does not exist yet is still comparable", () => {
      // Load-bearing: a write names its file BEFORE it exists, so realpath throws
      // and the fallback must still resolve it against the realpath'd root.
      const { real, link } = symlinkFixture()
      const notYet = path.join(real, "nested", "created-later.ts")

      expect(AppFileSystem.contains(link, notYet)).toBe(false)
      expect(AppFileSystem.withinTrustedRoot(link, notYet)).toBe(true)
    })

    test("a not-yet-existing child named THROUGH the symlink is still inside", () => {
      // The case a plain `catch -> path.resolve` fallback gets wrong: `resolve`
      // performs no symlink resolution, so the link spelling survives and the
      // comparison misses. Since "may I create this file" is the commonest
      // boundary question on the write path, this is the dominant case, not a
      // corner one — the deepest existing ancestor must be canonicalized and
      // the missing tail re-appended.
      const { link } = symlinkFixture()
      const notYet = path.join(link, "nested", "created-later.ts")

      expect(AppFileSystem.withinTrustedRoot(link, notYet)).toBe(true)
      // And through the real root, which is the direction Instance.provide creates.
      const { real: real2, link: link2 } = symlinkFixture()
      expect(AppFileSystem.withinTrustedRoot(real2, path.join(link2, "nested", "created-later.ts"))).toBe(true)
    })

    test("a deep chain of missing components resolves without throwing", () => {
      const { real, link } = symlinkFixture()
      const deep = path.join(link, "nested", "a", "b", "c", "d.ts")

      expect(AppFileSystem.withinTrustedRoot(link, deep)).toBe(true)
      expect(AppFileSystem.withinTrustedRoot(real, deep)).toBe(true)
      // A missing chain that escapes the root is still outside.
      expect(AppFileSystem.withinTrustedRoot(path.join(real, "nested"), path.join(link, "sibling", "x.ts"))).toBe(false)
    })

    test("neither side existing falls back to lexical resolution rather than throwing", () => {
      const ghost = path.join(tmpdir(), "definitely-absent-" + Math.random().toString(36).slice(2))
      expect(AppFileSystem.withinTrustedRoot(ghost, path.join(ghost, "child.ts"))).toBe(true)
      expect(AppFileSystem.withinTrustedRoot(ghost, "/elsewhere/child.ts")).toBe(false)
    })
  })
})
