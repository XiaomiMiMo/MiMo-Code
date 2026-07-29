import * as path from "path"
import { existsSync, readFileSync } from "node:fs"
import { Effect } from "effect"
import type { Git } from "@/git"

/**
 * CONFLICT-OWNERSHIP AFFORDANCE for the bash tool.
 *
 * The orchestrator prompt already says the right thing (orchestrator.txt, the
 * "YOU ARE THE MAINTAINER, NOT THE PR AUTHOR" paragraph): merging an integrated
 * branch is the maintainer's job, but *a CONFLICT belongs to the session that
 * owns the branch* — abort and route it back, do not resolve the hunks.
 *
 * That prose failed 3/3 live turns on mimo-v2.5. Not by stalling: each run
 * completed an 8-13 call loop that merged, hit `CONFLICT (add/add)`, then
 * `read` → `edit`/`write` → `git add` → `git commit`. Zero `session` calls in
 * all three. One run also `git branch -d`'d the author's branch. The maintainer
 * half was obeyed; the author half was not.
 *
 * WHY THIS IS A TOOL RESULT AND NOT MORE PROMPT WORDING. The system prompt is
 * assembled once per REQUEST, so by the time the model is choosing its fourth
 * tool call the prompt is old news competing with 3 turns of fresh output. A
 * tool RESULT is read immediately before the next tool call. `session create`
 * was made route-first the same way — it echoes the sibling roster into its own
 * output (`tool/session.ts` `dispatchLedgerNotice`) instead of asking the prompt
 * to be remembered. This is that mechanism applied to the merge conflict: the
 * `git merge` that produced the conflict reports the ownership rule and the two
 * literal commands in its own result, so the model reads them before it can
 * reach for `read`/`edit`.
 *
 * IT ANNOTATES, IT NEVER BLOCKS. The merge attempt is legitimate — it is the
 * orchestrator's job — so refusal is the wrong instrument, exactly as it was for
 * duplicate dispatch: make the right move visible, do not block the wrong one.
 * Nothing here changes the exit code, the output that git produced, or whether
 * the command ran.
 *
 * THE SIGNAL: two facts git owns, both required.
 *
 *   1. the index has unmerged entries      (`git ls-files --unmerged` non-empty)
 *   2. an integration is in progress       (MERGE_HEAD | CHERRY_PICK_HEAD |
 *                                           REVERT_HEAD | rebase-merge/ |
 *                                           rebase-apply/ in the git dir)
 *
 * Neither can be produced by a command that merely PRINTS the word conflict,
 * which is the false positive to avoid: `echo "CONFLICT (content): ..."` leaves
 * a clean index. Rejected alternatives:
 *
 *   - "non-zero exit and CONFLICT in the output" — that IS the false positive.
 *   - MERGE_HEAD alone — merge-specific (a conflicted rebase writes
 *     `rebase-merge/`, a conflicted cherry-pick writes `CHERRY_PICK_HEAD`), and
 *     it is equally set by a CLEAN `git merge --no-commit`, so on its own it
 *     cannot tell "mid-merge" from "conflicted". Test (1) is the one with teeth;
 *     (2) is kept because it names the exact abort verb — `git rebase --abort`
 *     is not `git merge --abort` — and because it excludes a stray unmerged
 *     index with no abortable operation behind it (a conflicted `git stash pop`,
 *     which has no other session to route to and is out of scope).
 *
 * Exit code is deliberately NOT part of the signal: `git merge x || true` exits
 * 0 and is still conflicted.
 *
 * COST. Both probes sit behind `hint()`, a text test whose only job is to decide
 * whether spending a git spawn is worth it. An ordinary bash call pays nothing.
 * The hint is allowed to be loose precisely because it cannot annotate on its
 * own — it only ever buys the two authoritative probes.
 *
 * SCOPE: every session, keyed on the outcome alone. This is the OPPOSITE of
 * `isolated-git-guard.ts`, which keys on `isIsolatedWorktree(Instance.directory)`
 * and therefore never fires for the orchestrator — the blind spot the live runs
 * walked straight into. Three reasons not to add a role gate here:
 *
 *   - The gate that would be exactly right — "does one of my sessions own the
 *     branch I just merged?" — is not observable from this tool. It needs the
 *     child roster AND a branch→session map; the bash tool has neither, and
 *     pulling in the Session service would buy only "do I have children", not
 *     the branch question, at the cost of a service dependency on the hottest
 *     tool in the process.
 *   - "Only when I am the orchestrator" repeats the isolated-git-guard mistake
 *     one level up: ANY session can `session create`, so any session can end up
 *     merging a branch a child authored.
 *   - The two mechanisms cannot contradict each other. For an isolated child
 *     `git merge` is refused outright by the guard, so this annotation is
 *     unreachable there. Where it does fire, the notice is conditional on
 *     ownership ("if a session owns it") and so stays true for a solo session
 *     that legitimately owns both sides — which reads the same block and
 *     correctly concludes there is nothing to route.
 *
 * EXPOSURE. A tool result is MORE exposed than a system prompt, not less: it
 * arrives mid-turn as fresh content and a model may relay it verbatim as if it
 * were its own output. That is how the system-prompt roster's `<active-sessions>`
 * envelope reached a user's screen (see `ROSTER_HEADER` in session/llm.ts). Two
 * consequences are honoured here. First, this block carries NO XML envelope — no
 * tag for the model to imitate, only prose and a numbered list, the same shape
 * `dispatchLedgerNotice` uses. Second, it says outright that it is internal. That
 * second half is the weak lever, and it is labelled as such: it can only ask, and
 * a determined paraphrase still gets through. Unlike the roster, the artifact
 * cannot simply be deleted — the whole block IS the affordance — so the strong
 * form of this fix would be an output-side strip at the assistant-text seam
 * (`session/processor.ts` `text-end`, which already carries an
 * `experimental.text.complete` plugin hook). Not built here: it touches the
 * hottest path in the session loop and needs its own behavioural evidence.
 *
 * The owning session is NOT named. It genuinely cannot be from here, and a
 * fabricated id is worse than none — so the notice points at the roster the
 * session tool already injects (`session list`, and the ledger every dispatch
 * echoes) and leaves the id as a placeholder.
 *
 * TWO ARMS, BECAUSE OUTCOME-KEYING HAS AN INTENT-SHAPED HOLE. Everything above
 * describes the OUTCOME arm, and its scope sentence is exact: keyed on the outcome
 * alone. That is also its limit. `git merge -X theirs` (or `-X ours`,
 * `--strategy-option=`, or the `ours` strategy via `-s ours`) reaches the same end
 * state — one side of the contested hunks thrown away by whoever ran the merge —
 * with NO conflict for git to report: clean index, no marker, exit 0. Every probe
 * above is negative, so the affordance is not merely quiet there, it is
 * constructively unfireable, while the rule it enforces has still been broken. A
 * detector keyed on the aftermath necessarily cannot see a decision that leaves no
 * aftermath, so the second arm reads the COMMAND instead — see `unilateral` below
 * for the flags matched, the ones excluded, and the limit that cannot be removed.
 */

