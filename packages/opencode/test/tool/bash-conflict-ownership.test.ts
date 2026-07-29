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

/** A repo whose `feature` branch and base branch change the SAME line of the same
 *  file, so a plain merge conflicts — but `-X theirs` resolves it silently and the
 *  merge reports success. This is the shape the outcome-keyed arm cannot see. */
const overlapping = async (dir: string) => {
  const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(dir).quiet().text()).trim()
  await Bun.write(path.join(dir, "shard.txt"), "timeout = 30\n")
  await $`git add shard.txt`.cwd(dir).quiet()
  await $`git commit -m "chore: seed the shard config"`.cwd(dir).quiet()
  await $`git checkout -b feature`.cwd(dir).quiet()
  await Bun.write(path.join(dir, "shard.txt"), "timeout = 90\n")
  await $`git commit -am "fix: raise the timeout"`.cwd(dir).quiet()
  await $`git checkout ${branch}`.cwd(dir).quiet()
  await Bun.write(path.join(dir, "shard.txt"), "timeout = 15\n")
  await $`git commit -am "chore: lower the timeout"`.cwd(dir).quiet()
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

// The INTENT arm. The affordance above is keyed on the outcome, and `-X theirs`
// reaches the same end state with no outcome to key on: measured on git 2.50.1, a
// merge over genuinely conflicting hunks run with `-X theirs` exits 0, prints no
// CONFLICT, leaves a clean index and writes no MERGE_HEAD. So the arm above is not
// merely quiet there, it is unfireable — while the model has still decided the
// outcome of a conflict it does not own. This arm reads the COMMAND instead.
const INTENT = "THAT CALL IS NOT YOURS TO MAKE"

/** Just the part git produced, with any appended annotation cut off. Needed because
 *  both notices legitimately contain the token "CONFLICT" themselves, so asserting
 *  "git did not report a conflict" has to be done against git's own output. */
const fromGit = (output: string) => output.split("THIS MERGE ")[0]!

describe("tool.bash unilateral-resolution affordance", () => {
  test("annotates `-X theirs` on a merge that git reports as a clean SUCCESS", async () => {
    await using tmp = await tmpdir({ git: true, init: overlapping })
    const output = await bash(tmp.path, "git merge -X theirs feature -m 'take the feature side'")

    // The premise, asserted rather than assumed: git is perfectly happy. Nothing
    // the outcome-keyed arm looks at exists here.
    expect(fromGit(output)).toContain("Merge made by the 'ort' strategy.")
    expect(fromGit(output)).not.toContain("CONFLICT")
    expect(await Bun.file(path.join(tmp.path, ".git", "MERGE_HEAD")).exists()).toBe(false)
    expect((await $`git ls-files --unmerged`.cwd(tmp.path).quiet().text()).trim()).toBe("")
    expect(output).not.toContain(MARKER)
    // ...and the conflict really was settled unilaterally: the base's line is gone.
    expect(await Bun.file(path.join(tmp.path, "shard.txt")).text()).toBe("timeout = 90\n")

    // Which is exactly when the intent arm has to speak.
    expect(output).toContain(INTENT)
    expect(output).toContain("`-X theirs`")
    expect(output).toContain("belongs to the session that OWNS the branch being integrated")
    expect(output).toContain("1. git merge --abort")
    expect(output).toContain("2. re-run it WITHOUT `-X theirs`")
    expect(output).toContain("session send <owning-session-id>")
    // Phrased conditionally, because it cannot know the flag mattered.
    expect(output).toContain("WHAT THIS CANNOT TELL YOU")
    expect(output).toContain("NOT a report that a conflict was hidden")
  })

  test("does NOT annotate a benign `-X patience`, which tunes the diff and picks no side", async () => {
    await using tmp = await tmpdir({ git: true, init: overlapping })
    // A real conflict, and the option has nothing to do with resolving it: this is
    // the false positive a looser "-X appears anywhere" match would produce.
    const output = await bash(tmp.path, "git merge -X patience feature -m m || true")

    expect(output).not.toContain(INTENT)
    // The command DID conflict, so the outcome arm owns this one — unchanged.
    expect(output).toContain(MARKER)
  })

  test("a real conflicted merge still gets the OUTCOME notice, and only that one", async () => {
    await using tmp = await tmpdir({ git: true, init: conflicting("payments-shard.txt") })
    const output = await bash(tmp.path, "git merge feature")

    expect(output).toContain(MARKER)
    expect(output).toContain("1. git merge --abort")
    // Outcome first: it names the paths and the abort verb, so the intent block
    // must not also be appended.
    expect(output).not.toContain(INTENT)
  })

  test("does NOT attribute a later command's flag to the git part of a compound line", async () => {
    await using tmp = await tmpdir({ git: true, init: clean })
    // `-X theirs` is in the line, but not in the merge's segment of it.
    const output = await bash(tmp.path, "git merge feature -m 'merge feature'; echo 'used -X theirs once'")

    expect(output).toContain("used -X theirs once")
    expect(output).not.toContain(INTENT)
    expect(output).not.toContain(MARKER)
  })

  test("annotates the `ours` STRATEGY, which discards the other side wholesale", async () => {
    await using tmp = await tmpdir({ git: true, init: overlapping })
    const output = await bash(tmp.path, "git merge -s ours feature -m 'keep ours'")

    expect(fromGit(output)).toContain("Merge made by the 'ours' strategy.")
    expect(fromGit(output)).not.toContain("CONFLICT")
    expect(output).toContain(INTENT)
    expect(output).toContain("`-s ours`")
    // The strategy is described as stronger than the option, not as the same thing.
    expect(output).toContain("discards the other side's commits wholesale")
    // And it really did drop the branch's work.
    expect(await Bun.file(path.join(tmp.path, "shard.txt")).text()).toBe("timeout = 15\n")
  })
})

