import { test, expect, mock, beforeEach } from "bun:test"
import { Effect, Fiber } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"

// --- Mock infrastructure ---

// Per-client state for controlling mock behavior
interface MockClientState {
  tools: Array<{ name: string; description?: string; inputSchema: object }>
  listToolsCalls: number
  listToolsShouldFail: boolean
  listToolsError: string
  listPromptsShouldFail: boolean
  listResourcesShouldFail: boolean
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  closed: boolean
  notificationHandlers: Map<unknown, (...args: any[]) => any>
  requestHandlers: Map<unknown, (...args: any[]) => any>
  serverCapabilities: Record<string, unknown>
  toolCalls: Array<Record<string, unknown>>
  toolCallSignals: Array<AbortSignal | undefined>
  toolCallHangs: boolean
  toolCallAbortCount: number
  notifications: Array<Record<string, unknown>>
  notificationCalls: number
  notificationInFlight: number
  notificationMaxInFlight: number
  notificationResolvers: Array<() => void>
  notificationError?: string
  notificationHangs?: boolean
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined
let connectShouldFail = false
let connectShouldHang = false
let connectError = "Mock transport cannot connect"
// Tracks how many Client instances were created (detects leaks)
let clientCreateCount = 0
const clientOptions: unknown[] = []
// Tracks how many times transport.close() is called across all mock transports
let transportCloseCount = 0

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
      listToolsCalls: 0,
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      listPromptsShouldFail: false,
      listResourcesShouldFail: false,
      prompts: [],
      resources: [],
      closed: false,
      notificationHandlers: new Map(),
      requestHandlers: new Map(),
      serverCapabilities: {},
      toolCalls: [],
      toolCallSignals: [],
      toolCallHangs: false,
      toolCallAbortCount: 0,
      notifications: [],
      notificationCalls: 0,
      notificationInFlight: 0,
      notificationMaxInFlight: 0,
      notificationResolvers: [],
    }
    clientStates.set(key, state)
  }
  return state
}

// Mock transport that succeeds or fails based on connectShouldFail / connectShouldHang
class MockStdioTransport {
  stderr: null = null
  pid = 12345
  // oxlint-disable-next-line no-useless-constructor
  constructor(_opts: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

class MockStreamableHTTP {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
  async finishAuth() {}
}

class MockSSE {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

// Mock Client that delegates to per-name MockClientState
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any

    constructor(_opts: any, options?: unknown) {
      clientCreateCount++
      clientOptions.push(options)
    }

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      // After successful connect, bind to the last-created client name
      this._state = getOrCreateClientState(lastCreatedClientName)
    }

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    // Production registers a `sampling/createMessage` request handler on every
    // client (see MCP.CLIENT_OPTIONS + McpSampling.serve), so the double has to
    // offer the same method or every connect path throws.
    setRequestHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.requestHandlers.set(schema, handler)
    }

    getServerCapabilities() {
      return this._state?.serverCapabilities
    }

    async callTool(
      params: Record<string, unknown>,
      _schema?: unknown,
      options?: { signal?: AbortSignal },
    ) {
      this._state?.toolCalls.push(params)
      this._state?.toolCallSignals.push(options?.signal)
      if (this._state?.toolCallHangs) {
        await new Promise<void>((_resolve, reject) => {
          const signal = options?.signal
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort)
            if (this._state) this._state.toolCallAbortCount++
            reject(signal?.reason instanceof Error ? signal.reason : new Error("tool call aborted"))
          }
          signal?.addEventListener("abort", onAbort, { once: true })
          if (signal?.aborted) onAbort()
          // Deliberately no resolver: this request must settle only through
          // the propagated cancellation signal.
        })
      }
      return { content: [{ type: "text", text: "ok" }] }
    }

    async notification(notification: Record<string, unknown>) {
      if (!this._state) return
      this._state.notificationCalls++
      this._state.notificationInFlight++
      this._state.notificationMaxInFlight = Math.max(
        this._state.notificationMaxInFlight,
        this._state.notificationInFlight,
      )
      try {
        if (this._state.notificationError) throw new Error(this._state.notificationError)
        if (this._state.notificationHangs) {
          await new Promise<void>((resolve) => this._state.notificationResolvers.push(resolve))
        }
        this._state.notifications.push(notification)
      } finally {
        this._state.notificationInFlight--
      }
    }

    async listTools() {
      if (this._state) this._state.listToolsCalls++
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      return { tools: this._state?.tools ?? [] }
    }

    async listPrompts() {
      if (this._state?.listPromptsShouldFail) {
        throw new Error("listPrompts failed")
      }
      return { prompts: this._state?.prompts ?? [] }
    }

    async listResources() {
      if (this._state?.listResourcesShouldFail) {
        throw new Error("listResources failed")
      }
      return { resources: this._state?.resources ?? [] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
  connectShouldFail = false
  connectShouldHang = false
  connectError = "Mock transport cannot connect"
  clientCreateCount = 0
  clientOptions.length = 0
  transportCloseCount = 0
})

