import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { createMemo } from "solid-js"
import { Log } from "@/util"
import { Global } from "@/global"
import { useLanguage } from "@tui/context/language"

const id = "internal:sidebar-logpath"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const t = useLanguage().t
  const logPath = createMemo(() => {
    const file = Log.file()
    if (!file) return ""
    return file.replace(Global.Path.home, "~")
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>{t("tui.sidebar.logpath")}</b>
      </text>
      <text fg={theme().textMuted}>{logPath()}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 130,
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
