import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import { resolveMainGitDir, resolveProjectId } from "../../src/project/project-id"
import { ProjectID } from "../../src/project/schema"

describe("resolveMainGitDir", () => {
  test("returns .git directory for main repo", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-pid-"))
    const dotgit = path.join(tmp, ".git")
    await fs.mkdir(dotgit)
    expect(resolveMainGitDir(tmp)).toBe(dotgit)
    await fs.rm(tmp, { recursive: true })
  })

  test("returns null for non-git directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-pid-nogit-"))
    expect(resolveMainGitDir(tmp)).toBeNull()
    await fs.rm(tmp, { recursive: true })
  })

  test("resolves worktree to main .git", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-pid-wt-"))
    const mainRepo = path.join(tmp, "main")
    const mainGit = path.join(mainRepo, ".git")
    const worktree = path.join(tmp, "worktree")
    const worktreeGitDir = path.join(mainGit, "worktrees", "wt1")
    await fs.mkdir(worktreeGitDir, { recursive: true })
    await fs.mkdir(worktree)
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`)
    expect(resolveMainGitDir(worktree)).toBe(mainGit)
    await fs.rm(tmp, { recursive: true })
  })
})

describe("resolveProjectId", () => {
  test("generates new UUID for git project without cache", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-pid-new-"))
    await fs.mkdir(path.join(tmp, ".git"))
    const id = resolveProjectId(tmp)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    const cached = await fs.readFile(path.join(tmp, ".git", "mimocode-project-id"), "utf-8")
    expect(cached.trim()).toBe(id)
    await fs.rm(tmp, { recursive: true })
  })

  test("reuses cached UUID for git project", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-pid-cache-"))
    await fs.mkdir(path.join(tmp, ".git"))
    await fs.writeFile(path.join(tmp, ".git", "mimocode-project-id"), "fixed-uuid-1234")
    expect(resolveProjectId(tmp)).toBe(ProjectID.make("fixed-uuid-1234"))
    await fs.rm(tmp, { recursive: true })
  })

  test("generates new UUID for non-git directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-pid-nogit-new-"))
    const id = resolveProjectId(tmp)
    expect(id).toMatch(/^[0-9a-f]{8}-/i)
    const cached = await fs.readFile(path.join(tmp, ".mimocode-project-id"), "utf-8")
    expect(cached.trim()).toBe(id)
    await fs.rm(tmp, { recursive: true })
  })
})