// Import after mocks
const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

// --- Helper ---

function withInstance(
  config: Record<string, unknown>,
  fn: (mcp: MCPNS.Interface) => Effect.Effect<void, unknown, never>,
) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/mimocode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: config,
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(MCP.Service.use(fn).pipe(Effect.provide(MCP.defaultLayer)))
        // dispose instance to clean up state between tests
        await Instance.dispose()
      },
    })
  }
}

// ========================================================================
// Test: tools() are cached after connect
// ========================================================================

test(
  "tools() reuses cached tool definitions after connect",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "my-server"
      const serverState = getOrCreateClientState("my-server")
      serverState.tools = [
        { name: "do_thing", description: "does a thing", inputSchema: { type: "object", properties: {} } },
      ]

      // First: add the server successfully
      const addResult = yield* mcp.add("my-server", {
        type: "local",
        command: ["echo", "test"],
      })
      expect((addResult.status as any)["my-server"]?.status ?? (addResult.status as any).status).toBe("connected")

      expect(serverState.listToolsCalls).toBe(1)

      const toolsA = yield* mcp.tools()
      const toolsB = yield* mcp.tools()
      expect(Object.keys(toolsA).length).toBeGreaterThan(0)
      expect(Object.keys(toolsB).length).toBeGreaterThan(0)
      expect(serverState.listToolsCalls).toBe(1)
    }),
  ),
)

test(
  "client advertises the exact lifecycle v1 capability during initialization",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "lifecycle-server"
      yield* mcp.add("lifecycle-server", {
        type: "local",
        command: ["echo", "test"],
      })

      // Kept as an EXACT toEqual so any unintended capability addition still
      // fails here. `sampling: {}` is declared because production registers a
      // sampling/createMessage request handler and the SDK refuses that
      // registration otherwise; sampling.tools/context stay undeclared.
      expect(clientOptions).toEqual([
        {
          capabilities: {
            sampling: {},
            experimental: {
              "com.xiaomi.mimo/turn-lifecycle": { version: 1 },
            },
          },
        },
      ])
    }),
  ),
)

test(
  "turn metadata is omitted unless the server advertises lifecycle v1",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "legacy-server"
      const serverState = getOrCreateClientState("legacy-server")
      yield* mcp.add("legacy-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const tools = yield* mcp.tools({ sessionId: "ses_1", turnId: "turn_1", actorId: "main" })
      const execute = tools["legacy-server_test_tool"]?.execute
      expect(execute).toBeDefined()
      yield* Effect.promise(() =>
        Promise.resolve(
          execute?.({}, { toolCallId: "call_1", messages: [], abortSignal: new AbortController().signal }),
        ),
      )

      expect(serverState.toolCalls).toEqual([{ name: "test_tool", arguments: {} }])
    }),
  ),
)

