import { Show, type Component } from "solid-js"
import { Card, CardTitle, CardDescription } from "./card"
import {
  notificationStatusIcon,
  type ParsedNotification,
  type ActorNotification,
  type InboxMessage,
} from "./actor-notification"

export interface ActorNotificationCardProps {
  parsed: ParsedNotification
}

/**
 * Render a pre-parsed notification as a card.
 */
export const ActorNotificationCard: Component<ActorNotificationCardProps> = (props) => {
  const parsed = props.parsed
  if (parsed.type === "actor-notification") {
    return <ActorCard notification={parsed} />
  }
  return <InboxCard message={parsed} />
}

const ActorCard: Component<{ notification: ActorNotification }> = (props) => {
  const variant = () => {
    switch (props.notification.status) {
      case "completed": return "success" as const
      case "failed": return "error" as const
      case "cancelled": return "warning" as const
      case "stalled": return "warning" as const
      case "ended": return "info" as const
    }
  }

  const icon = () => notificationStatusIcon(props.notification.status)

  return (
    <Card variant={variant()}>
      <CardTitle variant={variant()} icon={icon()}>
        <span data-slot="actor-notification-status">{props.notification.status}</span>
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
  const sender = () => {
    // Extract short sender name from session:actor format
    const parts = props.message.from.split(":")
    const actor = parts[1] ?? parts[0]
    return actor === "main" ? "agent" : actor
  }

  const time = () => {
    const date = new Date(props.message.sentAt)
    if (Number.isNaN(date.getTime())) return undefined
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  }

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
