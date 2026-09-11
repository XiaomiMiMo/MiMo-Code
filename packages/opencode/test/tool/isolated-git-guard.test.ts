import { describe, expect, test } from "bun:test"
import * as path from "path"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  assertIsolatedGitAllowed,
  gitInvocation,
  isIsolatedWorktree,
  ownBranch,
  violates,
} from "../../src/tool/isolated-git-guard"

const BRANCH = "feat/child-work"
const DIR = "/data/worktree/p_abc/child-1"

// Every real filename the allowed-list tests lean on. `git checkout <file>` is
// only distinguishable from `git checkout <branch>` by what exists on disk.
const FILES = new Set(["src/tool/bash.ts", "README.md", ".", "packages"])
const isPath = (arg: string) => FILES.has(arg)

function reject(command: string) {
  const tokens = command.split(/\s+/)
  return violates({ tokens, branch: BRANCH, isPath })
}

describe("isolated-git-guard / blocked cross-branch operations", () => {
  const blocked = [
    "git rebase main",
    "git rebase origin/main",
    "git rebase -i HEAD~3",
    "git merge main",
    "git merge --no-ff origin/main",
    "git checkout main",
    "git checkout dev",
    "git checkout origin/main",
    "git checkout -",
    "git switch main",
    "git switch --detach",
    "git checkout -B main",
    "git branch -f main HEAD",
    "git branch -D other/branch",
    "git branch --delete dev",
    "git branch -m dev renamed",
    "git push --force origin main",
    "git push -f origin HEAD:main",
    "git push origin +main",
    "git push origin :dev",
    "git push --delete origin dev",
    "git worktree add ../other -b x",
    "git worktree remove ../other",
    "git update-ref refs/heads/main HEAD",
    "git symbolic-ref HEAD refs/heads/main",
    // Tags have NO "checked out elsewhere" protection: measured, `git tag -f v1
    // HEAD` from a linked worktree prints `Updated tag 'v1'` and the parent
    // checkout resolves the new value.
    "git tag -f v1 HEAD",
    "git tag --force release main",
    "git tag -d v1",
    "git tag --delete release",
    // git global options must not smuggle the subcommand past the guard
    "git --no-pager rebase main",
    "git -C /elsewhere/repo checkout main",
    "git -c core.pager=cat merge main",
  ]

  for (const command of blocked) {
    test(`blocks: ${command}`, () => {
      expect(reject(command)).toBeTruthy()
    })
  }
})

describe("isolated-git-guard / allowed child work", () => {
  const allowed = [
    "git add -A",
    "git add src/tool/bash.ts",
    "git commit -m wip",
    "git commit --amend --no-edit",
    "git status",
    "git status --porcelain",
    "git diff",
    "git diff --cached",
    "git log --oneline -5",
    "git show HEAD",
    "git fetch origin",
    "git push",
    "git push origin HEAD",
    `git push -u origin ${BRANCH}`,
    `git push --force origin ${BRANCH}`,
    `git push --force-with-lease origin ${BRANCH}`,
    "git stash",
    "git stash pop",
    "git checkout -- src/tool/bash.ts",
    "git checkout -- .",
    "git checkout HEAD -- src/tool/bash.ts",
    "git checkout src/tool/bash.ts",
    "git checkout .",
    "git restore src/tool/bash.ts",
    "git checkout -b feat/child-work-2",
    "git switch -c feat/child-work-2",
    `git checkout ${BRANCH}`,
    `git checkout -B ${BRANCH}`,
    "git rebase --abort",
    "git rebase --continue",
    "git merge --abort",
    "git worktree list",
    "git branch",
    "git branch --show-current",
    "git symbolic-ref HEAD",
    // Creating a NEW tag is additive — it cannot move a ref anyone else holds.
    "git tag v2",
    "git tag -a v2 -m release",
    "git tag --list",
    // git reset / git pull are deliberately out of scope: neither can write a
    // ref other than the current worktree's own branch.
    "git reset --hard HEAD",
    "git reset --hard origin/main",
    "git pull",
    "git pull origin main",
    // non-git commands are never inspected
    "bun test",
    "rebase main",
  ]

  for (const command of allowed) {
    test(`allows: ${command}`, () => {
      expect(reject(command)).toBeUndefined()
    })
  }
})