test(
  "turn metadata is stable across calls to a lifecycle-aware server",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "lifecycle-server"
      const serverState = getOrCreateClientState("lifecycle-server")
      serverState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      yield* mcp.add("lifecycle-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const context = { sessionId: "ses_1", turnId: "turn_1", actorId: "main" }
      const tools = yield* mcp.tools(context)
      const execute = tools["lifecycle-server_test_tool"]?.execute
      expect(execute).toBeDefined()
      yield* Effect.promise(() =>
        Promise.all([
          Promise.resolve(
            execute?.({ index: 1 }, { toolCallId: "call_1", messages: [], abortSignal: new AbortController().signal }),
          ),
          Promise.resolve(
            execute?.({ index: 2 }, { toolCallId: "call_2", messages: [], abortSignal: new AbortController().signal }),
          ),
        ]),
      )

      expect(serverState.toolCalls).toEqual([
        {
          name: "test_tool",
          arguments: { index: 1 },
          _meta: { "com.xiaomi.mimo/turn-lifecycle": context },
        },
        {
          name: "test_tool",
          arguments: { index: 2 },
          _meta: { "com.xiaomi.mimo/turn-lifecycle": context },
        },
      ])
    }),
  ),
)

test(
  "cancelling tool execution aborts the in-flight MCP request before terminal notification",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "lifecycle-server"
      const serverState = getOrCreateClientState("lifecycle-server")
      serverState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      serverState.toolCallHangs = true
      yield* mcp.add("lifecycle-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const context = { sessionId: "ses_1", turnId: "turn_1", actorId: "main" }
      const tools = yield* mcp.tools(context)
      const execute = tools["lifecycle-server_test_tool"]?.execute
      expect(execute).toBeDefined()
      const controller = new AbortController()
      const execution = Promise.resolve(
        execute?.({}, { toolCallId: "call_1", messages: [], abortSignal: controller.signal }),
      )

      expect(serverState.toolCallSignals).toEqual([controller.signal])
      expect(serverState.notifications).toEqual([])
      controller.abort(new Error("turn cancelled"))
      yield* Effect.promise(() =>
        execution.then(
          () => Promise.reject(new Error("cancelled MCP call unexpectedly resolved")),
          (error) => {
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe("turn cancelled")
          },
        ),
      )
      expect(serverState.toolCallAbortCount).toBe(1)

      yield* MCP.notifyTurnLifecycle(yield* mcp.clients(), context, "cancelled")
      expect(serverState.notifications).toEqual([
        {
          method: "notifications/com.xiaomi.mimo/turn-lifecycle",
          params: { ...context, status: "cancelled" },
        },
      ])
    }),
  ),
)

test(
  "turn lifecycle notifications carry each terminal status only for v1 servers",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "lifecycle-server"
      const serverState = getOrCreateClientState("lifecycle-server")
      serverState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      yield* mcp.add("lifecycle-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const context = { sessionId: "ses_1", turnId: "turn_1", actorId: "main" }
      const clients = yield* mcp.clients()
      yield* MCP.notifyTurnLifecycle(clients, context, "completed")
      yield* MCP.notifyTurnLifecycle(clients, context, "cancelled")
      yield* MCP.notifyTurnLifecycle(clients, context, "error")

      expect(serverState.notifications).toEqual(
        ["completed", "cancelled", "error"].map((status) => ({
          method: "notifications/com.xiaomi.mimo/turn-lifecycle",
          params: { ...context, status },
        })),
      )
    }),
  ),
)

test(
  "turn lifecycle ignores unsupported and non-numeric capability versions",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "legacy-server"
      const serverState = getOrCreateClientState("legacy-server")
      serverState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: "1" } },
      }
      yield* mcp.add("legacy-server", {
        type: "local",
        command: ["echo", "test"],
      })

      yield* MCP.notifyTurnLifecycle(yield* mcp.clients(), { sessionId: "ses_1", turnId: "turn_1" }, "completed")

      expect(serverState.notifications).toEqual([])
    }),
  ),
)

test(
  "turn lifecycle notification failures are best effort and do not block other servers",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "failing-server"
      const failingState = getOrCreateClientState("failing-server")
      failingState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      failingState.notificationError = "closed"
      yield* mcp.add("failing-server", { type: "local", command: ["echo", "test"] })

      lastCreatedClientName = "healthy-server"
      const healthyState = getOrCreateClientState("healthy-server")
      healthyState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      yield* mcp.add("healthy-server", { type: "local", command: ["echo", "test"] })

      yield* MCP.notifyTurnLifecycle(yield* mcp.clients(), { sessionId: "ses_1", turnId: "turn_1" }, "completed")

      expect(failingState.notifications).toEqual([])
      expect(healthyState.notifications).toHaveLength(1)
    }),
  ),
)

