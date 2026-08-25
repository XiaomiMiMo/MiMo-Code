import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { Global } from "@/global"
import { useLanguage } from "@tui/context/language"

const id = "internal:sidebar-cwd"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const t = useLanguage().t
  const display = props.api.state.path.directory?.replace(Global.Path.home, "~") ?? ""

  return (
    <box>
      <text fg={theme().text}>
        <b>{t("tui.sidebar.cwd")}</b>
      </text>
      <text fg={theme().textMuted}>{display}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 125,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
