import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { createMemo } from "solid-js"
import { Global } from "@/global"
import { useLanguage } from "@tui/context/language"

const id = "internal:sidebar-cwd"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const t = useLanguage().t
  const cwd = createMemo(() => props.api.state.session.cwd(props.session_id))
  const projectDir = createMemo(() => props.api.state.path.directory)
  const display = createMemo(() => {
    const dir = cwd() || projectDir()
    if (!dir) return ""
    return dir.replace(Global.Path.home, "~")
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>{t("tui.sidebar.cwd")}</b>
      </text>
      <text fg={theme().textMuted}>{display()}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 125,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
