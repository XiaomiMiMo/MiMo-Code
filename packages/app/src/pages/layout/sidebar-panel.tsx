import { Component, Show, Accessor, For } from "solid-js"
import { Button } from "@mimo-ai/ui/button"
import { IconButton } from "@mimo-ai/ui/icon-button"
import { Tooltip } from "@mimo-ai/ui/tooltip"
import { DropdownMenu } from "@mimo-ai/ui/dropdown-menu"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import { useLanguage } from "@/context/language"
import { base64Encode } from "@mimo-ai/shared/util/encode"
import { LocalWorkspace, SortableWorkspace, WorkspaceDragOverlay, type WorkspaceSidebarContext } from "./sidebar-workspace"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"

interface SidebarPanelProps {
  project: () => any
  projectId: () => string
  projectName: () => string
  worktree: () => string
  homedir: () => string
  sidebarHovering: () => boolean
  canToggle: () => boolean
  workspacesEnabled: () => boolean
  unseenCount: () => number
  workspaces: () => string[]
  workspaceSidebarCtx: WorkspaceSidebarContext
  sidebarProject: () => any
  store: any
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
  panelProps: { mobile?: boolean }
  merged?: boolean
  sortNow: Accessor<number>
  InlineEditor: any
  renameProject: (project: any, name: string) => void
  showEditProjectDialog: (project: any) => void
  toggleProjectWorkspaces: (project: any) => void
  clearNotifications: () => void
  closeProject: (dir: string) => void
  chooseProject: () => void
  createWorkspace: (project: any) => void
  navigateWithSidebarReset: (url: string) => void
  handleWorkspaceDragStart: (e: any) => void
  handleWorkspaceDragEnd: (e: any) => void
  handleWorkspaceDragOver: (e: any) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined) => void
}

export const SidebarPanel: Component<SidebarPanelProps> = (props) => {
  const language = useLanguage()

  return (
    <div class="size-full flex flex-col min-w-0">
      <Show
        when={props.project()}
        fallback={
          <Show when={props.worktree()}>
            <div class="flex-1 flex items-center justify-center p-4">
              <div class="flex flex-col items-center gap-3 text-center">
                <div class="text-14-medium text-text-strong">{language.t("sidebar.project.notFound")}</div>
                <Button size="large" icon="folder-add-left" onClick={props.chooseProject}>
                  {language.t("command.project.open")}
                </Button>
              </div>
            </div>
          </Show>
        }
      >
        <div class="shrink-0 pl-1 py-1">
          <div class="group/project flex items-start justify-between gap-2 py-2 pl-2 pr-0">
            <div class="flex flex-col min-w-0">
              <props.InlineEditor
                id={`project:${props.projectId()}`}
                value={props.projectName}
                onSave={(next: string) => {
                  const item = props.project()
                  if (!item) return
                  props.renameProject(item, next)
                }}
                class="text-14-medium text-text-strong truncate"
                displayClass="text-14-medium text-text-strong truncate"
                stopPropagation
              />

              <Tooltip
                placement="bottom"
                gutter={2}
                value={props.worktree()}
                class="shrink-0"
                contentStyle={{
                  "max-width": "640px",
                  transform: "translate3d(52px, 0, 0)",
                }}
              >
                <span class="text-12-regular text-text-base truncate select-text">
                  {props.worktree().replace(props.homedir(), "~")}
                </span>
              </Tooltip>
            </div>

            <DropdownMenu modal={!props.sidebarHovering()}>
              <DropdownMenu.Trigger
                as={IconButton}
                icon="dot-grid"
                variant="ghost"
                class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                classList={{
                  "opacity-100": props.panelProps.mobile || props.merged,
                  "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                    !props.panelProps.mobile && !props.merged,
                }}
                aria-label={language.t("common.moreOptions")}
              />
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="mt-1">
                  <DropdownMenu.Item
                    onSelect={() => {
                      const item = props.project()
                      if (!item) return
                      props.showEditProjectDialog(item)
                    }}
                  >
                    <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={!props.canToggle()}
                    onSelect={() => {
                      const item = props.project()
                      if (!item) return
                      props.toggleProjectWorkspaces(item)
                    }}
                  >
                    <DropdownMenu.ItemLabel>
                      {props.workspacesEnabled()
                        ? language.t("sidebar.workspaces.disable")
                        : language.t("sidebar.workspaces.enable")}
                    </DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item disabled={props.unseenCount() === 0} onSelect={props.clearNotifications}>
                    <DropdownMenu.ItemLabel>{language.t("sidebar.project.clearNotifications")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    onSelect={() => {
                      const dir = props.worktree()
                      if (!dir) return
                      props.closeProject(dir)
                    }}
                  >
                    <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          </div>
        </div>

        <div class="flex-1 min-h-0 flex flex-col">
          <Show
            when={props.workspacesEnabled()}
            fallback={
              <>
                <div class="shrink-0 py-4">
                  <Button
                    size="large"
                    icon="new-session"
                    class="w-full"
                    onClick={() => {
                      const dir = props.worktree()
                      if (!dir) return
                      props.navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
                    }}
                  >
                    {language.t("command.session.new")}
                  </Button>
                </div>
                <div class="flex-1 min-h-0">
                  <LocalWorkspace
                    ctx={props.workspaceSidebarCtx}
                    project={props.project()}
                    sortNow={props.sortNow}
                    mobile={props.panelProps.mobile}
                  />
                </div>
              </>
            }
          >
            <>
              <div class="shrink-0 py-4">
                <Button
                  size="large"
                  icon="plus-small"
                  class="w-full"
                  onClick={() => {
                    const item = props.project()
                    if (!item) return
                    props.createWorkspace(item)
                  }}
                >
                  {language.t("workspace.new")}
                </Button>
              </div>
              <div class="relative flex-1 min-h-0">
                <DragDropProvider
                  onDragStart={props.handleWorkspaceDragStart}
                  onDragEnd={props.handleWorkspaceDragEnd}
                  onDragOver={props.handleWorkspaceDragOver}
                  collisionDetector={closestCenter}
                >
                  <DragDropSensors />
                  <ConstrainDragXAxis />
                  <div
                    ref={(el) => {
                      if (!props.panelProps.mobile) props.setScrollContainerRef(el)
                    }}
                    class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]"
                  >
                    <SortableProvider ids={props.workspaces()}>
                      <For each={props.workspaces()}>
                        {(directory) => (
                          <SortableWorkspace
                            ctx={props.workspaceSidebarCtx}
                            directory={directory}
                            project={props.project()}
                            sortNow={props.sortNow}
                            mobile={props.panelProps.mobile}
                          />
                        )}
                      </For>
                    </SortableProvider>
                  </div>
                  <DragOverlay>
                    <WorkspaceDragOverlay
                      sidebarProject={props.sidebarProject}
                      activeWorkspace={() => props.store.activeWorkspace}
                      workspaceLabel={props.workspaceLabel}
                    />
                  </DragOverlay>
                </DragDropProvider>
              </div>
            </>
          </Show>
        </div>
      </Show>
    </div>
  )
}
