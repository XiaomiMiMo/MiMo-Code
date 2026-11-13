import { createMemo, createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useArgs } from "@tui/context/args"
import { useLocal } from "@tui/context/local"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type { PromptInfo } from "@tui/component/prompt/history"
import type { snapshot } from "@/superagent/view"
import type { Ticket } from "@/superagent/schema"

export type TaskContext = {
  directory: string
  ticketId?: string
  role: "router" | "worker" | "helper"
  rootSessionId?: string
  rootActorId?: string
}
export function attachments(prompt: PromptInfo) {
  return prompt.parts.flatMap((p) => (p.type === "file" ? [{ url: p.url, mime: p.mime, filename: p.filename }] : []))
}
export const phaseLabel = (t: Ticket, zh: boolean) =>
  ({
    queued: zh ? "排队中" : "Queued",
    working: zh ? "执行中" : "Working",
    waiting: zh ? "等待跟进" : "Waiting",
    awaiting_review: zh ? "待评审" : "Review",
    blocked: zh ? "需要处理" : "Needs attention",
    completed: zh ? "已交付" : "Delivered",
    cancelled: zh ? "已停止" : "Stopped",
  })[t.phase]
const initialRequests = new WeakSet<object>()
export function Superagent() {
  const sdk = useSDK(),
    route = useRoute(),
    language = useLanguage(),
    args = useArgs(),
    dimensions = useTerminalDimensions()
  const local = useLocal()
  const { theme } = useTheme()
  const zh = () => language.effective().startsWith("zh")
  const l = (cn: string, en: string) => (zh() ? cn : en)
  const [data, setData] = createSignal<Awaited<ReturnType<typeof snapshot>>>()
  const [selected, setSelected] = createSignal<string>()
  const [filter, setFilter] = createSignal("all")
  const [query, setQuery] = createSignal("")
  const [search, setSearch] = createSignal(false)
  const [error, setError] = createSignal("")
  let prompt: PromptRef | undefined
  let disposed = false,
    refreshing = false
  const directory = sdk.directory ?? process.cwd()
  const attention = (t: Ticket) => t.attention ?? data()?.requests.find((r) => r.ticketId === t.id)?.text
  const tickets = createMemo(() =>
    (data()?.tickets ?? [])
      .filter(
        (t) =>
          (filter() === "all" ||
            (filter() === "attention" && !!attention(t)) ||
            (filter() === "active" && ["queued", "working", "waiting", "awaiting_review"].includes(t.phase)) ||
            (filter() === "done" && ["completed", "cancelled"].includes(t.phase))) &&
          `${t.goal} ${t.id}`.toLowerCase().includes(query().toLowerCase()),
      )
      .sort((a, b) => Number(!!attention(b)) - Number(!!attention(a)) || b.updatedAt - a.updatedAt),
  )
  const current = createMemo(() => tickets().find((t) => t.id === selected()) ?? tickets()[0])
  const agents = () => data()?.agents.filter((a) => a.ticketId === current()?.id) ?? []
  const todos = () => data()?.todos.filter((t) => t.session_id === current()?.workerSessionId) ?? []
  const todoRows = createMemo(() => {
    const rows: { todo: ReturnType<typeof todos>[number]; depth: number }[] = [],
      seen = new Set<string>()
    const visit = (parent: string | null, depth: number) => {
      for (const todo of todos()
        .filter((t) => t.parent_task_id === parent)
        .sort((a, b) => a.created_at - b.created_at)) {
        if (seen.has(todo.id)) continue
        seen.add(todo.id)
        rows.push({ todo, depth })
        visit(todo.id, depth + 1)
      }
    }
    visit(null, 0)
    for (const todo of todos()) if (!seen.has(todo.id)) rows.push({ todo, depth: 0 })
    return rows
  })
  const tokens = () =>
    agents()
      .reduce((n, a) => n + a.inputTokens + a.outputTokens, 0)
      .toLocaleString()
  const open = (sessionId: string, actorId: string, role: TaskContext["role"], ticket?: Ticket) => {
    route.navigate({
      type: "session",
      sessionID: sessionId,
      agentID: actorId === "main" ? undefined : actorId,
      task: {
        directory,
        ticketId: ticket?.id,
        role,
        rootSessionId: ticket?.workerSessionId ?? sessionId,
        rootActorId: ticket?.workerActorId ?? "main",
      },
    })
  }
  const openWorker = () => {
    const t = current()
    const request = data()?.requests.find((r) => r.ticketId === t?.id)
    if (request)
      open(
        request.sessionId,
        request.actorId,
        request.sessionId === t?.workerSessionId && request.actorId === t?.workerActorId ? "worker" : "helper",
        t,
      )
    else if (t?.workerSessionId) open(t.workerSessionId, t.workerActorId ?? "main", "worker", t)
  }
  const refresh = async () => {
    if (refreshing) return
    refreshing = true
    try {
      const result = await sdk.client.superagent.overview({ directory }, { throwOnError: true })
      if (!disposed) {
        setData(result.data as Awaited<ReturnType<typeof snapshot>>)
        setError("")
      }
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : String(e))
    } finally {
      refreshing = false
    }
  }
  const send = async (value: PromptInfo) => {
    await sdk.client.superagent.masterInput(
      { directory, text: value.input, attachments: attachments(value), model: local.model.current() },
      { throwOnError: true, headers: { "Idempotency-Key": crypto.randomUUID() } },
    )
    await refresh()
    const id = data()?.routerSessionId
    // Let the native Prompt finish clearing submitted text before navigation unmounts it.
    if (id)
      setTimeout(() => {
        if (!disposed) open(id, "main", "router")
      }, 0)
    return true
  }
  const act = async (action: "cancel" | "resume") => {
    const t = current()
    if (!t) return
    try {
      await sdk.client.superagent.act(
        { directory, ticketId: t.id, action },
        { throwOnError: true, headers: { "Idempotency-Key": crypto.randomUUID() } },
      )
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }
  onMount(() => {
    void refresh().then(async () => {
      if (args.prompt && !initialRequests.has(args)) {
        initialRequests.add(args)
        await send({ input: args.prompt, parts: [], mode: "normal" })
      }
    })
    const timer = setInterval(() => void refresh(), 1000)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })
  useKeyboard((event) => {
    if (search()) {
      if (event.name === "escape" || event.name === "return") setSearch(false)
      return
    }
    if (prompt?.focused) return
    if (event.name === "n") {
      prompt?.focus()
      return
    }
    if (event.name === "/") {
      setSearch(true)
      return
    }
    if (event.name === "m" && data()) open(data()!.routerSessionId, "main", "router")
    if (event.name === "return") openWorker()
    if (["j", "k", "up", "down"].includes(event.name)) {
      const i = tickets().findIndex((t) => t.id === current()?.id)
      setSelected(
        tickets()[Math.max(0, Math.min(tickets().length - 1, i + (["j", "down"].includes(event.name) ? 1 : -1)))]?.id,
      )
    }
    if (event.name === "escape") route.navigate({ type: "home" })
  })
  const color = (t: Ticket) =>
    attention(t)
      ? theme.warning
      : t.phase === "completed"
        ? theme.success
        : t.phase === "working"
          ? theme.primary
          : theme.textMuted
  return (
    <box flexDirection="column" height="100%" padding={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          {l("MiMo · 任务中心", "MiMo · Tasks")}
        </text>
        <text fg={theme.textMuted}>
          {l("后台服务", "Background service")} · PID {data()?.service.pid ?? "…"} · {directory}
        </text>
      </box>
      <text fg={theme.textMuted}>
        {l(
          "写下需求 → Router 接单 → Worker 持续执行 → 交付并跟进。关闭界面后任务继续。",
          "Describe a request → Router routes → Worker executes → deliver and follow up. Work continues after closing this UI.",
        )}
      </text>
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
      <box flexDirection="row" gap={2}>
        <For
          each={[
            ["all", l("全部", "All")],
            ["active", l("进行中", "Active")],
            ["attention", l("需要处理", "Attention")],
            ["done", l("已结束", "Ended")],
          ]}
        >
          {([value, name]) => (
            <text
              bg={filter() === value ? theme.primary : theme.backgroundElement}
              fg={filter() === value ? theme.background : theme.text}
              onMouseUp={() => {
                setFilter(value)
                prompt?.blur()
              }}
            >
              {" "}
              {name}{" "}
            </text>
          )}
        </For>
        <text fg={theme.accent} onMouseUp={() => data() && open(data()!.routerSessionId, "main", "router")}>
          {l("与 Router 对话 M", "Talk to Router M")}
        </text>
      </box>
      <Show when={search()}>
        <input focused value={query()} onInput={setQuery} placeholder={l("搜索任务", "Search tasks")} />
      </Show>
      <box flexDirection={dimensions().width < 95 ? "column" : "row"} flexGrow={1} gap={2}>
        <scrollbox width={dimensions().width < 95 ? "100%" : 34} height={dimensions().width < 95 ? 9 : undefined}>
          <Show
            when={tickets().length}
            fallback={
              <text fg={theme.textMuted}>
                {l("还没有任务。在下方描述你的需求。", "No tasks yet. Describe a request below.")}
              </text>
            }
          >
            <For each={tickets()}>
              {(t) => (
                <box
                  padding={1}
                  marginBottom={1}
                  backgroundColor={current()?.id === t.id ? theme.backgroundElement : undefined}
                  onMouseUp={() => {
                    setSelected(t.id)
                    prompt?.blur()
                  }}
                >
                  <text fg={color(t)}>
                    {phaseLabel(t, zh())}
                    {t.version !== 2 ? l(" · 历史记录", " · Legacy") : ""}
                  </text>
                  <text fg={theme.text} wrapMode="word">
                    {t.goal}
                  </text>
                  <Show when={attention(t)}>
                    <text fg={theme.warning} wrapMode="word">
                      {attention(t)}
                    </text>
                  </Show>
                </box>
              )}
            </For>
          </Show>
        </scrollbox>
        <scrollbox flexGrow={1}>
          <Show when={current()}>
            {(t) => (
              <box flexDirection="column" gap={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
                  {t().goal}
                </text>
                <text fg={color(t())}>
                  {phaseLabel(t(), zh())} · {agents().length} Agent · {tokens()} Token
                </text>
                <Show when={attention(t())}>
                  <box backgroundColor={theme.backgroundElement} padding={1}>
                    <text fg={theme.warning} wrapMode="word">
                      {l("需要你处理：", "Your action: ")}
                      {attention(t())}
                    </text>
                    <text fg={theme.accent} onMouseUp={openWorker}>
                      {l("进入原 Worker 对话，直接回答 →", "Open original Worker and answer →")}
                    </text>
                  </box>
                </Show>
                <box flexDirection="row" gap={2}>
                  <Show
                    when={t().workerSessionId}
                    fallback={
                      <text fg={theme.textMuted}>
                        {l(
                          "等待执行容量，分配后可进入对话。",
                          "Waiting for execution capacity; conversation opens after assignment.",
                        )}
                      </text>
                    }
                  >
                    <text bg={theme.primary} fg={theme.background} onMouseUp={openWorker}>
                      {" "}
                      {l("进入 Worker 对话 ↵", "Open Worker ↵")}{" "}
                    </text>
                  </Show>
                  <text fg={theme.accent} onMouseUp={() => void act("resume")}>
                    {l("继续任务", "Continue")}
                  </text>
                  <Show when={!["cancelled", "completed"].includes(t().phase)}>
                    <text fg={theme.warning} onMouseUp={() => void act("cancel")}>
                      {l("停止任务", "Stop")}
                    </text>
                  </Show>
                </box>
                <Show when={t().summary}>
                  <text fg={theme.text} wrapMode="word">
                    {t().summary}
                  </text>
                </Show>
                <Show when={t().worktree}>
                  <text fg={theme.textMuted} wrapMode="word">
                    {l("工作目录：", "Workspace: ")}
                    {t().worktree}
                  </text>
                </Show>
                <text fg={theme.textMuted}>{l("Todo · 来自原生任务记录", "Todo · native task records")}</text>
                <For each={todoRows()}>
                  {({ todo, depth }) => (
                    <text fg={todo.status === "done" ? theme.success : theme.text} wrapMode="word">
                      {"  ".repeat(depth)}
                      {depth ? "└─ " : ""}
                      {todo.status === "done"
                        ? "✓"
                        : todo.status === "in_progress"
                          ? "▶"
                          : todo.status === "blocked"
                            ? "!"
                            : "○"}{" "}
                      {todo.id} {todo.summary} · {todo.owner ?? l("未分配", "Unassigned")}
                    </text>
                  )}
                </For>
                <Show when={!todos().length}>
                  <text fg={theme.textMuted}>
                    {l(
                      "Worker 尚未发布 Todo；简单任务可以直接完成。",
                      "No Todo published; localized work may finish directly.",
                    )}
                  </text>
                </Show>
                <text fg={theme.textMuted}>
                  {l("参与此任务的 Agent · 点击查看原生会话", "Task Agents · open native conversation")}
                </text>
                <For each={agents()}>
                  {(a) => (
                    <text
                      fg={a.status === "running" ? theme.primary : theme.textMuted}
                      wrapMode="word"
                      onMouseUp={() => open(a.sessionId, a.actorId, a.role === "worker" ? "worker" : "helper", t())}
                    >
                      {a.role === "worker" ? "◆ Worker" : "◇ Helper"} {a.name} ·{" "}
                      {a.status === "running"
                        ? l("执行中", "Running")
                        : a.status === "pending"
                          ? l("待执行", "Pending")
                          : l("空闲", "Idle")}{" "}
                      · {l("输入", "Input")} {a.inputTokens.toLocaleString()} / {l("输出", "Output")}{" "}
                      {a.outputTokens.toLocaleString()} / {l("缓存", "Cache")} {a.cacheTokens.toLocaleString()}
                    </text>
                  )}
                </For>
                <Show when={t().artifacts.length}>
                  <text fg={theme.textMuted}>{l("交付产物", "Deliverables")}</text>
                  <For each={t().artifacts}>
                    {(artifact) => (
                      <text fg={theme.accent} wrapMode="word">
                        {artifact}
                      </text>
                    )}
                  </For>
                </Show>
              </box>
            )}
          </Show>
          <For each={data()?.deliveries.filter((d) => !d.ticketId || d.ticketId === current()?.id) ?? []}>
            {(d) => (
              <box padding={1}>
                <text fg={theme.error} wrapMode="word">
                  {l("投递失败：", "Delivery failed: ")}
                  {d.error}
                </text>
                <text
                  fg={theme.accent}
                  onMouseUp={() =>
                    void sdk.client.superagent
                      .retryDelivery({ directory, actionId: d.id }, { throwOnError: true })
                      .then(refresh)
                      .catch((e) => setError(String(e)))
                  }
                >
                  {l("核对原线程后重试", "Retry after checking original thread")}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
      </box>
      <Prompt
        ref={(value) => {
          prompt = value
        }}
        onSend={send}
        recipient={{
          agent: "Router",
          model: local.model.current()?.modelID ?? l("工作区默认模型", "Workspace model"),
          hint: l("描述新需求；已有任务请进入对应 Worker", "Describe new work; follow up inside its Worker"),
        }}
        placeholders={{ normal: [l("一句话描述你想完成什么…", "Describe what you want done…")], shell: [] }}
      />
      <text fg={theme.textMuted}>
        {l(
          "点击选择任务 · ↵ 打开对话 · N 新需求 · M Router · / 搜索",
          "Click task · ↵ open · N request · M Router · / search",
        )}
      </text>
    </box>
  )
}
