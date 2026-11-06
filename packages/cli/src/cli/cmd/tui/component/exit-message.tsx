import { createEffect, onCleanup } from "solid-js"
import { useRoute } from "@tui/context/route"
import { useExit } from "@tui/context/exit"
import { useLanguage } from "@tui/context/language"
import { UI } from "@/cli/ui"
import { Locale } from "@/util"

// The app owns one exit hint. A route being disposed must not leave a stale Session hint.
export function ExitMessage(props: { session: (id: string) => { id: string; title: string } | undefined }) {
  const route = useRoute(),
    exit = useExit(),
    language = useLanguage()
  createEffect(() => {
    const current = route.data
    const session = current.type === "session" ? props.session(current.sessionID) : undefined
    const zh = language.effective().startsWith("zh")
    const rows: [string, string][] =
      current.type === "superagent"
        ? [
            ["Workspace", "Super-agent"],
            [
              "Continue",
              zh
                ? "在相同项目重新启动 MiMo，输入 /super-agent"
                : "Restart MiMo in the same project, then enter /super-agent",
            ],
            [
              "Tasks",
              zh
                ? "查看原任务；暂停的任务按 R 后确认继续"
                : "Open the existing task; press R and confirm to resume paused work",
            ],
          ]
        : current.type === "session" && session?.id === current.sessionID
          ? [
              ["Session", Locale.truncate(session.title, 50)],
              ["Continue", `mimo -s ${session.id}`],
            ]
          : []
    const text = rows.length
      ? [
          UI.logo("  "),
          "",
          ...rows.map(
            ([label, value]) =>
              `  ${UI.Style.TEXT_DIM}${label.padEnd(10, " ")}${UI.Style.TEXT_NORMAL}${UI.Style.TEXT_NORMAL_BOLD}${value}${UI.Style.TEXT_NORMAL}`,
          ),
          "",
        ].join("\n")
      : undefined
    onCleanup(exit.message.set(text))
  })
  return null
}
