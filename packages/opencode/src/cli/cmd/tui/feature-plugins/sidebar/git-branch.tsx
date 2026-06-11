import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { useLanguage } from "@tui/context/language"

const id = "internal:sidebar-git-branch"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const t = useLanguage().t
  const branch = createMemo(() => props.api.state.vcs?.branch)

  return (
    <Show when={branch()}>
      <box>
        <text fg={theme().text}>
          <b>{t("tui.sidebar.branch")}</b>
        </text>
        <text fg={theme().textMuted}>{branch()}</text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 130,
    slots: {
      sidebar_content(_ctx, _props) {
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