describe("isolated-git-guard / unknown own branch fails closed on destructive forms", () => {
  const check = (command: string) => violates({ tokens: command.split(/\s+/), isPath })

  test("branch delete is blocked when the branch cannot be read", () => {
    expect(check("git branch -D whatever")).toBeTruthy()
  })

  test("force push with an explicit refspec is blocked when the branch cannot be read", () => {
    expect(check("git push --force origin whatever")).toBeTruthy()
  })

  test("plain commit/push still work when the branch cannot be read", () => {
    expect(check("git commit -m wip")).toBeUndefined()
    expect(check("git push")).toBeUndefined()
  })
})

describe("isolated-git-guard / gitInvocation", () => {
  test("skips global options that consume a value", () => {
    expect(gitInvocation(["git", "-C", "/repo", "--no-pager", "merge", "main"])).toEqual({
      sub: "merge",
      args: ["main"],
    })
  })

  test("ignores non-git commands", () => {
    expect(gitInvocation(["bun", "rebase"])).toBeUndefined()
    expect(gitInvocation(["git"])).toBeUndefined()
  })

  test("unquotes tokens", () => {
    expect(gitInvocation(["git", "checkout", '"main"'])).toEqual({ sub: "checkout", args: ["main"] })
  })
})

describe("isolated-git-guard / isolation signal", () => {
  const root = path.join("/data", "worktree")

  test("app-managed worktree directory is an isolated child", () => {
    expect(isIsolatedWorktree(path.join(root, "p_abc", "child-1"), root)).toBe(true)
  })

  test("the user's project directory is NOT an isolated child", () => {
    expect(isIsolatedWorktree("/Users/me/projects/app", root)).toBe(false)
  })

  test("undefined directory is not an isolated child", () => {
    expect(isIsolatedWorktree(undefined, root)).toBe(false)
  })
})

describe("isolated-git-guard / ownBranch", () => {
  test("reads the branch through a linked worktree's .git pointer file", () => {
    const base = mkdtempSync(path.join(tmpdir(), "guard-wt-"))
    const gitDir = path.join(base, "repo", ".git", "worktrees", "child")
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${BRANCH}\n`)
    const wt = path.join(base, "child")
    mkdirSync(wt)
    writeFileSync(path.join(wt, ".git"), `gitdir: ${gitDir}\n`)
    expect(ownBranch(wt)).toBe(BRANCH)
  })

  test("returns undefined for a detached HEAD", () => {
    const base = mkdtempSync(path.join(tmpdir(), "guard-detached-"))
    mkdirSync(path.join(base, ".git"), { recursive: true })
    writeFileSync(path.join(base, ".git", "HEAD"), "1234567890abcdef\n")
    expect(ownBranch(base)).toBeUndefined()
  })

  test("returns undefined when nothing is readable", () => {
    expect(ownBranch(path.join(tmpdir(), "definitely-not-a-repo-" + Date.now()))).toBeUndefined()
  })
})

describe("isolated-git-guard / assertIsolatedGitAllowed", () => {
  const call = (commands: string[][], isolated: boolean) =>
    assertIsolatedGitAllowed({ commands, directory: DIR, isolated, branch: BRANCH, isPath })

  test("a NON-isolated session is completely unaffected", () => {
    expect(() => call([["git", "rebase", "main"]], false)).not.toThrow()
    expect(() => call([["git", "checkout", "main"]], false)).not.toThrow()
    expect(() => call([["git", "branch", "-D", "dev"]], false)).not.toThrow()
  })

  test("an isolated child is blocked", () => {
    expect(() => call([["git", "rebase", "main"]], true)).toThrow()
  })

  test("every command node in a chain is checked, not just the first", () => {
    expect(() =>
      call(
        [
          ["git", "add", "-A"],
          ["git", "commit", "-m", "wip"],
          ["git", "checkout", "main"],
        ],
        true,
      ),
    ).toThrow(/git checkout main/)
  })

  test("the error names what was blocked, why, and what to do instead", () => {
    let text = ""
    try {
      call([["git", "rebase", "main"]], true)
    } catch (err) {
      text = (err as Error).message
    }
    expect(text).toContain("git rebase main")
    expect(text).toContain("shares ONE .git/ ref store")
    expect(text).toContain(DIR)
    expect(text).toContain(BRANCH)
    expect(text).toContain("git push")
    expect(text).toContain("ask the orchestrator")
  })
})
