import { Flag } from "../flag/flag"
import { isSkillSearchDisabled } from "../skill/search"

export const SKILL_SEARCH_REMINDER_MARKER = "Skill search trigger:"

const SKILL_QUERY_GUIDANCE = [
  "Describe the required capability and final deliverable; treat file types such as CSV as inputs, not automatically as the target skill.",
  "Office examples:",
  "- Excel/CSV: analyze or clean data, work with formulas and tables, or create charts and workbooks.",
  "- PowerPoint/PPT: create, revise, or review a presentation or executive deck.",
  "- Word/DOCX: draft, edit, review, or format a document or report.",
  "- PDF: extract or review content, generate a PDF, or preserve and inspect page layout.",
  'Code examples: code review, debugging, test generation, security or performance analysis, frontend design, and other specialized engineering workflows.',
  'For example, "analyze gender_submission.csv" should express data analysis as the capability, the CSV dataset as input, and findings as output.',
  "These are examples of likely specialized workflows, not requirements to call a tool.",
]

type ReminderMessage = {
  info: { role: string; id: string; parentID?: string; time: { created: number } }
  parts: { type: string; text?: string; synthetic?: boolean }[]
}

export function skillSearchReminder(input: { currentUserAt: number; previousUserAt?: number }) {
  if (input.previousUserAt === undefined) {
    return [
      "<system-reminder>",
      "Skill search trigger: this is the first user query in the session.",
      "You should call skill_search before starting the task.",
      "First rewrite the request as a Skill Query containing action, input, output, and audience when available.",
      ...SKILL_QUERY_GUIDANCE,
      "</system-reminder>",
    ].join("\n")
  }
  if (input.currentUserAt - input.previousUserAt < Flag.MIMOCODE_SKILL_SEARCH_REFRESH_INTERVAL_MS) return
  return [
    "<system-reminder>",
    "Skill search trigger: at least 12 hours passed since the previous user query.",
    "By default: call skill_search before acting, unless the user explicitly references the current task or current artifact.",
    "When searching, rewrite the request as a Skill Query containing action, input, output, and audience when available.",
    ...SKILL_QUERY_GUIDANCE,
    "</system-reminder>",
  ].join("\n")
}

export function skillSearchReminderForMessages(messages: ReminderMessage[]) {
  const users = messages.filter(
    (message) => message.info.role === "user" && message.parts.some((part) => !part.synthetic),
  )
  const current = users.at(-1)
  if (!current) return
  if (
    current.parts.some(
      (part) => part.type === "text" && part.synthetic && part.text?.includes(SKILL_SEARCH_REMINDER_MARKER),
    )
  )
    return
  if (messages.some((message) => message.info.role === "assistant" && message.info.parentID === current.info.id)) return
  return skillSearchReminder({
    currentUserAt: current.info.time.created,
    previousUserAt: users.at(-2)?.info.time.created,
  })
}

export function skillSearchReminderForSession(input: {
  session: { parentID?: string }
  agent: { name: string; mode: "subagent" | "primary" | "all" }
  model: { id: string; name?: string; family?: string; api: { id: string } }
  messages: ReminderMessage[]
}) {
  if (
    !Flag.MIMOCODE_ENABLE_SKILL_SEARCH_REMINDER ||
    input.session.parentID ||
    input.agent.mode === "subagent" ||
    input.agent.name === "compose" ||
    isSkillSearchDisabled(input.model)
  )
    return
  return skillSearchReminderForMessages(input.messages)
}
