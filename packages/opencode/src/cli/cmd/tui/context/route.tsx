import { createStore, reconcile } from "solid-js/store"
import { createMemo, type Accessor } from "solid-js"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  agentID?: string
  /** When set, the session view renders the full-screen workflow detail page for
   * this run (replacing the message stream), mirroring how agentID renders a
   * subagent's conversation. Cleared to return to the main conversation. */
  workflowRunID?: string
  /** When an agent (agentID) was opened FROM a workflow page, this records that
   * origin run so "back" returns to the workflow rather than the main conversation. */
  fromWorkflowRunID?: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

/**
 * TUI grid mode (multi-session workspace). When active, the route resolves to
 * `GridView` which renders multiple session cells arranged by a layout store.
 * `cells` seeds the grid with existing sessions; `activeSessionID` is the cell
 * that owns keyboard focus. Both are optional — the grid component restores
 * the persisted layout from `~/.mimocode/grid-layout.json` on mount when
 * neither is supplied.
 */
export type GridRoute = {
  type: "grid"
  cells?: { sessionID: string; workspaceID?: string }[]
  activeSessionID?: string
}

export type Route = HomeRoute | SessionRoute | PluginRoute | GridRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const [store, setStore] = createStore<Route>(
      props.initialRoute ??
        (process.env["MIMOCODE_ROUTE"]
          ? JSON.parse(process.env["MIMOCODE_ROUTE"])
          : {
              type: "home",
            }),
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(route))
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}

export function useCurrentAgentID(): Accessor<string> {
  const route = useRoute()
  return createMemo(() =>
    route.data.type === "session" ? (route.data.agentID ?? "main") : "main",
  )
}
