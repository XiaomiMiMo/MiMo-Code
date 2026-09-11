import { Component, Show } from "solid-js"
import { DockTray } from "@mimo-ai/ui/dock-surface"
import { Select } from "@mimo-ai/ui/select"
import { Button } from "@mimo-ai/ui/button"
import { Icon } from "@mimo-ai/ui/icon"
import { ProviderIcon } from "@mimo-ai/ui/provider-icon"
import { TooltipKeybind } from "@mimo-ai/ui/tooltip"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"

interface PromptInputTrayProps {
  mode: "normal" | "shell"
  agentsLoading: boolean
  providersLoading: boolean
  paidProvidersCount: number
  agentNames: string[]
  currentAgentName: string
  currentModelName?: string
  currentProviderId?: string
  variants: string[]
  currentVariant?: string
  shellStyle: any
  controlStyle: any
  onAgentSelect: (name: string) => void
  onModelUnpaidClick: () => void
  onVariantSelect: (variant: string) => void
  onRestoreFocus: () => void
  modelContext: any
}

export const PromptInputTray: Component<PromptInputTrayProps> = (props) => {
  const language = useLanguage()
  const command = useCommand()

  return (
    <Show when={props.mode === "normal" || props.mode === "shell"}>
      <DockTray attach="top">
        <div class="px-1.75 pt-5.5 pb-2 flex items-center gap-2 min-w-0">
          <div class="flex items-center gap-1.5 min-w-0 flex-1 relative">
            <div
              class="h-7 flex items-center gap-1.5 max-w-[160px] min-w-0 absolute inset-y-0 left-0"
              style={{
                padding: "0 4px 0 8px",
                ...props.shellStyle,
              }}
            >
              <span class="truncate text-13-medium text-text-strong">{language.t("prompt.mode.shell")}</span>
              <div class="size-4 shrink-0" />
            </div>
            <div class="flex items-center gap-1.5 min-w-0 flex-1 h-7">
              <Show when={!props.agentsLoading}>
                <div data-component="prompt-agent-control" style={{ animation: "fade-in 0.3s" }}>
                  <TooltipKeybind
                    placement="top"
                    gutter={4}
                    title={language.t("command.agent.cycle")}
                    keybind={command.keybind("agent.cycle")}
                  >
                    <Select
                      size="normal"
                      options={props.agentNames}
                      current={props.currentAgentName}
                      onSelect={(value) => {
                        if (value) props.onAgentSelect(value)
                        props.onRestoreFocus()
                      }}
                      class="capitalize max-w-[160px] text-text-base"
                      valueClass="truncate text-13-regular text-text-base"
                      triggerStyle={props.controlStyle}
                      triggerProps={{ "data-action": "prompt-agent" }}
                      variant="ghost"
                    />
                  </TooltipKeybind>
                </div>
              </Show>
              <Show when={!props.providersLoading}>
                <Show when={props.mode !== "shell"}>
                  <div data-component="prompt-model-control" style={{ animation: "fade-in 0.3s" }}>
                    <Show
                      when={props.paidProvidersCount > 0}
                      fallback={
                        <TooltipKeybind
                          placement="top"
                          gutter={4}
                          title={language.t("command.model.choose")}
                          keybind={command.keybind("model.choose")}
                        >
                          <Button
                            data-action="prompt-model"
                            as="div"
                            variant="ghost"
                            size="normal"
                            class="min-w-0 max-w-[320px] text-13-regular text-text-base group"
                            style={props.controlStyle}
                            onClick={props.onModelUnpaidClick}
                          >
                            <Show when={props.currentProviderId}>
                              <ProviderIcon
                                id={props.currentProviderId ?? ""}
                                class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                                style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                              />
                            </Show>
                            <span class="truncate">
                              {props.currentModelName ?? language.t("dialog.model.select.title")}
                            </span>
                            <Icon name="chevron-down" size="small" class="shrink-0" />
                          </Button>
                        </TooltipKeybind>
                      }
                    >
                      <TooltipKeybind
                        placement="top"
                        gutter={4}
                        title={language.t("command.model.choose")}
                        keybind={command.keybind("model.choose")}
                      >
                        <ModelSelectorPopover
                          model={props.modelContext}
                          triggerAs={Button}
                          triggerProps={{
                            variant: "ghost",
                            size: "normal",
                            style: props.controlStyle,
                            class: "min-w-0 max-w-[320px] text-13-regular text-text-base group",
                            "data-action": "prompt-model",
                          }}
                          onClose={props.onRestoreFocus}
                        >
                          <Show when={props.currentProviderId}>
                            <ProviderIcon
                              id={props.currentProviderId ?? ""}
                              class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                              style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                            />
                          </Show>
                          <span class="truncate">
                            {props.currentModelName ?? language.t("dialog.model.select.title")}
                          </span>
                          <Icon name="chevron-down" size="small" class="shrink-0" />
                        </ModelSelectorPopover>
                      </TooltipKeybind>
                    </Show>
                  </div>
                  <div data-component="prompt-variant-control" style={{ animation: "fade-in 0.3s" }}>
                    <TooltipKeybind
                      placement="top"
                      gutter={4}
                      title={language.t("command.model.variant.cycle")}
                      keybind={command.keybind("model.variant.cycle")}
                    >
                      <Select
                        size="normal"
                        options={props.variants}
                        current={props.currentVariant ?? "default"}
                        label={(x) => (x === "default" ? language.t("common.default") : x)}
                        onSelect={(value) => {
                          if (value) props.onVariantSelect(value)
                          props.onRestoreFocus()
                        }}
                        class="capitalize max-w-[160px] text-text-base"
                        valueClass="truncate text-13-regular text-text-base"
                        triggerStyle={props.controlStyle}
                        triggerProps={{ "data-action": "prompt-model-variant" }}
                        variant="ghost"
                      />
                    </TooltipKeybind>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </DockTray>
    </Show>
  )
}
