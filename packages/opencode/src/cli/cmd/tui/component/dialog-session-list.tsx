import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo, createResource, createSignal, onMount } from "solid-js"
import { Locale } from "@/util"
import { useProject } from "@tui/context/project"
import { useKeybind } from "../context/keybind"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useLanguage } from "../context/language"
import { Flag } from "@/flag/flag"
import { isSystemSession } from "@/session/auto-dream"
import { classifySession } from "@/session/visibility"
import { DialogSessionRename } from "./dialog-session-rename"
import { Keybind } from "@/util"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { DialogWorkspaceCreate, openWorkspaceSession, restoreWorkspaceSession } from "./dialog-workspace-create"
import { Spinner } from "./spinner"
import { errorMessage } from "@/util/error"
import { DialogSessionDeleteFailed } from "./dialog-session-delete-failed"

type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const project = useProject()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()
  const { t } = useLanguage()
  const [toDelete, setToDelete] = createSignal<string>()
  const [search, setSearch] = createDebouncedSignal("", 150)

  const [searchResults, { refetch }] = createResource(search, async (query) => {
    if (!query) return undefined
    const result = await sdk.client.session.list({ search: query, limit: 30, roots: true })
    return result.data ?? []
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const sessions = createMemo(() => searchResults() ?? sync.data.session)

  function createWorkspace() {
    dialog.replace(() => (
      <DialogWorkspaceCreate
        onSelect={(workspaceID) =>
          openWorkspaceSession({
            dialog,
            route,
            sdk,
            sync,
            toast,
            workspaceID,
          })
        }
      />
    ))
  }

  function recover(session: NonNullable<ReturnType<typeof sessions>[number]>) {
    const workspace = project.workspace.get(session.workspaceID!)
    const list = () => dialog.replace(() => <DialogSessionList />)
    dialog.replace(() => (
      <DialogSessionDeleteFailed
        session={session.title}
        workspace={workspace?.name ?? session.workspaceID!}
        onDone={list}
        onDelete={async () => {
          const current = currentSessionID()
          const info = current ? sync.data.session.find((item) => item.id === current) : undefined
          const result = await sdk.client.experimental.workspace.remove({ id: session.workspaceID! })
          if (result.error) {
            toast.show({
              variant: "error",
              title: "Failed to delete workspace",
              message: errorMessage(result.error),
            })
            return false
          }
          await project.workspace.sync()
          await sync.session.refresh()
          if (search()) await refetch()
          if (info?.workspaceID === session.workspaceID) {
            route.navigate({ type: "home" })
          }
          return true
        }}
        onRestore={() => {
          dialog.replace(() => (
            <DialogWorkspaceCreate
              onSelect={(workspaceID) =>
                restoreWorkspaceSession({
                  dialog,
                  sdk,
                  sync,
                  project,
                  toast,
                  workspaceID,
                  sessionID: session.id,
                  done: list,
                })
              }
            />
          ))
          return false
        }}
      />
    ))
  }

  // A child session is listed only if the render prohibition would allow it to be
  // opened. The actor rows come from the sync store rather than a fetch on
  // purpose: a host is only ever IN that store because it was created during this
  // TUI's lifetime (bootstrap loads roots only, and sync.sync() loads children
  // with `visible: true`), and the same lifetime delivers its `actor.registered`
  // event — so the rows this reads are present for exactly the population that
  // can leak. `undefined` means "no rows", which classifySession renders.
  const listable = (x: { id: string; parentID?: string }) =>
    classifySession(x, sync.data.actor?.[x.id]).renderable

  const options = createMemo(() => {
    const today = new Date().toDateString()
    const current = currentSessionID()
    // Top-level sessions, plus the CURRENT session's children (e.g. Orchestrator
    // child sessions) so the user can discover and switch into them. Other
    // sessions' children stay hidden to keep the list focused.
    //
    // The child arm needs the visibility predicate on top of the parent test.
    // `sync.data.session` is NOT already filtered: sync.sync() merges children
    // fetched with `visible: true` (sync.tsx), but `session.updated` inserts
    // EVERY session it sees (sync.tsx, "session.updated" arm) — and a
    // checkpoint-writer host is created with its title already set
    // (`title: "checkpoint-writer: …"`, session/checkpoint.ts), so it arrives on
    // that path and lands in the store. Filtering only on `parentID === current`
    // therefore listed one `↳ checkpoint-writer: …` row per checkpoint.
    //
    // classifySession is the same predicate the route's render gate uses, so the
    // list cannot disagree with what opening the entry would do. It fails OPEN
    // (no actor rows ⇒ listed), which is what keeps orchestrator `session create`
    // children — including the `[topic:…]` ones — listed: they own a mode "peer"
    // row and are returned renderable outright.
    const isChildOfCurrent = (x: { parentID?: string }) => current !== undefined && x.parentID === current
    return sessions()
      .filter((x) => x.parentID === undefined || (isChildOfCurrent(x) && listable(x)))
      .toSorted((a, b) => {
        const updatedDay = new Date(b.time.updated).setHours(0, 0, 0, 0) - new Date(a.time.updated).setHours(0, 0, 0, 0)
        if (updatedDay !== 0) return updatedDay
        return b.time.created - a.time.created
      })
      .map((x) => {
        const workspace = x.workspaceID ? project.workspace.get(x.workspaceID) : undefined

        let workspaceStatus: WorkspaceStatus | null = null
        if (x.workspaceID) {
          workspaceStatus = project.workspace.status(x.workspaceID) || "error"
        }

        let footer = ""
        if (Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES) {
          if (x.workspaceID) {
            let desc = "unknown"
            if (workspace) {
              desc = `${workspace.type}: ${workspace.name}`
            }

            footer = (
              <>
                {desc}{" "}
                <span
                  style={{
                    fg: workspaceStatus === "connected" ? theme.success : theme.error,
                  }}
                >
                  ●
                </span>
              </>
            )
          }
        } else {
          footer = Locale.time(x.time.updated)
        }

        const date = new Date(x.time.updated)
        let category = date.toDateString()
        if (category === today) {
          category = "Today"
        }
        const isDeleting = toDelete() === x.id
        const status = sync.data.session_status?.[x.id]
        const isWorking = status?.type === "busy"
        return {
          title: isDeleting
            ? `Press ${keybind.print("session_delete")} again to confirm`
            : isChildOfCurrent(x)
              ? `↳ ${x.title}`
              : isSystemSession(x)
                ? `[${t("tui.session.badge.auto")}] ${x.title}`
                : x.title,
          bg: isDeleting ? theme.error : undefined,
          value: x.id,
          category,
          footer,
          gutter: isWorking ? <Spinner /> : undefined,
        }
      })
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Sessions"
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={setSearch}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (toDelete() === option.value) {
              const session = sessions().find((item) => item.id === option.value)
              const status = session?.workspaceID ? project.workspace.status(session.workspaceID) : undefined

              try {
                const result = await sdk.client.session.delete({
                  sessionID: option.value,
                })
                if (result.error) {
                  if (session?.workspaceID) {
                    recover(session)
                  } else {
                    toast.show({
                      variant: "error",
                      title: "Failed to delete session",
                      message: errorMessage(result.error),
                    })
                  }
                  setToDelete(undefined)
                  return
                }
              } catch (err) {
                if (session?.workspaceID) {
                  recover(session)
                } else {
                  toast.show({
                    variant: "error",
                    title: "Failed to delete session",
                    message: errorMessage(err),
                  })
                }
                setToDelete(undefined)
                return
              }
              if (status && status !== "connected") {
                await sync.session.refresh()
              }
              if (search()) await refetch()
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
        {
          keybind: keybind.all.session_rename?.[0],
          title: "rename",
          onTrigger: async (option) => {
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
        {
          keybind: Keybind.parse("ctrl+w")[0],
          title: "new workspace",
          side: "right",
          disabled: !Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES,
          onTrigger: () => {
            createWorkspace()
          },
        },
      ]}
    />
  )
}