/** In-progress integration states, in the order git resolves them, each paired
 *  with the abort that undoes it. `rebase-merge`/`rebase-apply` are directories;
 *  the rest are files. `existsSync` covers both. */
const OPERATIONS: ReadonlyArray<{ marker: string; abort: string; label: string }> = [
  { marker: "rebase-merge", abort: "git rebase --abort", label: "rebase" },
  { marker: "rebase-apply", abort: "git rebase --abort", label: "rebase" },
  { marker: "CHERRY_PICK_HEAD", abort: "git cherry-pick --abort", label: "cherry-pick" },
  { marker: "REVERT_HEAD", abort: "git revert --abort", label: "revert" },
  { marker: "MERGE_HEAD", abort: "git merge --abort", label: "merge" },
]

/** The integration subcommands, and the abort that undoes each. One list because
 *  BOTH arms key on it: the outcome arm asks "could this have left a conflicted
 *  index", the intent arm asks "was a side-picking flag attached to one of these".
 *  `pull` has no abort of its own — it aborts as the merge it ran. */
const INTEGRATIONS: ReadonlyArray<{ verb: string; abort: string }> = [
  { verb: "merge", abort: "git merge --abort" },
  { verb: "pull", abort: "git merge --abort" },
  { verb: "rebase", abort: "git rebase --abort" },
  { verb: "cherry-pick", abort: "git cherry-pick --abort" },
  { verb: "revert", abort: "git revert --abort" },
  { verb: "am", abort: "git am --abort" },
]

const VERBS = INTEGRATIONS.map((integration) => integration.verb).join("|")

/** git subcommands that can leave a conflicted index. Matched loosely on the
 *  command string on purpose — see `hint`. */
const CAPABLE = new RegExp(`\\bgit\\b[^\\n;&|]*?\\b(${VERBS})\\b`)

/**
 * Cheap pre-test: is it worth spawning git to find out? True when the output
 * carries git's own uppercase CONFLICT token or the command mentions a
 * subcommand that can conflict.
 *
 * This is a HINT, never a verdict. `echo CONFLICT` passes it and is then thrown
 * out by the index probe, which is the whole point of splitting the two: the
 * cheap test may be generous because the expensive test is the one that decides.
 */
