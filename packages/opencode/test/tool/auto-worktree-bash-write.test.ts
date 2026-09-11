import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import os from "os"
import path from "path"
import { commandMainWorktreeHits, commandWritesFiles } from "../../src/tool/bash"

let mainRepo = ""
let scratchDir = ""

beforeAll(async () => {
  mainRepo = path.join(os.tmpdir(), `aw-main-${Math.random().toString(36).slice(2)}`)
  scratchDir = path.join(os.tmpdir(), `aw-scratch-${Math.random().toString(36).slice(2)}`)
  await $`mkdir -p ${mainRepo} ${scratchDir}`.quiet()
  await $`git -C ${mainRepo} init -q`.quiet()
  await $`git -C ${mainRepo} config user.email t@t`.quiet()
  await $`git -C ${mainRepo} config user.name t`.quiet()
  await Bun.write(path.join(mainRepo, "a.txt"), "a\n")
  await $`git -C ${mainRepo} add a.txt`.quiet()
  await $`git -C ${mainRepo} commit -q -m init`.quiet()
})

afterAll(async () => {
  await $`rm -rf ${mainRepo} ${scratchDir}`.quiet().nothrow()
})

describe("bash commandWritesFiles", () => {
  test.each([
    ["echo test > output.txt", true],
    ["echo test >> log.txt", true],
    ["printf x > f", true],
    ["cmd 2> err.txt", true],
    ["cmd &> all.txt", true],
    ["echo hi | tee file", true],
    ["tee -a out.txt", true],
    ["cp a b", true],
    ["mv a b", true],
    ["touch f", true],
    ["mkdir d", true],
    ["install -m 644 a b", true],
    ["sed -i s/a/b/ file.txt", true],
    ["sed --in-place s/a/b/ file.txt", true],
    ["echo a > b && echo c >> d", true],
    ["cat <<EOF > file.txt\nhi\nEOF", true],
    ["ls -la", false],
    ["git status", false],
    ["cat file.txt", false],
    ["sed s/a/b/ file.txt", false],
    ["echo test", false],
    ["cmd 2>&1", false],
    ["python - <<PY\nprint(1)\nPY", false],
    ["git checkout -b feature", false],
    ["git commit -m x", false],
  ])("detects %s", async (command, expected) => {
    expect(await commandWritesFiles(command)).toBe(expected)
  })
})

describe("bash commandMainWorktreeHits", () => {
  test("relative write inside a main worktree hits", async () => {
    const hits = await commandMainWorktreeHits("echo x > out.txt", mainRepo)
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("cd-escape into a main worktree then write hits the target repo", async () => {
    const hits = await commandMainWorktreeHits(
      `cd ${mainRepo} && echo x > escaped.txt`,
      scratchDir,
    )
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("absolute redirect into a main worktree hits", async () => {
    const hits = await commandMainWorktreeHits(
      `echo x > ${path.join(mainRepo, "abs.txt")}`,
      scratchDir,
    )
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("git checkout in a main worktree hits even without a file write", async () => {
    const hits = await commandMainWorktreeHits("git checkout -b wt/feature", mainRepo)
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("git checkout after cd-escape hits the target repo", async () => {
    const hits = await commandMainWorktreeHits(
      `cd ${mainRepo} && git checkout -b wt/feature`,
      scratchDir,
    )
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("git status does not hit", async () => {
    expect(await commandMainWorktreeHits("git status", mainRepo)).toEqual([])
  })

  test("write in a non-git scratch dir does not hit", async () => {
    expect(await commandMainWorktreeHits("echo x > out.txt", scratchDir)).toEqual([])
  })

  test("ls does not hit", async () => {
    expect(await commandMainWorktreeHits("ls -la", mainRepo)).toEqual([])
  })

  test("git -C into a main worktree still hits", async () => {
    const hits = await commandMainWorktreeHits(`git -C ${mainRepo} commit -m x`, scratchDir)
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("git -c key=val checkout in a main worktree hits", async () => {
    const hits = await commandMainWorktreeHits("git -c user.name=t checkout -b x", mainRepo)
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("sed --in-place=<suffix> counts as a write", async () => {
    expect(await commandWritesFiles("sed --in-place=.bak s/a/b/ f.txt")).toBe(true)
    const hits = await commandMainWorktreeHits("sed --in-place=.bak s/a/b/ a.txt", mainRepo)
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("cp source from main to scratch does not hit main", async () => {
    const src = path.join(mainRepo, "a.txt")
    const dst = path.join(scratchDir, "copied.txt")
    const hits = await commandMainWorktreeHits(`cp ${src} ${dst}`, scratchDir)
    expect(hits).toEqual([])
  })

  test("cp dest in main hits main", async () => {
    const src = path.join(scratchDir, "note.txt")
    const dst = path.join(mainRepo, "copied.txt")
    const hits = await commandMainWorktreeHits(`cp ${src} ${dst}`, scratchDir)
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("mv source out of main hits main", async () => {
    const src = path.join(mainRepo, "a.txt")
    const dst = path.join(scratchDir, "moved.txt")
    const hits = await commandMainWorktreeHits(`mv ${src} ${dst}`, scratchDir)
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("mv dest into main hits main", async () => {
    const src = path.join(scratchDir, "note.txt")
    const dst = path.join(mainRepo, "moved.txt")
    const hits = await commandMainWorktreeHits(`mv ${src} ${dst}`, scratchDir)
    expect(hits).toEqual([path.resolve(mainRepo)])
  })

  test("pushd/popd restores cwd so a write lands back in the original dir", async () => {
    // push into main, write there, pop back to scratch, write again.
    // First write hits main; after pop the relative write must not claim main.
    const hitsInMain = await commandMainWorktreeHits(
      `pushd ${mainRepo} && echo x > in-main.txt`,
      scratchDir,
    )
    expect(hitsInMain).toEqual([path.resolve(mainRepo)])

    const hitsAfterPop = await commandMainWorktreeHits(
      `pushd ${mainRepo} && popd && echo x > in-scratch.txt`,
      scratchDir,
    )
    expect(hitsAfterPop).toEqual([])
  })

  test("git worktree add is the remediation and does not hit main", async () => {
    const wt = path.join(scratchDir, "new-wt")
    const hits = await commandMainWorktreeHits(`git worktree add ${wt} -b feat`, mainRepo)
    expect(hits).toEqual([])
  })

  test("multi-source mv still counts every source path", async () => {
    const a = path.join(mainRepo, "a.txt")
    const b = path.join(mainRepo, "b.txt")
    const c = path.join(scratchDir, "c.txt")
    const dst = path.join(scratchDir, "out")
    const hits = await commandMainWorktreeHits(`mv ${a} ${b} ${c} ${dst}`, scratchDir)
    expect(hits).toEqual([path.resolve(mainRepo)])
  })
})
