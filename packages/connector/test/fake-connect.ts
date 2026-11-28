// In-process stand-in for the Connect 1.0 service, strict enough to catch wire
// mistakes: it checks the Passport credential headers, verifies every device
// proof (ES256 over the JWS, closed claims, nonce single use, body digest, login
// instance), enforces the version / profile / request-id header rules, requires
// the server-v1 heartbeat on the control socket, speaks the bus (Centrifuge JSON
// subset) on /api/connect/bus and answers with the real envelope. Tests script
// business state on it.

import type { Server, ServerWebSocket } from "bun"
import { base64url, canonical, fromBase64url, hex, sha256 } from "../src/json"
import { BUS_PROTOCOL } from "../src/bus"
import { CONTROL_PROTOCOL } from "../src/control"

type Socket = ServerWebSocket<{ path: string }>

export type FakeOptions = {
  environment?: string
  userId?: string
  serviceToken?: string
  loginInstanceId?: string
}

class FakeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export class FakeConnect {
  readonly environment: string
  readonly userId: string
  readonly serviceToken: string
  loginInstanceId: string
  /** False: the account is not on the admission list (device challenges answer 403). */
  admitted = true
  private server!: Server<{ path: string }>
  private nonces = new Map<string, { method: string; path: string; thumbprint: string }>()
  /** Every HTTP request, for assertions. */
  readonly requests: { method: string; path: string; headers: Headers; body?: unknown }[] = []
  /** Scripted failures: path -> [status, code, retryAfter?] consumed once. */
  readonly failNext = new Map<string, [number, string, string?]>()
  /** Mutations applied to the next envelope for `path` (to break the wire on purpose). */
  readonly tamper = new Map<string, (response: Response) => Response | Promise<Response>>()
  devices = new Map<string, { name: string; thumbprint: string }>()
  epoch = 0
  discovery: "cli" | "empty" | "missing" | readonly string[] = "cli"
  challenges = new Map<
    string,
    { code: string; status: string; request: null | { requestId: string; phoneName: string } }
  >()
  decisions = new Map<string, { status: string; bindingId: string | null }>()
  grants = new Map<string, Record<string, unknown>>()
  bindings = new Map<string, Record<string, unknown>>()
  control: Socket | undefined
  /** Current bus registration per binding (bus-channel §4.3). */
  readonly registrations = new Map<string, { deviceGroupId: string; connectionEpoch: number; grantVersion: number }>()
  /** Live bus subscriptions: channel -> socket. */
  readonly subscriptions = new Map<string, Socket>()
  /** Publications the connector made on reply channels, in order. */
  readonly published: { channel: string; data: Record<string, unknown> }[] = []
  /** Frames received on WS, by path. */
  readonly frames: { path: string; frame: Record<string, unknown> }[] = []
  /** Scripted refusal of the next publish: Centrifuge error code. */
  refusePublish: number | undefined
  private offset = 0

  constructor(options: FakeOptions = {}) {
    this.environment = options.environment ?? "china-test"
    this.userId = options.userId ?? "2469486853"
    this.serviceToken = options.serviceToken ?? "S".repeat(64)
    this.loginInstanceId = options.loginInstanceId ?? "0123456789abcdef0123456789abcdef"
  }