test(
  "turn lifecycle serializes overlapping healthy notifications without dropping turns",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "lifecycle-server"
      const serverState = getOrCreateClientState("lifecycle-server")
      serverState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      serverState.notificationHangs = true
      yield* mcp.add("lifecycle-server", { type: "local", command: ["echo", "test"] })

      const clients = yield* mcp.clients()
      const first = yield* MCP.notifyTurnLifecycle(clients, { sessionId: "ses_1", turnId: "turn_1" }, "completed").pipe(
        Effect.forkChild,
      )
      yield* Effect.sleep(25)
      expect(serverState.notificationCalls).toBe(1)

      const second = yield* MCP.notifyTurnLifecycle(
        clients,
        { sessionId: "ses_2", turnId: "turn_2" },
        "completed",
      ).pipe(Effect.forkChild)
      yield* Effect.sleep(25)
      expect(serverState.notificationCalls).toBe(1)
      expect(serverState.notificationInFlight).toBe(1)

      serverState.notificationHangs = false
      serverState.notificationResolvers.shift()?.()
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      expect(serverState.notificationCalls).toBe(2)
      expect(serverState.notificationMaxInFlight).toBe(1)
      expect(serverState.notifications.map((notification) => notification.params)).toEqual([
        { sessionId: "ses_1", turnId: "turn_1", status: "completed" },
        { sessionId: "ses_2", turnId: "turn_2", status: "completed" },
      ])
    }),
  ),
)

test(
  "turn lifecycle times out hanging waiters without retaining or starting their sends",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hanging-server"
      const hangingState = getOrCreateClientState("hanging-server")
      hangingState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      hangingState.notificationHangs = true
      yield* mcp.add("hanging-server", { type: "local", command: ["echo", "test"] })

      lastCreatedClientName = "healthy-server"
      const healthyState = getOrCreateClientState("healthy-server")
      healthyState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      yield* mcp.add("healthy-server", { type: "local", command: ["echo", "test"] })

      const started = Date.now()
      const clients = yield* mcp.clients()
      const first = yield* MCP.notifyTurnLifecycle(clients, { sessionId: "ses_1", turnId: "turn_1" }, "completed").pipe(
        Effect.forkChild,
      )

      yield* Effect.sleep(50)
      expect(healthyState.notifications).toHaveLength(1)
      const second = yield* MCP.notifyTurnLifecycle(
        clients,
        { sessionId: "ses_1", turnId: "turn_2" },
        "completed",
      ).pipe(Effect.forkChild)
      const third = yield* MCP.notifyTurnLifecycle(clients, { sessionId: "ses_1", turnId: "turn_3" }, "completed").pipe(
        Effect.forkChild,
      )
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      yield* Fiber.join(third)
      expect(Date.now() - started).toBeLessThan(2_000)

      expect(hangingState.notificationCalls).toBe(1)
      expect(hangingState.notificationInFlight).toBe(1)
      expect(hangingState.notificationMaxInFlight).toBe(1)
      expect(healthyState.notifications).toHaveLength(3)

      hangingState.notificationHangs = false
      hangingState.notificationResolvers.shift()?.()
      yield* Effect.sleep(25)
      expect(hangingState.notificationCalls).toBe(1)
      expect(hangingState.notifications.map((notification) => notification.params)).toEqual([
        { sessionId: "ses_1", turnId: "turn_1", status: "completed" },
      ])

      yield* MCP.notifyTurnLifecycle(clients, { sessionId: "ses_1", turnId: "turn_4" }, "completed")

      expect(hangingState.notificationCalls).toBe(2)
      expect(hangingState.notificationInFlight).toBe(0)
      expect(hangingState.notificationMaxInFlight).toBe(1)
      expect(hangingState.notifications.map((notification) => notification.params)).toEqual([
        { sessionId: "ses_1", turnId: "turn_1", status: "completed" },
        { sessionId: "ses_1", turnId: "turn_4", status: "completed" },
      ])
      expect(healthyState.notifications).toHaveLength(4)
    }),
  ),
)

