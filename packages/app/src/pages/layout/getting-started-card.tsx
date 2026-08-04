import { Component } from "solid-js"
import { Button } from "@mimo-ai/ui/button"
import { useLanguage } from "@/context/language"

interface GettingStartedCardProps {
  dismissed: boolean
  hasProviders: boolean
  hasPaidProviders: boolean
  onConnectProvider: () => void
  onDismiss: () => void
}

export const GettingStartedCard: Component<GettingStartedCardProps> = (props) => {
  const language = useLanguage()

  return (
    <div
      class="shrink-0 px-3 py-3"
      classList={{
        hidden: props.dismissed || !(props.hasProviders && !props.hasPaidProviders),
      }}
    >
      <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
        <div class="p-3 flex flex-col gap-6">
          <div class="flex flex-col gap-2">
            <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
            <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
              {language.t("sidebar.gettingStarted.line1")}
            </div>
            <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
              {language.t("sidebar.gettingStarted.line2")}
            </div>
          </div>
          <div data-component="getting-started-actions">
            <Button size="large" icon="plus-small" onClick={props.onConnectProvider}>
              {language.t("command.provider.connect")}
            </Button>
            <Button size="large" variant="ghost" onClick={props.onDismiss}>
              {language.t("toast.update.action.notYet")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
