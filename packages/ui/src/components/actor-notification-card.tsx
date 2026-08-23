import { createMemo, Show, type Component } from "solid-js"
import { Card, CardTitle, CardDescription } from "./card"
import {
  parseNotification,
  notificationStatusLabel,
  notificationStatusIcon,
  type ActorNotification,
  type InboxMessage,
} from "./actor-notification"

export interface ActorNotificationCardProps {
  text: string
}

/**
 * Render a synthetic text part as a notification card if it contains
 * <actor-notification> or <inbox> tags. Returns null for non-notification text.
 */
export const ActorNotificationCard: Component<ActorNotificationCardProps> = (props) => {
  const parsed = createMemo(() => parseNotification(props.text))

  return (
    <Show when={parsed()} fallback={null}>
      {(notification) => (
        <Show
          when={notification().type === "actor-notification"}
          fallback={<InboxCard message={notification() as InboxMessage} />}
        >
          <ActorCard notification={notification() as ActorNotification} />
        </Show>
      )}
    </Show>
  )
}

const ActorCard: Component<{ notification: ActorNotification }> = (props) => {
  const variant = createMemo(() => {
    switch (props.notification.status) {
      case "completed":
        return "success" as const
      case "failed":
        return "error" as const
      case "cancelled":
        return "warning" as const
      case "stalled":
        return "warning" as const
      case "ended":
        return "info" as const
      default:
        return "info" as const
    }
  })

  const icon = createMemo(() => notificationStatusIcon(props.notification.status))
  const label = createMemo(() => notificationStatusLabel(props.notification.status))

  return (
    <Card variant={variant()}>
      <CardTitle variant={variant()} icon={icon()}>
        <span data-slot="actor-notification-status">{label()}</span>
        <span data-slot="actor-notification-description">
          {props.notification.description}
        </span>
      </CardTitle>
      <Show when={props.notification.summary}>
        <CardDescription>{props.notification.summary}</CardDescription>
      </Show>
    </Card>
  )
}

const InboxCard: Component<{ message: InboxMessage }> = (props) => {
  const sender = createMemo(() => {
    // Extract short sender name from session:actor format
    const parts = props.message.from.split(":")
    const actor = parts[1] ?? parts[0]
    return actor === "main" ? "agent" : actor
  })

  const time = createMemo(() => {
    try {
      const date = new Date(props.message.sentAt)
      if (Number.isNaN(date.getTime())) return undefined
      return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    } catch {
      return undefined
    }
  })

  return (
    <Card variant="info">
      <CardTitle variant="info" icon="speech-bubble">
        <span data-slot="inbox-sender">{sender()}</span>
        <Show when={time()}>
          <span data-slot="inbox-time">{time()}</span>
        </Show>
      </CardTitle>
      <CardDescription>{props.message.content}</CardDescription>
    </Card>
  )
}
