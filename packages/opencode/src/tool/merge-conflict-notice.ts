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

/** git subcommands that can leave a conflicted index. Matched loosely on the
 *  command string on purpose — see `hint`. */
const CAPABLE = /\bgit\b[^\n;&|]*?\b(merge|rebase|cherry-pick|revert|pull|am)\b/

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
 * Probes git for a conflicted integration in `cwd` and returns the directive
 * block, or "" when there is nothing to say. Never throws and never fails:
 * `Git.run` already maps a spawn error to `exitCode: 1`, and every filesystem
 * read here is guarded, so an annotation can only ever be ADDED to a result —
 * it cannot break the command that produced it.
 */
export const annotate = Effect.fn("BashTool.mergeConflictNotice")(function* (input: {
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