  get origin(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  account() {
    return {
      origin: this.origin,
      environment: this.environment,
      serviceToken: this.serviceToken,
      userId: this.userId,
    }
  }

  /** The unified login credential (xiaomi-account §3.2), on HTTP and on every upgrade. */
  private authenticated(headers: Headers): boolean {
    return (
      headers.get("Authorization") === `Bearer ${this.serviceToken}` &&
      headers.get("Mimo-Passport-User") === this.userId &&
      headers.get("Mimo-Passport-CUser") === null
    )
  }

  start(): this {
    this.server = Bun.serve<{ path: string }>({
      port: 0,
      fetch: (request, server) => this.handle(request, server),
      websocket: {
        open: (ws) => this.wsOpen(ws),
        message: (ws, message) => this.wsMessage(ws, String(message)),
        close: (ws) => {
          this.heartbeats.delete(ws)
          if (ws === this.control) this.control = undefined
          for (const [channel, socket] of this.subscriptions) if (socket === ws) this.subscriptions.delete(channel)
        },
      },
    })
    return this
  }

  stop(): void {
    this.server.stop(true)
  }

  // ---- HTTP -------------------------------------------------------------

  private async handle(
    request: Request,
    server: Server<{ path: string }>,
  ): Promise<Response | undefined> {
    const url = new URL(request.url)
    const path = url.pathname
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return this.upgrade(request, server, path)
    const id = request.headers.get("Mimo-Request-Id") ?? crypto.randomUUID()
    const text = await request.text()
    const body = text ? JSON.parse(text) : undefined
    this.requests.push({ method: request.method, path, headers: request.headers, body })
    const scripted = this.failNext.get(path)
    if (scripted) {
      this.failNext.delete(path)
      return this.error(id, scripted[0], scripted[1], scripted[0] === 426 ? null : "1.0", scripted[2])
    }
    if (!this.authenticated(request.headers)) return this.error(id, 401, "unauthenticated", null)
    const version = request.headers.get("Mimo-Connect-Version")
    if (version !== "1.0") return this.error(id, 426, "protocol_incompatible", null)
    if (request.headers.get("X-Request-Id") !== null) throw new Error("fake connect: X-Request-Id is retired")
    const profile = request.headers.get("Mimo-Connect-Profile")
    const respond = (data: unknown, status = 200, v = version) => {
      const response = this.envelope(id, v, data, status, profile)
      const tamper = this.tamper.get(path)
      if (tamper) {
        this.tamper.delete(path)
        return tamper(response)
      }
      return response
    }

    if (path === "/api/connect/connector-capabilities") {
      if (profile !== null) return this.error(id, 400, "invalid_request", version)
      if (this.discovery === "missing") return this.error(id, 404, "not_found", null)
      return respond({
        contract: "connector-discovery",
        profiles: this.discovery === "cli" ? ["cli-connector"] : this.discovery === "empty" ? [] : this.discovery,
      })
    }
    if (path === "/api/connect/device-challenges") {
      if (!this.admitted) return this.error(id, 403, "allowlist_denied", version)
      const nonce = crypto.randomUUID()
      this.nonces.set(nonce, { method: body.method, path: body.path, thumbprint: body.keyThumbprint })
      const now = Date.now()
      return respond({
        nonce,
        loginInstanceId: this.loginInstanceId,
        environment: this.environment,
        expiresAt: new Date(now + 60_000).toISOString(),
        serverTime: new Date(now).toISOString(),
      })
    }
    // Everything below is a CLI actor endpoint: profile required, proof required.
    if (profile !== "cli-connector") return this.error(id, 426, "protocol_incompatible", null)
    const proof = await this.verifyProof(request.method, path, body, request.headers.get("X-Device-Proof"))
    if (!proof) return this.error(id, 401, "proof_rejected", version)
    if (path === "/api/connect/devices" && request.method === "POST") {
      const existing = [...this.devices.entries()].find(([, d]) => d.thumbprint === proof)
      const deviceId = existing?.[0] ?? crypto.randomUUID()
      this.devices.set(deviceId, { name: body.name, thumbprint: proof })
      return respond({ deviceId, role: "cli", name: body.name }, 201)
    }
    const deviceId = request.headers.get("X-Device-Id")
    if (!deviceId || this.devices.get(deviceId)?.thumbprint !== proof) return this.error(id, 403, "forbidden", version)
    try {
      return respond(this.business(request.method, path, body, url), this.businessStatus)
    } catch (error) {
      if (error instanceof FakeError) return this.error(id, error.status, error.code, version)
      throw error
    }
  }

  /** Status for the last business answer (201 for creates). */
  private businessStatus = 200

  private business(method: string, path: string, body: any, url: URL): unknown {
    this.businessStatus = 200
    if (path === "/api/connect/pairing/challenges" && method === "POST") {
      this.businessStatus = 201
      const challengeId = crypto.randomUUID()
      const code = String(Math.floor(Math.random() * 10000)).padStart(4, "0")
      this.challenges.set(challengeId, { code, status: "open", request: null })
      return { challengeId, code, expiresAt: new Date(Date.now() + 300_000).toISOString().replace(/\.\d+Z$/, ".000Z") }
    }
    const challenge = path.match(/^\/api\/connect\/pairing\/challenges\/([^/]+)$/)
    if (challenge) {
      const c = this.challenges.get(challenge[1])!
      return { challengeId: challenge[1], status: c.status, request: c.request }
    }
    const decision = path.match(/^\/api\/connect\/pairing\/requests\/([^/]+)\/(approve|reject|cancel)$/)
    if (decision) {
      const status = { approve: "approved", reject: "rejected", cancel: "cancelled" }[decision[2]]!
      const earlier = this.decisions.get(decision[1])
      if (earlier) return { requestId: decision[1], ...earlier }
      const bindingId = status === "approved" ? crypto.randomUUID() : null
      if (bindingId) this.bindings.set(bindingId, this.bindingView(bindingId))
      this.decisions.set(decision[1], { status, bindingId })
      for (const challenge of this.challenges.values()) {
        if (challenge.request?.requestId === decision[1]) challenge.status = status
      }
      return { requestId: decision[1], status, bindingId }
    }
    const request = path.match(/^\/api\/connect\/pairing\/requests\/([^/]+)$/)
    if (request)
      return { requestId: request[1], ...(this.decisions.get(request[1]) ?? { status: "claimed", bindingId: null }) }
    const list = path.match(/^\/api\/connect\/devices\/([^/]+)\/bindings$/)
    if (list) {
      const all = [...this.bindings.values()]
      const start = Number(url.searchParams.get("cursor") ?? 0)
      const page = all.slice(start, start + 1)
      const next = start + 1 < all.length ? String(start + 1) : null
      return {
        contract: "connector-bindings",
        deviceId: list[1],
        bindings: page.map((binding) => ({ binding, phoneName: "Pixel" })),
        nextCursor: next,
      }
    }
    const meta = path.match(/^\/api\/connect\/bindings\/([^/]+)\/content-upgrade-metadata$/)
    if (meta && this.bindings.get(meta[1])?.state === "revoked") throw new FakeError(403, "binding_revoked")
    if (meta) {
      const grant = this.grants.get(meta[1])
      return {
        bindingId: meta[1],
        connectorId: [...this.devices.keys()][0],
        targetKind: grant ? "cli" : null,
        protocolVersion: grant ? 1 : null,
        grantVersion: (grant?.grantVersion as number) ?? 0,
      }
    }
    const grant = path.match(/^\/api\/connect\/bindings\/([^/]+)\/content-grant$/)
    if (grant && method === "GET") return this.grants.get(grant[1])
    if (grant && method === "PUT") {
      const binding = this.bindings.get(grant[1])
      if (binding?.state !== "active") throw new FakeError(403, "binding_revoked")
      const current = this.grants.get(grant[1])?.grantVersion ?? 0
      if (body.connectionEpoch !== this.epoch || body.expectedVersion !== current || body.grantVersion !== body.expectedVersion + 1) {
        throw new FakeError(409, "conflict")
      }
      const view = {
        protocolVersion: 1,
        targetKind: "cli",
        bindingId: grant[1],
        connectorId: [...this.devices.keys()][0],
        grantVersion: body.grantVersion,
        revocationVersion: 0,
        connectionEpoch: body.connectionEpoch,
        state: body.state,
        scopes: body.scopes,
        relayFence: "complete",
      }
      this.grants.set(grant[1], view)
      return view
    }
    const registration = path.match(/^\/api\/connect\/bindings\/([^/]+)\/bus-registration$/)
    if (registration) {
      const bindingId = registration[1]
      if (Object.keys(body).sort().join(",") !== "connectionEpoch,deviceGroupId,grantVersion,protocolVersion")
        throw new FakeError(400, "invalid_request")
      if (this.bindings.get(bindingId)?.state !== "active") throw new FakeError(403, "binding_revoked")
      const grant = this.grants.get(bindingId)
      if (!grant || grant.state !== "active") throw new FakeError(409, "grant_unavailable")
      if (body.connectionEpoch !== this.epoch || body.grantVersion !== grant.grantVersion)
        throw new FakeError(409, "grant_changed")
      this.registrations.set(bindingId, {
        deviceGroupId: body.deviceGroupId,
        connectionEpoch: body.connectionEpoch,
        grantVersion: body.grantVersion,
      })
      return {
        protocolVersion: 1,
        bindingId,
        deviceGroupId: body.deviceGroupId,
        connectionEpoch: body.connectionEpoch,
        grantVersion: body.grantVersion,
        expiresInMs: 75000,
      }
    }
    const binding = path.match(/^\/api\/connect\/bindings\/([^/]+)(\/revoke)?$/)
    if (binding) {
      const view = this.bindings.get(binding[1])!
      if (binding[2]) {
        view.state = "revoked"
        view.revocationVersion = (view.revocationVersion as number) + 1
        setTimeout(() => this.withdraw(binding[1]), 10)
      }
      return view
    }
    throw new Error(`fake connect: unhandled ${method} ${path}`)
  }

  bindingView(bindingId: string): Record<string, unknown> {
    return {
      bindingId,
      phoneId: crypto.randomUUID(),
      connectorId: [...this.devices.keys()][0],
      connectorKind: "cli",
      connectorName: [...this.devices.values()][0]?.name ?? "cli",
      state: "active",
      relayFence: "complete",
      revocationVersion: 0,
    }
  }

  private async verifyProof(
    method: string,
    path: string,
    body: unknown,
    proof: string | null,
  ): Promise<string | undefined> {
    if (!proof) return undefined
    const [h, c, s] = proof.split(".")
    const header = JSON.parse(new TextDecoder().decode(fromBase64url(h)))
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(c)))
    if (header.alg !== "ES256" || header.typ !== "mimo-device-proof+jwt") return undefined
    const claimKeys = "aud,bodyDigest,environment,exp,iat,loginInstanceId,method,nonce,path"
    if (Object.keys(claims).sort().join(",") !== claimKeys) return undefined
    const key = await crypto.subtle.importKey("jwk", header.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ])
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64url(s),
      new TextEncoder().encode(`${h}.${c}`),
    )
    if (!ok) return undefined
    const thumbprint = base64url(
      await sha256(canonical({ crv: header.jwk.crv, kty: header.jwk.kty, x: header.jwk.x, y: header.jwk.y })),
    )
    const nonce = this.nonces.get(claims.nonce)
    this.nonces.delete(claims.nonce)
    const digest = hex(await sha256(body === undefined ? "" : canonical(body as never)))
    const now = Math.floor(Date.now() / 1000)
    if (
      !nonce ||
      nonce.method !== method ||
      nonce.path !== path ||
      nonce.thumbprint !== thumbprint ||
      claims.method !== method ||
      claims.path !== path ||
      claims.bodyDigest !== digest ||
      claims.aud !== this.origin ||
      claims.loginInstanceId !== this.loginInstanceId ||
      claims.environment !== this.environment ||
      // Same window as the service: at most 1 s ahead of its clock, at most 60 s old.
      !(
        claims.exp > claims.iat &&
        claims.exp - claims.iat <= 60 &&
        claims.iat - now <= 1 &&
        now - claims.iat <= 60 &&
        claims.exp > now
      )
    ) {
      return undefined
    }
    return thumbprint
  }

  private envelope(
    id: string,
    version: string | null,
    data: unknown,
    status: number,
    profile: string | null,
  ): Response {
    const headers = new Headers({ "Content-Type": "application/json", "Mimo-Request-Id": id })
    if (version) headers.set("Mimo-Connect-Version", version)
    if (profile) headers.set("Mimo-Connect-Profile", profile)
    return new Response(JSON.stringify({ contractVersion: version, requestId: id, data }), { status, headers })
  }

  private error(id: string, status: number, code: string, version: string | null, retryAfter?: string): Response {
    const headers = new Headers({ "Content-Type": "application/json", "Mimo-Request-Id": id })
    if (version) headers.set("Mimo-Connect-Version", version)
    if (retryAfter) headers.set("Retry-After", retryAfter)
    return new Response(JSON.stringify({
      contractVersion: version,
      requestId: id,
      error: { code },
      ...(status === 426 ? { supportedVersions: ["1.0"] } : {}),
    }), { status, headers })
  }

  // ---- WebSocket ----------------------------------------------------------

  private async upgrade(request: Request, server: Server<{ path: string }>, path: string) {
    const bus = path === "/api/connect/bus"
    const expected = bus ? BUS_PROTOCOL : CONTROL_PROTOCOL
    if (request.headers.get("Sec-WebSocket-Protocol") !== expected) return new Response(null, { status: 426 })
    if (request.headers.get("Mimo-Connect-Version") || request.headers.get("Mimo-Connect-Profile")) {
      return new Response(null, { status: 400 })
    }
    if (this.rejectUpgrade) {
      const [status, retryAfter] = this.rejectUpgrade
      this.rejectUpgrade = undefined
      return new Response(null, { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} })
    }
    if (!this.authenticated(request.headers)) return new Response(null, { status: 401 })
    // R60: control negotiates the service heartbeat; the bus negotiates none (its own ping/pong).
    const heartbeat = request.headers.get("Mimo-Heartbeat")
    if (bus ? heartbeat !== null : heartbeat !== "server-v1") return new Response(null, { status: bus ? 400 : 426 })
    const thumbprint = await this.verifyProof("GET", path, undefined, request.headers.get("X-Device-Proof"))
    const deviceId = request.headers.get("X-Device-Id")
    if (!thumbprint || !deviceId || this.devices.get(deviceId)?.thumbprint !== thumbprint) {
      return new Response(null, { status: 401 })
    }
    const echo: Record<string, string> = { "Sec-WebSocket-Protocol": expected }
    if (!bus && this.echoHeartbeat) echo["Mimo-Heartbeat"] = "server-v1"
    echo["Mimo-Request-Id"] = request.headers.get("Mimo-Request-Id") ?? ""
    server.upgrade(request, { data: { path }, headers: echo })
    return undefined
  }

  /** Scripted refusal of the next upgrade: [status, Retry-After]. */
  rejectUpgrade: [number, string?] | undefined
  /** When false, the 101 leaves out the heartbeat echo (a broken service). */
  echoHeartbeat = true
  /** Heartbeat state per socket: connection id and the probe awaiting a pong. */
  readonly heartbeats = new Map<Socket, { connectionId: string; sequence: number; pending?: number }>()
  /** Control pongs that renewed the lease, in order. */
  readonly renewals: number[] = []

  private heartbeatReady(ws: Socket): void {
    const connectionId = crypto.randomUUID()
    this.heartbeats.set(ws, { connectionId, sequence: 0 })
    ws.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "heartbeat-ready",
        connectionId,
        policyVersion: 1,
        pingIntervalMs: 25000,
        ackTimeoutMs: 10000,
        watchdogTimeoutMs: 45000,
        freezeGraceMs: 10000,
      }),
    )
  }

  /** Probe a socket like the service scheduler does. */
  ping(ws: Socket): number {
    const heartbeat = this.heartbeats.get(ws)!
    heartbeat.sequence += 1
    heartbeat.pending = heartbeat.sequence
    ws.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "heartbeat-ping",
        connectionId: heartbeat.connectionId,
        policyVersion: 1,
        sequence: heartbeat.sequence,
      }),
    )
    return heartbeat.sequence
  }

  private heartbeatFrame(ws: Socket, frame: Record<string, unknown>): void {
    const heartbeat = this.heartbeats.get(ws)
    const keys = Object.keys(frame).sort().join(",")
    if (
      !heartbeat ||
      frame.protocolVersion !== 1 ||
      frame.connectionId !== heartbeat.connectionId ||
      frame.policyVersion !== 1
    ) {
      return ws.close(1008, "invalid_heartbeat")
    }
    if (frame.type === "heartbeat-check") {
      if (keys !== "connectionId,policyVersion,protocolVersion,type") return ws.close(1008, "invalid_heartbeat")
      // The service re-sends the probe in flight (same sequence) or starts a new one.
      if (heartbeat.pending !== undefined) heartbeat.sequence -= 1
      this.ping(ws)
      return
    }
    if (
      frame.type !== "heartbeat-pong" ||
      keys !== "connectionId,policyVersion,protocolVersion,sequence,type" ||
      frame.sequence !== heartbeat.pending
    ) {
      return ws.close(1008, "invalid_heartbeat")
    }
    heartbeat.pending = undefined
    if (ws === this.control) this.renewals.push(frame.sequence as number)
    ws.send(JSON.stringify({ ...frame, type: "heartbeat-confirmed" }))
  }

  private wsOpen(ws: Socket): void {
    if (ws.data.path === "/api/connect/control") {
      this.control = ws
      this.epoch += 1
      this.heartbeatReady(ws)
      ws.send(
        JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          connectionEpoch: this.epoch,
          heartbeatMs: 25000,
          connectorLeaseMs: 75000,
        }),
      )
    }
  }

  private wsMessage(ws: Socket, message: string): void {
    if (ws.data.path === "/api/connect/bus") {
      for (const line of message.split("\n")) if (line.trim()) this.busCommand(ws, JSON.parse(line))
      return
    }
    const frame = JSON.parse(message) as Record<string, unknown>
    this.frames.push({ path: ws.data.path, frame })
    if (typeof frame.type === "string" && frame.type.startsWith("heartbeat-")) return this.heartbeatFrame(ws, frame)
    // Anything else on control is not part of the contract (fence-ack from a CLI included).
    return ws.close(1008, "scope_forbidden")
  }

  private busCommand(ws: Socket, command: Record<string, unknown>): void {
    this.frames.push({ path: ws.data.path, frame: command })
    const id = command.id
    if (Object.keys(command).length === 0) return // pong
    const reply = (body: Record<string, unknown>): void => void ws.send(JSON.stringify({ id, ...body }))
    if ("connect" in command) return reply({ connect: { client: crypto.randomUUID(), version: "1", ping: 25, pong: true } })
    if ("subscribe" in command) {
      const channel = (command.subscribe as { channel: string }).channel
      const bindingId = /^cmd:(.+)$/.exec(channel)?.[1]
      if (!bindingId || this.bindings.get(bindingId)?.state !== "active" || this.grants.get(bindingId)?.state !== "active")
        return reply({ error: { code: 103, message: "permission denied" } })
      this.subscriptions.set(channel, ws)
      return reply({ subscribe: { epoch: "e1", offset: 0 } })
    }
    if ("publish" in command) {
      const { channel, data } = command.publish as { channel: string; data: Record<string, unknown> }
      if (this.refusePublish !== undefined) {
        const code = this.refusePublish
        this.refusePublish = undefined
        return reply({ error: { code, message: "refused" } })
      }
      const bindingId = /^rep:([^:]+):[^:]+$/.exec(channel)?.[1]
      if (!bindingId || this.bindings.get(bindingId)?.state !== "active")
        return reply({ error: { code: 103, message: "permission denied" } })
      if (Object.keys(data).sort().join(",") !== "frame,lane") return reply({ error: { code: 107, message: "bad request" } })
      this.published.push({ channel, data })
      return reply({ publish: {} })
    }
    ws.close(1008, "invalid_request")
  }

  /** The phone submits a collection frame (bus-commands): forwarded on `cmd:{bindingId}` with the routing fields. */
  phoneCommand(bindingId: string, frame: Record<string, unknown>): string {
    const registration = this.registrations.get(bindingId)!
    const dispatchId = crypto.randomUUID()
    const forwarded = {
      ...frame,
      type: "request",
      operation: frame.type,
      bindingId,
      connectionEpoch: registration.connectionEpoch,
      deviceGroupId: registration.deviceGroupId,
      grantVersion: registration.grantVersion,
      dispatchId,
    }
    const ws = this.subscriptions.get(`cmd:${bindingId}`)!
    this.offset += 1
    ws.send(JSON.stringify({ push: { channel: `cmd:${bindingId}`, pub: { data: { lane: "command", frame: forwarded }, offset: this.offset } } }))
    return dispatchId
  }

  /** The service ping on every bus socket. */
  busPing(): void {
    for (const ws of new Set(this.subscriptions.values())) ws.send("{}")
  }

  /** The phone unbinds: the binding is revoked and the cmd subscription withdrawn (2001). */
  phoneRevokes(bindingId: string): void {
    const view = this.bindings.get(bindingId)!
    view.state = "revoked"
    view.revocationVersion = (view.revocationVersion as number) + 1
    this.withdraw(bindingId)
  }

  /** Withdraw the cmd subscription of a binding like the service after a revocation. */
  withdraw(bindingId: string, code = 2001): void {
    const channel = `cmd:${bindingId}`
    const ws = this.subscriptions.get(channel)
    if (!ws) return
    this.subscriptions.delete(channel)
    ws.send(JSON.stringify({ push: { channel, unsubscribe: { code, reason: "withdrawn" } } }))
  }
}
