import { createSignal, onMount, onCleanup, Show } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useKeyboard } from "@opentui/solid"
import { usePromptRef } from "@tui/context/prompt"
import type { PromptInfo } from "@tui/component/prompt/history"
import { attachments, phaseLabel, type TaskContext } from "./superagent"
import type { detail } from "@/superagent/dispatcher"
import type { Model } from "@/superagent/schema"
import type z from "zod"

export async function sendTask(
  sdk: ReturnType<typeof useSDK>,
  task: TaskContext,
  prompt: PromptInfo,
  model?: z.infer<typeof Model>,
) {
  const options = { throwOnError: true as const, headers: { "Idempotency-Key": crypto.randomUUID() } }
  if (task.role === "helper") return false
  if (task.ticketId)
    await sdk.client.superagent.input(
      {
        directory: task.directory,
        ticketId: task.ticketId,
        text: prompt.input,
        attachments: attachments(prompt),
        model,
      },
      options,
    )
  else
    await sdk.client.superagent.masterInput(
      { directory: task.directory, text: prompt.input, attachments: attachments(prompt), model },
      options,
    )
  return true
}
export function backTask(sdk: ReturnType<typeof useSDK>, route: ReturnType<typeof useRoute>, task: TaskContext) {
  if (task.role === "helper" && task.rootSessionId) {
    route.navigate({
      type: "session",
      sessionID: task.rootSessionId,
      agentID: task.rootActorId === "main" ? undefined : task.rootActorId,
      task: { ...task, role: task.ticketId ? "worker" : "router" },
    })
  } else {
    sdk.switchDirectory(task.directory)
    route.navigate({ type: "superagent" })
  }
}
export function TaskContextBar(props: { task: TaskContext }) {
  const sdk = useSDK(),
    route = useRoute(),
    language = useLanguage(),
    prompt = usePromptRef()
  const { theme } = useTheme()
  const [data, setData] = createSignal<ReturnType<typeof detail>>()
  const zh = () => language.effective().startsWith("zh")
  const back = () => backTask(sdk, route, props.task)
  onMount(() => {
    let stopped = false
    const update = async () => {
      if (!props.task.ticketId) return
      const result = await sdk.client.superagent.get({ directory: props.task.directory, ticketId: props.task.ticketId })
      if (!stopped && result.data) setData(result.data as ReturnType<typeof detail>)
    }
    void update().catch(() => {})
    const timer = setInterval(() => void update().catch(() => {}), 1000)
    onCleanup(() => {
      stopped = true
      clearInterval(timer)
    })
  })
  useKeyboard((event) => {
    if (event.name === "escape" && !prompt.current?.interceptsEscape) {
      event.preventDefault()
      back()
    }
  })
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={2}>
        <text fg={theme.accent} onMouseUp={back}>
          {props.task.role === "helper"
            ? zh()
              ? "← 返回 Worker Esc"
              : "← Worker Esc"
            : zh()
              ? "← 任务中心 Esc"
              : "← Tasks Esc"}
        </text>
        <text fg={theme.primary}>
          {props.task.role === "router"
            ? "Router"
            : props.task.role === "worker"
              ? "Worker"
              : zh()
                ? "子 Agent"
                : "Helper"}
        </text>
        <Show when={data()}>
          {(d) => (
            <text fg={d().ticket.attention ? theme.warning : theme.textMuted}>{phaseLabel(d().ticket, zh())}</text>
          )}
        </Show>
      </box>
      <Show when={data()}>
        {(d) => (
          <>
            <text fg={theme.text} wrapMode="word">
              {d().ticket.goal}
            </text>
            <Show when={d().ticket.attention}>
              <text fg={theme.warning} wrapMode="word">
                {d().ticket.attention}
              </text>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.task.role === "router"}>
        <text fg={theme.textMuted}>
          {zh()
            ? "描述需求或查询状态。Router 负责归属，具体工作由任务 Worker 处理。"
            : "Describe work or ask status. Router assigns ownership; task Workers execute."}
        </text>
      </Show>
    </box>
  )
}
