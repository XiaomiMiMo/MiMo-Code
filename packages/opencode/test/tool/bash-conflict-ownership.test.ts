import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Effect, Layer, ManagedRuntime } from "effect"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import * as MergeConflict from "../../src/tool/merge-conflict-notice"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Plugin } from "../../src/plugin"
import * as Git from "../../src/git"
import { tmpdir } from "../fixture/fixture"

// The affordance that replaced prose. orchestrator.txt says a CONFLICT belongs to
// the session that owns the branch — abort and route it back — and that sentence
// lost 3/3 live turns to the model resolving the hunks itself. The fix is that a
// `git merge` which conflicts reports the rule in its OWN tool result, because a
// tool result is read before the next tool call and a system prompt is not.
//
// What has to be nailed down, and is:
//   - a REAL conflicted merge is annotated,
//   - a CLEAN merge is not,
//   - a command that merely PRINTS "CONFLICT" is not — the false positive the
//     signal was chosen to exclude,
//   - a clean `git merge --no-commit` (MERGE_HEAD present, index clean) is not —
//     which is what makes the unmerged-index half of the signal load-bearing
//     rather than decorative,
//   - `git merge --abort` clears it, proving the verdict comes from git's index
//     and not from the text of the command or its output.

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Git.defaultLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_conflict_notice_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const init = () => runtime.runPromise(BashTool.pipe(Effect.flatMap((info) => info.init())))

/** Runs `command` through the real bash tool with `dir` as the session directory
 *  and returns the tool RESULT — the string the model would read. */
async function bash(dir: string, command: string) {
  return await Instance.provide({
    directory: dir,
    fn: async () => {
      // init() has to run INSIDE the Instance context: bashDescription() reads
      // Instance.directory while assembling the tool description.
      const tool = await init()
      const result = await Effect.runPromise(tool.execute({ command, description: "conflict probe" }, ctx))
      return result.output
    },
  })
}

/** A repo whose `feature` branch and base branch both touch the same file, so
 *  merging conflicts. Mirrors the live fixture's shape exactly
 *  (`orchestrator-live-behavior.test.ts`, `conflictWith`). */
const conflicting = (base: string) => async (dir: string) => {
  const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(dir).quiet().text()).trim()
  await $`git checkout -b feature`.cwd(dir).quiet()
  await Bun.write(path.join(dir, base), "raise the shard 3 timeout\n")
  await $`git add ${base}`.cwd(dir).quiet()
  await $`git commit -m "fix: raise the timeout"`.cwd(dir).quiet()
  await $`git checkout ${branch}`.cwd(dir).quiet()
  await Bun.write(path.join(dir, base), "leave the shard 3 timeout alone\n")
  await $`git add ${base}`.cwd(dir).quiet()
  await $`git commit -m "chore: pin the timeout"`.cwd(dir).quiet()
  return branch
}

/** A repo whose `feature` branch touches a file the base branch never did, so
 *  merging fast-forwards/commits cleanly. */
const clean = async (dir: string) => {
  const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(dir).quiet().text()).trim()
  await $`git checkout -b feature`.cwd(dir).quiet()
  await Bun.write(path.join(dir, "feature-only.txt"), "new file\n")
  await $`git add feature-only.txt`.cwd(dir).quiet()
  await $`git commit -m "feat: add a file the base never had"`.cwd(dir).quiet()
  await $`git checkout ${branch}`.cwd(dir).quiet()
  await Bun.write(path.join(dir, "base-only.txt"), "base file\n")
  await $`git add base-only.txt`.cwd(dir).quiet()
  await $`git commit -m "chore: add a base-only file"`.cwd(dir).quiet()
  return branch
}

const MARKER = "THE CONFLICT IS NOT YOURS TO RESOLVE"