test(
  "turn lifecycle resumes after a notification rejects",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "lifecycle-server"
      const serverState = getOrCreateClientState("lifecycle-server")
      serverState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      serverState.notificationError = "closed"
      yield* mcp.add("lifecycle-server", { type: "local", command: ["echo", "test"] })

      const clients = yield* mcp.clients()
      yield* MCP.notifyTurnLifecycle(clients, { sessionId: "ses_1", turnId: "turn_1" }, "completed")
      serverState.notificationError = undefined
      yield* MCP.notifyTurnLifecycle(clients, { sessionId: "ses_1", turnId: "turn_2" }, "completed")

      expect(serverState.notificationCalls).toBe(2)
      expect(serverState.notificationMaxInFlight).toBe(1)
      expect(serverState.notifications.map((notification) => notification.params)).toEqual([
        { sessionId: "ses_1", turnId: "turn_2", status: "completed" },
      ])
    }),
  ),
)

test(
  "replacement clients are not blocked by an old pending notification",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "replacement-old"
      const oldState = getOrCreateClientState("replacement-old")
      oldState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      oldState.notificationHangs = true
      yield* mcp.add("replace-server", { type: "local", command: ["echo", "test"] })

      const oldNotification = yield* MCP.notifyTurnLifecycle(
        yield* mcp.clients(),
        { sessionId: "ses_1", turnId: "turn_1" },
        "completed",
      ).pipe(Effect.forkChild)
      yield* Effect.sleep(25)
      expect(oldState.notificationCalls).toBe(1)

      lastCreatedClientName = "replacement-new"
      const newState = getOrCreateClientState("replacement-new")
      newState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      yield* mcp.add("replace-server", { type: "local", command: ["echo", "test"] })
      yield* MCP.notifyTurnLifecycle(yield* mcp.clients(), { sessionId: "ses_2", turnId: "turn_2" }, "completed")

      expect(oldState.notificationCalls).toBe(1)
      expect(newState.notificationCalls).toBe(1)
      expect(newState.notifications.map((notification) => notification.params)).toEqual([
        { sessionId: "ses_2", turnId: "turn_2", status: "completed" },
      ])

      oldState.notificationHangs = false
      oldState.notificationResolvers.shift()?.()
      yield* Fiber.join(oldNotification)
    }),
  ),
)

// ========================================================================
test(
  "turn lifecycle abandons a permanently stuck send so a later turn still notifies promptly",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "stuck-server"
      const stuckState = getOrCreateClientState("stuck-server")
      stuckState.serverCapabilities = {
        experimental: { "com.xiaomi.mimo/turn-lifecycle": { version: 1 } },
      }
      stuckState.notificationHangs = true
      yield* mcp.add("stuck-server", { type: "local", command: ["echo", "test"] })

      const clients = yield* mcp.clients()

      // turn_1's send never settles — its resolver is deliberately never called, so it
      // stays orphaned in the pending map for the rest of the test.
      yield* MCP.notifyTurnLifecycle(clients, { sessionId: "ses_1", turnId: "turn_1" }, "completed")
      expect(stuckState.notificationCalls).toBe(1)
      expect(stuckState.notifications).toEqual([])

      // The transport recovers, but the orphaned send is still parked in the pending map.
      stuckState.notificationHangs = false
      yield* Effect.sleep(50)

      const started = Date.now()
      yield* MCP.notifyTurnLifecycle(clients, { sessionId: "ses_1", turnId: "turn_2" }, "completed")
      const elapsed = Date.now() - started

      // Before the fix this turn queued behind the orphan, burned the whole 1s budget
      // and was dropped (notificationCalls would still be 1) — and so would every turn
      // after it. Now the stuck entry is released and the send happens immediately.
      expect(stuckState.notificationCalls).toBe(2)
      expect(elapsed).toBeLessThan(MCP.TURN_LIFECYCLE_NOTIFICATION_TIMEOUT / 2)
      expect(stuckState.notifications.map((notification) => notification.params)).toEqual([
        { sessionId: "ses_1", turnId: "turn_2", status: "completed" },
      ])
      // Only the abandoned send is still counted in flight; overlapping it is the
      // accepted cost of not blocking later turns forever.
      expect(stuckState.notificationInFlight).toBe(1)
      expect(stuckState.notificationMaxInFlight).toBe(2)

      // A further turn is also prompt, and healthy sends stay serialized behind
      // each other rather than piling up.
      const secondStarted = Date.now()
      yield* MCP.notifyTurnLifecycle(clients, { sessionId: "ses_1", turnId: "turn_3" }, "completed")
      expect(Date.now() - secondStarted).toBeLessThan(MCP.TURN_LIFECYCLE_NOTIFICATION_TIMEOUT / 2)
      expect(stuckState.notificationCalls).toBe(3)
      expect(stuckState.notificationInFlight).toBe(1)
      expect(stuckState.notificationMaxInFlight).toBe(2)
      expect(stuckState.notifications.map((notification) => notification.params)).toEqual([
        { sessionId: "ses_1", turnId: "turn_2", status: "completed" },
        { sessionId: "ses_1", turnId: "turn_3", status: "completed" },
      ])
    }),
  ),
)