describe("tool.merge-conflict-notice unilateral detection", () => {
  test("matches every spelling of a side-picking flag on an integration verb", () => {
    const flag = (command: string) => MergeConflict.unilateral(command)?.flag
    expect(flag("git merge -X theirs feature")).toBe("-X theirs")
    expect(flag("git merge -Xtheirs feature")).toBe("-Xtheirs")
    expect(flag("git merge -X ours feature")).toBe("-X ours")
    expect(flag("git merge -Xours feature")).toBe("-Xours")
    expect(flag("git merge --strategy-option=theirs feature")).toBe("--strategy-option=theirs")
    expect(flag("git merge --strategy-option theirs feature")).toBe("--strategy-option theirs")
    expect(flag("git merge -s ours feature")).toBe("-s ours")
    expect(flag("git merge --strategy=ours feature")).toBe("--strategy=ours")
    // Not merge-only: every verb that takes a strategy option.
    expect(flag("git rebase -X theirs main")).toBe("-X theirs")
    expect(flag("git cherry-pick -X ours abc123")).toBe("-X ours")
    expect(flag("git pull --strategy-option=theirs origin main")).toBe("--strategy-option=theirs")
    expect(flag("git revert -X theirs HEAD")).toBe("-X theirs")
  })

  test("does not fire on `-X` values that pick no side", () => {
    for (const option of [
      "-X patience",
      "-X histogram",
      "-X minimal",
      "-X diff-algorithm=patience",
      "-X renormalize",
      "-X no-renormalize",
      "-X ignore-space-change",
      "-X ignore-all-space",
      "-X find-renames=90%",
      "-X no-renames",
      "-X subtree=lib",
    ]) {
      expect(MergeConflict.unilateral(`git merge ${option} feature`)).toBeUndefined()
    }
    // The side has to follow the flag, not merely appear somewhere after it: a
    // branch called `ours-fix` is not a request to keep ours.
    expect(MergeConflict.unilateral("git merge -X patience ours-fix")).toBeUndefined()
    expect(MergeConflict.unilateral("git merge ours")).toBeUndefined()
    expect(MergeConflict.unilateral("git merge theirs-branch")).toBeUndefined()
    // `-s theirs` is not a git strategy at all — git refuses to run it.
    expect(MergeConflict.unilateral("git merge -s theirs feature")).toBeUndefined()
  })

  test("keeps the `[^\\n;&|]` segment discipline, in both directions", () => {
    // Flag in a different command of the line: not the merge's.
    expect(MergeConflict.unilateral("git merge feature; echo -X theirs")).toBeUndefined()
    expect(MergeConflict.unilateral("git merge feature && grep -X theirs log")).toBeUndefined()
    expect(MergeConflict.unilateral("cat notes | grep -X theirs")).toBeUndefined()
    // But a LATER git command in the same line that does carry one is still found.
    expect(MergeConflict.unilateral("git fetch && git merge -X theirs feature")?.flag).toBe("-X theirs")
    expect(MergeConflict.unilateral("git merge a -m x; git merge -X ours b")?.flag).toBe("-X ours")
  })

  test("reports the strategy over the option, and labels the verb it hung off", () => {
    const both = MergeConflict.unilateral("git merge -X theirs -s ours feature")
    expect(both?.flag).toBe("-s ours")
    expect(both?.strategy).toBe(true)

    const option = MergeConflict.unilateral("git rebase -X theirs main")
    expect(option?.strategy).toBe(false)
    expect(option?.label).toBe("rebase")
    expect(option?.side).toBe("theirs")
    expect(option?.abort).toBe("git rebase --abort")
    // `git pull` aborts as the merge it ran, not as a `pull --abort` that does not exist.
    expect(MergeConflict.unilateral("git pull -X ours origin main")?.abort).toBe("git merge --abort")
    expect(MergeConflict.unilateral("git cherry-pick -X ours abc")?.abort).toBe("git cherry-pick --abort")
  })

  test("the notice states the limit it cannot get past, and invents no session id", () => {
    const text = MergeConflict.unilateralNotice({
      flag: "-X theirs",
      side: "theirs",
      label: "merge",
      abort: "git merge --abort",
      strategy: false,
    })
    expect(text).toContain("WHAT THIS CANNOT TELL YOU")
    expect(text).toContain("no-op on a merge whose two sides never overlapped")
    expect(text).toContain("NOT a report that a conflict was hidden")
    expect(text).toContain("<owning-session-id>")
    expect(text).toContain("internal working context")
    // No XML envelope for a model to imitate, same as the outcome notice.
    expect(text).not.toContain("<merge-conflict")
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