describe("tool.bash conflict-ownership affordance", () => {
  test("annotates a REAL conflicted merge with the ownership rule, the abort and the route-back", async () => {
    await using tmp = await tmpdir({ git: true, init: conflicting("payments-shard.txt") })
    const output = await bash(tmp.path, "git merge feature")

    // git actually conflicted — the premise of the assertion, not an assumption.
    expect(output).toContain("CONFLICT")
    expect(output).toContain(MARKER)
    // The ownership rule, stated as ownership and not as "be careful".
    expect(output).toContain("A conflict belongs to the session that OWNS `feature`")
    // The two literal commands. `git merge --abort` because MERGE_HEAD is what is
    // on disk; the branch name because git recorded it in MERGE_MSG.
    expect(output).toContain("1. git merge --abort")
    expect(output).toContain('2. session send <owning-session-id> "feature conflicts with the base branch')
    // The conflicted path is named, from git's index rather than from the text.
    expect(output).toContain("payments-shard.txt")
    // And the exact moves the 3 live runs made are named as forbidden.
    expect(output).toContain("do NOT edit conflict markers")
    expect(output).toContain("`git add`/`git commit`")
  })

  test("does NOT annotate a clean merge", async () => {
    await using tmp = await tmpdir({ git: true, init: clean })
    const output = await bash(tmp.path, "git merge feature -m 'merge feature'")

    expect(output).not.toContain(MARKER)
  })

  test("does NOT annotate a command that merely PRINTS the word CONFLICT", async () => {
    await using tmp = await tmpdir({ git: true, init: conflicting("payments-shard.txt") })
    // Same repo shape as the conflicting case, but nothing was merged: the text
    // hint fires and the index probe throws it out. This is the false positive
    // the signal exists to exclude.
    const output = await bash(tmp.path, `echo "CONFLICT (content): Merge conflict in payments-shard.txt"; exit 1`)

    expect(output).toContain("CONFLICT (content)")
    expect(output).not.toContain(MARKER)
  })

  test("does NOT annotate a clean `git merge --no-commit`, which leaves MERGE_HEAD but no unmerged paths", async () => {
    await using tmp = await tmpdir({ git: true, init: clean })
    const output = await bash(tmp.path, "git merge --no-commit --no-ff feature")

    // MERGE_HEAD is on disk: "a merge is in progress" is TRUE here and is not
    // enough on its own. Only the unmerged index separates this from a conflict.
    expect(await Bun.file(path.join(tmp.path, ".git", "MERGE_HEAD")).exists()).toBe(true)
    expect(output).not.toContain(MARKER)
  })

  test("stops annotating once the merge is aborted", async () => {
    await using tmp = await tmpdir({ git: true, init: conflicting("payments-shard.txt") })
    expect(await bash(tmp.path, "git merge feature")).toContain(MARKER)

    // Same conflict-capable command shape, but git's index is clean again.
    const output = await bash(tmp.path, "git merge --abort && git status --short")
    expect(output).not.toContain(MARKER)
  })

  test("names `git rebase --abort` for a conflicted rebase, not `git merge --abort`", async () => {
    await using tmp = await tmpdir({ git: true, init: conflicting("payments-shard.txt") })
    const output = await bash(tmp.path, "git rebase feature")

    expect(output).toContain(MARKER)
    expect(output).toContain("1. git rebase --abort")
    expect(output).not.toContain("git merge --abort")
  })
})

describe("tool.merge-conflict-notice decision logic", () => {
  test("hint is a cheap pre-test only — generous, because the index probe decides", () => {
    expect(MergeConflict.hint({ command: "echo hi", output: "CONFLICT" })).toBe(true)
    expect(MergeConflict.hint({ command: "git merge feature", output: "" })).toBe(true)
    expect(MergeConflict.hint({ command: "git cherry-pick abc", output: "" })).toBe(true)
    expect(MergeConflict.hint({ command: "ls -la", output: "all good" })).toBe(false)
    // Lowercase "conflict" in prose is not git's token and must not buy a probe.
    expect(MergeConflict.hint({ command: "ls", output: "no conflict here" })).toBe(false)
  })

  test("unmerged dedupes the per-stage lines git prints", () => {
    const text = [
      "100644 aaa 1\tpayments-shard.txt",
      "100644 bbb 2\tpayments-shard.txt",
      "100644 ccc 3\tpayments-shard.txt",
      "100644 ddd 2\tsrc/other.ts",
      "",
    ].join("\n")
    expect(MergeConflict.unmerged(text)).toEqual(["payments-shard.txt", "src/other.ts"])
    expect(MergeConflict.unmerged("")).toEqual([])
  })

  test("incoming reads the branch git recorded, and returns undefined rather than guessing", () => {
    expect(MergeConflict.incoming("Merge branch 'payments-shard-fix'\n\n# Conflicts:\n#\tx\n")).toBe(
      "payments-shard-fix",
    )
    expect(MergeConflict.incoming("Merge remote-tracking branch 'origin/topic'\n")).toBe("origin/topic")
    expect(MergeConflict.incoming("land the payments fix\n")).toBeUndefined()
  })

  test("notice degrades honestly when git recorded no branch name", () => {
    const text = MergeConflict.notice({ files: ["a.txt"], abort: "git merge --abort", label: "merge" })
    expect(text).toContain("the branch you just integrated")
    // No id is invented; the roster the session tool already injects is cited.
    expect(text).toContain("<owning-session-id>")
    expect(text).toContain("`session list` shows the roster")
  })
})