export function hint(input: { command: string; output: string }) {
  if (/\bCONFLICT\b/.test(input.output)) return true
  return CAPABLE.test(input.command)
}

/** Unmerged paths from `git ls-files --unmerged` output. That command prints one
 *  line PER STAGE (`<mode> <sha> <stage>\t<path>`), so a single conflicted file
 *  appears 2-3 times; dedupe and keep git's order. */
export function unmerged(text: string) {
  const out: string[] = []
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t")
    if (tab === -1) continue
    const file = line.slice(tab + 1).trim()
    if (file && !out.includes(file)) out.push(file)
  }
  return out
}

/** The branch name git recorded for the merge it is in the middle of. `MERGE_MSG`
 *  holds git's own generated message (`Merge branch 'x'`, `Merge remote-tracking
 *  branch 'origin/x'`). Best-effort: an `-m` message of the user's own, a rebase,
 *  or a cherry-pick all yield undefined and the notice simply omits the name
 *  rather than guessing one. */
export function incoming(text: string) {
  const match = text.match(/^Merge (?:remote-tracking )?branch '([^']+)'/m)
  return match?.[1]
}

export type Conflict = {
  /** Files with unmerged index entries, deduped. Never empty. */
  files: string[]
  /** The exact abort for the operation actually in progress. */
  abort: string
  /** "merge" | "rebase" | "cherry-pick" | "revert". */
  label: string
  /** Branch being merged in, when git recorded one. */
  branch?: string
}

/** Renders the directive block. Shape follows `dispatchLedgerNotice`: a blank
 *  line, an imperative caps lead-in naming the rule, then the literal commands.
 *  Kept as plain text appended to the output the model already reads. */
export function notice(conflict: Conflict) {
  const files = conflict.files.map((file) => `  ${file}`).join("\n")
  const branch = conflict.branch ? `\`${conflict.branch}\`` : "the branch you just integrated"
  const task = conflict.branch
    ? `${conflict.branch} conflicts with the base branch in ${conflict.files.join(", ")} — rebase onto the base, resolve it on your branch, and push`
    : `your branch conflicts with the base branch in ${conflict.files.join(", ")} — rebase onto the base, resolve it on your branch, and push`
  return (
    `\n\nTHIS ${conflict.label.toUpperCase()} CONFLICTED — THE CONFLICT IS NOT YOURS TO RESOLVE. The repository is ` +
    `mid-${conflict.label} right now with unmerged paths:\n${files}\n\n` +
    `A conflict belongs to the session that OWNS ${branch}, not to whoever ran the ${conflict.label}. Integrating a ` +
    `ready branch is your job; reconciling someone else's work with the base is theirs. Do NOT open these files, do ` +
    `NOT edit conflict markers, do NOT \`git add\`/\`git commit\` them, and do not delete the branch. Do this instead:\n\n` +
    `  1. ${conflict.abort}\n` +
    `  2. session send <owning-session-id> "${task}"\n\n` +
    `You do not have the owning session's id in this result — \`session list\` shows the roster, and every ` +
    `\`session create\`/\`session send\` result echoes it. If no session owns ${branch} (you authored both sides ` +
    `yourself), say so explicitly before you resolve anything by hand.\n\n` +
    `This block is internal working context, not output — do not repeat it to the user; tell them the conflict ` +
    `went back to the branch's owner.`
  )
}