// Test: tool change notifications refresh the cache
// ========================================================================

test(
  "tool change notifications refresh cached tool definitions",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "status-server"
      const serverState = getOrCreateClientState("status-server")

      yield* mcp.add("status-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const before = yield* mcp.tools()
      expect(Object.keys(before).some((key) => key.includes("test_tool"))).toBe(true)
      expect(serverState.listToolsCalls).toBe(1)

      serverState.tools = [{ name: "next_tool", description: "next", inputSchema: { type: "object", properties: {} } }]

      const handler = Array.from(serverState.notificationHandlers.values())[0]
      expect(handler).toBeDefined()
      yield* Effect.promise(() => handler?.())

      const after = yield* mcp.tools()
      expect(Object.keys(after).some((key) => key.includes("next_tool"))).toBe(true)
      expect(Object.keys(after).some((key) => key.includes("test_tool"))).toBe(false)
      expect(serverState.listToolsCalls).toBe(2)
    }),
  ),
)

// ========================================================================
// Test: connect() / disconnect() lifecycle
// ========================================================================

test(
  "disconnect sets status to disabled and removes client",
  withInstance(
    {
      "disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "disc-server"
        getOrCreateClientState("disc-server")

        yield* mcp.add("disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const statusBefore = yield* mcp.status()
        expect(statusBefore["disc-server"]?.status).toBe("connected")

        yield* mcp.disconnect("disc-server")

        const statusAfter = yield* mcp.status()
        expect(statusAfter["disc-server"]?.status).toBe("disabled")

        // Tools should be empty after disconnect
        const tools = yield* mcp.tools()
        const serverTools = Object.keys(tools).filter((k) => k.startsWith("disc-server"))
        expect(serverTools.length).toBe(0)
      }),
  ),
)

test(
  "connect() after disconnect() re-establishes the server",
  withInstance(
    {
      "reconn-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "reconn-server"
        const serverState = getOrCreateClientState("reconn-server")
        serverState.tools = [
          { name: "my_tool", description: "a tool", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("reconn-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("disabled")

        // Reconnect
        yield* mcp.connect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("connected")

        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("my_tool"))).toBe(true)
      }),
  ),
)

// ========================================================================
// Test: add() closes existing client before replacing
// ========================================================================

test(
  "add() closes the old client when replacing a server",
  // Don't put the server in config — add it dynamically so we control
  // exactly which client instance is "first" vs "second".
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "replace-server"
      const firstState = getOrCreateClientState("replace-server")

      yield* mcp.add("replace-server", {
        type: "local",
        command: ["echo", "test"],
      })

      expect(firstState.closed).toBe(false)

      // Create new state for second client
      clientStates.delete("replace-server")
      const secondState = getOrCreateClientState("replace-server")

      // Re-add should close the first client
      yield* mcp.add("replace-server", {
        type: "local",
        command: ["echo", "test"],
      })

      expect(firstState.closed).toBe(true)
      expect(secondState.closed).toBe(false)
    }),
  ),
)

// ========================================================================
// Test: state init with mixed success/failure
// ========================================================================

