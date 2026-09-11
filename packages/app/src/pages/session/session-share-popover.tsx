import { Show, type Component } from "solid-js"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Button } from "@mimo-ai/ui/button"
import { TextField } from "@mimo-ai/ui/text-field"
import { useLanguage } from "@/context/language"

interface SessionSharePopoverProps {
  open: boolean
  anchorRef?: () => HTMLElement | undefined
  shareUrl: string | undefined
  sharePending: boolean
  unsharePending: boolean
  onOpenChange: (open: boolean) => void
  onShare: () => void
  onUnshare: () => void
  onViewShare: () => void
  trigger?: any
}

export const SessionSharePopover: Component<SessionSharePopoverProps> = (props) => {
  const language = useLanguage()

  return (
    <KobaltePopover open={props.open} anchorRef={props.anchorRef} onOpenChange={props.onOpenChange} gutter={6}>
      <KobaltePopover.Trigger as="div">{props.trigger}</KobaltePopover.Trigger>
      <KobaltePopover.Portal>
        <KobaltePopover.Content class="w-80 rounded-xl bg-background-overlay shadow-lg border border-border-weak-base z-50">
          <div class="flex flex-col p-3">
            <div class="flex flex-col gap-1">
              <div class="text-13-medium text-text-strong">
                {language.t("session.share.popover.title")}
              </div>
              <div class="text-12-regular text-text-weak">
                {props.shareUrl
                  ? language.t("session.share.popover.description.shared")
                  : language.t("session.share.popover.description.unshared")}
              </div>
            </div>
            <div class="mt-3 flex flex-col gap-2">
              <Show
                when={props.shareUrl}
                fallback={
                  <Button
                    size="large"
                    variant="primary"
                    class="w-full"
                    onClick={props.onShare}
                    disabled={props.sharePending}
                  >
                    {props.sharePending
                      ? language.t("session.share.action.publishing")
                      : language.t("session.share.action.publish")}
                  </Button>
                }
              >
                <div class="flex flex-col gap-2">
                  <TextField
                    value={props.shareUrl ?? ""}
                    readOnly
                    copyable
                    copyKind="link"
                    tabIndex={-1}
                    class="w-full"
                  />
                  <div class="grid grid-cols-2 gap-2">
                    <Button
                      size="large"
                      variant="secondary"
                      class="w-full shadow-none border border-border-weak-base"
                      onClick={props.onUnshare}
                      disabled={props.unsharePending}
                    >
                      {props.unsharePending
                        ? language.t("session.share.action.unpublishing")
                        : language.t("session.share.action.unpublish")}
                    </Button>
                    <Button
                      size="large"
                      variant="primary"
                      class="w-full"
                      onClick={props.onViewShare}
                      disabled={props.unsharePending}
                    >
                      {language.t("session.share.action.view")}
                    </Button>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  )
}
