import type { Hooks, PluginInput } from "@mimo-ai/plugin"
import fs from "fs/promises"
import path from "path"
import { Log } from "../util"
import { progressPath } from "../session/checkpoint-paths"
import type { SessionID } from "../session/schema"

const log = Log.create({ service: "plugin.subagent-progress-checker" })

const REQUIRED_SECTIONS = [
  "## §1 Task identity",
  "## §2 Subagent intent",
  "## §3 Files and code sections",
  "## §4 Verbatim commands",
  "## §5 Outcome and discoveries",
] as const

const TEMPLATE = `## §1 Task identity
- task_id: <TID>
- short summary: <one line>

## §2 Subagent intent
What this subagent was asked to do (one paragraph).

## §3 Files and code sections
- path/to/file.ext: <what you did with it>

## §4 Verbatim commands
Exact commands you ran or commands the user/task asked to be runnable later. Keep BACKTICK-FENCED for grep-ability.
\`\`\`
<command>
\`\`\`

## §5 Outcome and discoveries
- Outcome (success/partial/failed): <reason>
- Discoveries that may matter for other tasks: <bullets>
`

function buildFeedback(args: {
  kind: "missing" | "incomplete"
  taskId: string
  filePath: string
  missing?: readonly string[]
}): string {
  if (args.kind === "missing") {
    return [
      "Before terminating, write the task progress journal to:",
      `  ${args.filePath}`,
      "",
      "Required structure (5 sections, headings exact):",
      "",
      TEMPLATE.replace("<TID>", args.taskId),
      "",
      "Write the file now using the Write tool, then terminate normally.",
    ].join("\n")
  }

  return [
    `tasks/${args.taskId}/progress.md exists but is missing required sections:`,
    ...(args.missing ?? []).map((s) => `  - ${s}`),
    "",
    "Add the missing sections. For reference, the full required template is:",
    "",
    TEMPLATE.replace("<TID>", args.taskId),
    "",
    "Re-write the file using Write tool, then terminate normally.",
  ].join("\n")
}

async function injectFrontmatter(filePath: string, body: string): Promise<void> {
  const now = Date.now()
  const frontmatterBlock = `---\nwritten-at: ${now}\n---\n`
  // Replace existing leading frontmatter if present (idempotent across ReAct retries)
  const fmMatch = body.match(/^---\n[\s\S]*?\n---\n/)
  const newBody = fmMatch
    ? frontmatterBlock + body.slice(fmMatch[0].length)
    : frontmatterBlock + body
  await Bun.write(filePath, newBody)
}

export async function SubagentProgressCheckerPlugin(_pluginInput: PluginInput): Promise<Hooks> {
  return {
    "actor.postStop": {
      // Use excludeOnly so the matcher fires for ALL actor types EXCEPT those
      // listed (including built-in subagents like general/explore/build/title).
      // The default matcher path (`!isBuiltIn`) would silently skip built-ins
      // — which are exactly the most common task-bound subagents this plugin
      // exists to validate. checkpoint-writer / title / summary / dream /
      // distill / compaction never have task_id semantics, so excluding them
      // is harmless even though task_id check below would already short-circuit.
      // See packages/opencode/src/plugin/matcher.ts.
      matcher: {
        agentType: {
          excludeOnly: [
            "checkpoint-writer",
            "title",
            "summary",
            "dream",
            "distill",
            "compaction",
            "main",
          ],
        },
      },
      run: async (input, output) => {
        const taskId = (input as { task_id?: string }).task_id
        if (!taskId) return // caller didn't bind to a task → no-op
        // Read-only agents (canWrite === false) cannot satisfy a "write the journal" nudge —
        // skip the check entirely so we don't burn postStop re-entries on an impossible ask.
        // `=== false` (not falsy): an absent canWrite must NOT suppress (fail-open).
        if ((input as { canWrite?: boolean }).canWrite === false) return

        const sessionID = input.sessionID as SessionID
        const filePath = progressPath(sessionID, taskId)

        let body: string | undefined
        try {
          body = await Bun.file(filePath).text()
        } catch {
          body = undefined
        }

        if (body === undefined) {
          output.continue = true
          output.reason = buildFeedback({ kind: "missing", taskId, filePath })
          return
        }

        const missing = REQUIRED_SECTIONS.filter((s) => !body!.includes(s))
        if (missing.length > 0) {
          output.continue = true
          output.reason = buildFeedback({ kind: "incomplete", taskId, filePath, missing })
          return
        }

        // PASS: inject frontmatter (runtime owns this, not the LLM)
        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await injectFrontmatter(filePath, body)
        } catch (err) {
          log.error("frontmatter injection failed", { err, filePath })
        }
        // do not set output.continue; subagent exits postStop loop cleanly
      },
    },
  }
}