test(
  "init connects available servers even when one fails",
  withInstance(
    {
      "good-server": {
        type: "local",
        command: ["echo", "good"],
      },
      "bad-server": {
        type: "local",
        command: ["echo", "bad"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        // Set up good server
        const goodState = getOrCreateClientState("good-server")
        goodState.tools = [{ name: "good_tool", description: "works", inputSchema: { type: "object", properties: {} } }]

        // Set up bad server - will fail on listTools during create()
        const badState = getOrCreateClientState("bad-server")
        badState.listToolsShouldFail = true

        // Add good server first
        lastCreatedClientName = "good-server"
        yield* mcp.add("good-server", {
          type: "local",
          command: ["echo", "good"],
        })

        // Add bad server - should fail but not affect good server
        lastCreatedClientName = "bad-server"
        yield* mcp.add("bad-server", {
          type: "local",
          command: ["echo", "bad"],
        })

        const status = yield* mcp.status()
        expect(status["good-server"]?.status).toBe("connected")
        expect(status["bad-server"]?.status).toBe("failed")

        // Good server's tools should still be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("good_tool"))).toBe(true)
      }),
  ),
)

// ========================================================================
// Test: disabled server via config
// ========================================================================

test(
  "disabled server is marked as disabled without attempting connection",
  withInstance(
    {
      "disabled-server": {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        const countBefore = clientCreateCount

        yield* mcp.add("disabled-server", {
          type: "local",
          command: ["echo", "test"],
          enabled: false,
        } as any)

        // No client should have been created
        expect(clientCreateCount).toBe(countBefore)

        const status = yield* mcp.status()
        expect(status["disabled-server"]?.status).toBe("disabled")
      }),
  ),
)

// ========================================================================
// Test: prompts() and resources()
// ========================================================================

test(
  "prompts() returns prompts from connected servers",
  withInstance(
    {
      "prompt-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-server"
        const serverState = getOrCreateClientState("prompt-server")
        serverState.prompts = [{ name: "my-prompt", description: "A test prompt" }]

        yield* mcp.add("prompt-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(1)
        const key = Object.keys(prompts)[0]
        expect(key).toContain("prompt-server")
        expect(key).toContain("my-prompt")
      }),
  ),
)

test(
  "resources() returns resources from connected servers",
  withInstance(
    {
      "resource-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "resource-server"
        const serverState = getOrCreateClientState("resource-server")
        serverState.resources = [{ name: "my-resource", uri: "file:///test.txt", description: "A test resource" }]

        yield* mcp.add("resource-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const resources = yield* mcp.resources()
        expect(Object.keys(resources).length).toBe(1)
        const key = Object.keys(resources)[0]
        expect(key).toContain("resource-server")
        expect(key).toContain("my-resource")
      }),
  ),
)

test(
  "prompts() skips disconnected servers",
  withInstance(
    {
      "prompt-disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-disc-server"
        const serverState = getOrCreateClientState("prompt-disc-server")
        serverState.prompts = [{ name: "hidden-prompt", description: "Should not appear" }]

        yield* mcp.add("prompt-disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("prompt-disc-server")

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(0)
      }),
  ),
)

// ========================================================================
// Test: connect() on nonexistent server
// ========================================================================

test(
  "connect() on nonexistent server does not throw",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      // Should not throw
      yield* mcp.connect("nonexistent")
      const status = yield* mcp.status()
      expect(status["nonexistent"]).toBeUndefined()
    }),
  ),
)

// ========================================================================
// Test: disconnect() on nonexistent server
// ========================================================================

test(
  "disconnect() on nonexistent server does not throw",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      yield* mcp.disconnect("nonexistent")
      // Should complete without error
    }),
  ),
)

// ========================================================================
// Test: tools() with no MCP servers configured
// ========================================================================

test(
  "tools() returns empty when no MCP servers are configured",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      const tools = yield* mcp.tools()
      expect(Object.keys(tools).length).toBe(0)
    }),
  ),
)

// ========================================================================
// Test: connect failure during create()
// ========================================================================