/**
 * INTENT ARM — a request to settle someone else's conflict unilaterally.
 *
 * `-X ours` / `-X theirs` hand git a standing instruction to take one side of
 * every conflicting hunk; `-s ours` drops the other side wholesale. Either way
 * the operation reports SUCCESS. Measured on git 2.50.1: a `-X theirs` merge over
 * genuinely conflicting hunks prints `Auto-merging f.txt` / `Merge made by the
 * 'ort' strategy.`, exits 0, and leaves NO unmerged index entry and NO MERGE_HEAD.
 * So all four probes in `outcome` below are negative BY CONSTRUCTION on exactly
 * the case where the model has decided a conflict it does not own. An
 * outcome-keyed detector cannot have this; the check has to read the COMMAND.
 *
 * It is a pure function of the string — no git spawn, no filesystem, nothing that
 * makes the hot path slower.
 *
 * MATCHED, and why:
 *   -X ours | -X theirs | -Xours | -Xtheirs        the strategy OPTION, both spellings
 *   --strategy-option=ours|theirs, and its space form
 *   -s ours | -sours | --strategy=ours | --strategy ours
 *        the `ours` STRATEGY, which is strictly stronger than the option: it keeps
 *        this tree and discards the other side's commits entirely, including
 *        changes that never conflicted with anything. Reported in preference to
 *        the option when a command carries both.
 *
 * DELIBERATELY NOT MATCHED:
 *   - any other `-X` value. `-X patience`, `-X histogram`, `-X diff-algorithm=…`,
 *     `-X renormalize`, `-X ignore-space-change`, `-X find-renames=…` tune HOW the
 *     diff is computed and never pick a winner. This is why the side is matched
 *     immediately after the flag instead of searched for anywhere in the command:
 *     `git merge -X patience ours-branch` must not fire, and does not.
 *   - `-s theirs`. It does not exist. git 2.50.1 answers "Could not find merge
 *     strategy 'theirs'" and refuses to run, so there is no outcome to warn about.
 *   - a flag belonging to a DIFFERENT command on a compound line. Both regexes
 *     keep the existing `[^\n;&|]` discipline, so in `git merge feature; echo -X
 *     theirs` the echo's flag cannot be attributed to the merge.
 */
const SIDE_OPTION = /(?:-X\s*|--strategy-option[=\s]+)(ours|theirs)\b/
const SIDE_STRATEGY = /(?:-s\s*|--strategy[=\s]+)(ours)\b/

/** An integration verb plus the remainder of ITS segment of the command line.
 *  Global because a compound line can hold several and only some carry a flag. */
const UNILATERAL = new RegExp(`\\bgit\\b[^\\n;&|]*?\\b(${VERBS})\\b([^\\n;&|]*)`, "g")

export type Unilateral = {
  /** The flag exactly as the command spelled it, e.g. "-X theirs". */
  flag: string
  /** The side git was told to keep. */
  side: "ours" | "theirs"
  /** The integration verb the flag was attached to. */
  label: string
  /** The abort that undoes that verb. */
  abort: string
  /** True for the `ours` STRATEGY, which discards the other side wholesale. */
  strategy: boolean
}

/** The side-picking flag attached to an integration verb, or undefined. */
export function unilateral(command: string): Unilateral | undefined {
  for (const segment of command.matchAll(UNILATERAL)) {
    const integration = INTEGRATIONS.find((candidate) => candidate.verb === segment[1])
    if (!integration) continue
    const strategy = SIDE_STRATEGY.exec(segment[2] ?? "")
    const found = strategy ?? SIDE_OPTION.exec(segment[2] ?? "")
    if (!found) continue
    return {
      flag: found[0].replace(/\s+/g, " ").trim(),
      side: found[1] as "ours" | "theirs",
      label: integration.verb,
      abort: integration.abort,
      strategy: strategy !== null,
    }
  }
  return undefined
}

/**
 * Renders the intent-arm block. Same shape as `notice` — no XML envelope, caps
 * lead-in, literal numbered commands, and a line saying it is internal.
 *
 * PHRASED CONDITIONALLY, and that is load-bearing rather than hedging. This
 * cannot know whether the flag changed anything, and the limit is not an
 * implementation gap that a better probe would close. Two things were measured on
 * git 2.50.1 and both failed:
 *
 *   - the OUTPUT. A `-X theirs` merge that really did settle overlapping hunks and
 *     one where the sides never overlapped both print `Auto-merging f.txt` /
 *     `Merge made by the 'ort' strategy.` — byte-identical, and identical again to
 *     the same merge run with no flag at all. Suppressing on `Fast-forward` would
 *     also invert this module's own rule that text alone must never decide.
 *   - a post-hoc `git merge-tree --write-tree HEAD^1 HEAD^2`. It does separate the
 *     two for a committed merge, and is wrong in the case that matters most: a
 *     `-s ours` merge with NO textual conflict anywhere reports exit 0 — "no-op" —
 *     while having discarded the other branch's entire contribution. It also has
 *     no second parent to read after a cherry-pick, a rebase, a `--no-commit`, or
 *     a fast-forward, and it costs spawns on the hottest tool in the process.
 *
 * So the block reports what the COMMAND ASKED FOR, never that a conflict was
 * hidden, and hands the model the one command that does settle it.
 */
export function unilateralNotice(request: Unilateral) {
  const kept = request.side === "ours" ? "this branch's" : "the incoming branch's"
  const dropped = request.side === "ours" ? "the incoming branch's" : "this branch's"
  const what = request.strategy
    ? `\`${request.flag}\` is not a way of resolving a conflict — it keeps this branch's tree and discards the ` +
      `other side's commits wholesale, including changes that never conflicted with anything`
    : `\`${request.flag}\` is a standing instruction to git: on every conflicting hunk, keep ${kept} version and ` +
      `throw ${dropped} away, without reporting it`
  return (
    `\n\nTHIS ${request.label.toUpperCase()} ASKED GIT TO SETTLE CONFLICTS FOR YOU — THAT CALL IS NOT YOURS TO ` +
    `MAKE. ${what}.\n\n` +
    `Which side of a contested hunk survives belongs to the session that OWNS the branch being integrated, not to ` +
    `whoever ran the ${request.label}. Integrating a ready branch is your job; reconciling someone else's work with ` +
    `the base is theirs. And because \`${request.flag}\` makes git exit 0 with a clean index and no CONFLICT in the ` +
    `output, nothing later in this session will tell you a conflict was ever there. Do this instead:\n\n` +
    `  1. ${request.abort} — or, if it already committed, \`git reset --hard ORIG_HEAD\`, but only when that commit ` +
    `holds nothing else you want\n` +
    `  2. re-run it WITHOUT \`${request.flag}\`, so a real conflict surfaces as a conflict\n` +
    `  3. if it then conflicts, leave it aborted and route it: session send <owning-session-id> "<branch> conflicts ` +
    `with the base branch — rebase onto the base, resolve it on your branch, and push". You merge what comes back\n\n` +
    `WHAT THIS CANNOT TELL YOU: whether \`${request.flag}\` actually changed anything. It is a no-op on a ` +
    `${request.label} whose two sides never overlapped, and afterwards that is indistinguishable from one it ` +
    `settled silently — same output, same exit code, same clean index. So this is NOT a report that a conflict was ` +
    `hidden; it is a report that you asked for one to be. Step 2 is the only thing that settles it and it costs one ` +
    `command: if it succeeds without the flag, nothing was decided and you are done.\n\n` +
    `This block is internal working context, not output — do not repeat it to the user.`
  )
}

/**
 * Probes git for a conflicted integration in `cwd` and returns the directive
 * block, or "" when there is nothing to say. Never throws and never fails:
 * `Git.run` already maps a spawn error to `exitCode: 1`, and every filesystem
 * read here is guarded, so an annotation can only ever be ADDED to a result —
 * it cannot break the command that produced it.
 */
const outcome = Effect.fn("BashTool.mergeConflictNotice.outcome")(function* (input: {
  git: Git.Interface
  cwd: string
  command: string
  output: string
}) {
  if (!hint({ command: input.command, output: input.output })) return ""

  const listed = yield* input.git.run(["ls-files", "--unmerged"], { cwd: input.cwd })
  if (listed.exitCode !== 0) return ""
  const files = unmerged(listed.text())
  if (files.length === 0) return ""

  const dir = yield* input.git.run(["rev-parse", "--absolute-git-dir"], { cwd: input.cwd })
  if (dir.exitCode !== 0) return ""
  const gitDir = dir.text().trim()
  if (!gitDir) return ""

  const operation = OPERATIONS.find((candidate) => exists(path.join(gitDir, candidate.marker)))
  if (!operation) return ""

  return notice({
    files,
    abort: operation.abort,
    label: operation.label,
    branch: operation.label === "merge" ? read(path.join(gitDir, "MERGE_MSG")) : undefined,
  })
})

/**
 * The two arms, in order. Returns the block to append, or "" for nothing to say.
 *
 * OUTCOME FIRST, because when it fires it is strictly more actionable: it names
 * the conflicted paths out of git's index and the exact abort verb for the
 * operation actually on disk, where the intent arm can only quote a flag back.
 * They are not mutually exclusive either — `-X ours|theirs` only settles content
 * conflicts, so `git merge -X theirs` can still land in a conflicted index over a
 * modify/delete, and there the live conflict is the thing worth reporting. The
 * intent arm therefore speaks only when the outcome arm has nothing, which is
 * exactly the blind spot it exists to cover.
 *
 * Still annotate-only: neither arm changes the exit code, the output git produced,
 * or whether the command ran.
 */
export const annotate = Effect.fn("BashTool.mergeConflictNotice")(function* (input: {
  git: Git.Interface
  cwd: string
  command: string
  output: string
}) {
  const conflicted = yield* outcome(input)
  if (conflicted) return conflicted

  const request = unilateral(input.command)
  return request ? unilateralNotice(request) : ""
})

function exists(target: string) {
  try {
    return existsSync(target)
  } catch {
    return false
  }
}

function read(target: string) {
  try {
    return incoming(readFileSync(target, "utf-8"))
  } catch {
    return undefined
  }
}