test(
  "server that fails to connect is marked as failed",
  withInstance(
    {
      "fail-connect": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "fail-connect"
        getOrCreateClientState("fail-connect")
        connectShouldFail = true
        connectError = "Connection refused"

        yield* mcp.add("fail-connect", {
          type: "local",
          command: ["echo", "test"],
        })

        const status = yield* mcp.status()
        expect(status["fail-connect"]?.status).toBe("failed")
        if (status["fail-connect"]?.status === "failed") {
          expect(status["fail-connect"].error).toContain("Connection refused")
        }

        // No tools should be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).length).toBe(0)
      }),
  ),
)

// ========================================================================
// Bug #5: McpOAuthCallback.cancelPending uses wrong key
// ========================================================================

test("McpOAuthCallback.cancelPending is keyed by mcpName but pendingAuths uses oauthState", async () => {
  const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")

  // Register a pending auth with an oauthState key, associated to an mcpName
  const oauthState = "abc123hexstate"
  const callbackPromise = McpOAuthCallback.waitForCallback(oauthState, "my-mcp-server")

  // cancelPending is called with mcpName — should find the entry via reverse index
  McpOAuthCallback.cancelPending("my-mcp-server")

  // The callback should still be pending because cancelPending looked up
  // "my-mcp-server" in a map keyed by "abc123hexstate"
  let rejected = false
  callbackPromise.then(() => {}).catch(() => (rejected = true))

  // Give it a tick
  await new Promise((r) => setTimeout(r, 50))

  // cancelPending("my-mcp-server") should have rejected the pending callback
  expect(rejected).toBe(true)

  await McpOAuthCallback.stop()
})

// ========================================================================
// Test: multiple tools from same server get correct name prefixes
// ========================================================================

test(
  "tools() prefixes tool names with sanitized server name",
  withInstance(
    {
      "my.special-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "my.special-server"
        const serverState = getOrCreateClientState("my.special-server")
        serverState.tools = [
          { name: "tool-a", description: "Tool A", inputSchema: { type: "object", properties: {} } },
          { name: "tool.b", description: "Tool B", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("my.special-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const tools = yield* mcp.tools()
        const keys = Object.keys(tools)

        // Server name dots should be replaced with underscores
        expect(keys.some((k) => k.startsWith("my_special-server_"))).toBe(true)
        // Tool name dots should be replaced with underscores
        expect(keys.some((k) => k.endsWith("tool_b"))).toBe(true)
        expect(keys.length).toBe(2)
      }),
  ),
)

// ========================================================================
// Test: transport leak — local stdio timeout (#19168)
// ========================================================================

test(
  "local stdio transport is closed when connect times out (no process leak)",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hanging-server"
      getOrCreateClientState("hanging-server")
      connectShouldHang = true

      const addResult = yield* mcp.add("hanging-server", {
        type: "local",
        command: ["node", "fake.js"],
        timeout: 100,
      })

      const serverStatus = (addResult.status as any)["hanging-server"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      expect(serverStatus.error).toContain("timed out")
      // Transport must be closed to avoid orphaned child process
      expect(transportCloseCount).toBeGreaterThanOrEqual(1)
    }),
  ),
)

// ========================================================================
// Test: transport leak — remote timeout (#19168)
// ========================================================================

test(
  "remote transport is closed when connect times out",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hanging-remote"
      getOrCreateClientState("hanging-remote")
      connectShouldHang = true

      const addResult = yield* mcp.add("hanging-remote", {
        type: "remote",
        url: "http://localhost:9999/mcp",
        timeout: 100,
        oauth: false,
      })

      const serverStatus = (addResult.status as any)["hanging-remote"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      // Transport must be closed to avoid leaked HTTP connections
      expect(transportCloseCount).toBeGreaterThanOrEqual(1)
    }),
  ),
)

// ========================================================================
// Test: transport leak — failed remote transports not closed (#19168)
// ========================================================================

test(
  "failed remote transport is closed before trying next transport",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "fail-remote"
      getOrCreateClientState("fail-remote")
      connectShouldFail = true
      connectError = "Connection refused"

      const addResult = yield* mcp.add("fail-remote", {
        type: "remote",
        url: "http://localhost:9999/mcp",
        timeout: 5000,
        oauth: false,
      })

      const serverStatus = (addResult.status as any)["fail-remote"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      // Both StreamableHTTP and SSE transports should be closed
      expect(transportCloseCount).toBeGreaterThanOrEqual(2)
    }),
  ),
)
