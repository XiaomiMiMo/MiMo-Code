// In-process stand-in for the Connect service, strict enough to catch wire
// mistakes: it verifies every device proof (ES256 over the JWS, claims, nonce
// single use, body digest), enforces the version / profile / request-id header
// rules and answers with the real envelope. Tests script business state on it.

import type { Server, ServerWebSocket } from "bun"
import { base64url, canonical, fromBase64url, hex, sha256 } from "../src/json"
import { CONTENT_PROTOCOL } from "../src/lane"
import { CONTROL_PROTOCOL } from "../src/control"

type Socket = ServerWebSocket<{ path: string; lane?: string }>

export type FakeOptions = {
  environment?: string
  accountSessionId?: string
  accessToken?: string
}

export class FakeConnect {
  readonly environment: string
  readonly accountSessionId: string
  readonly accessToken: string
  private server!: Server<{ path: string; lane?: string }>
  private nonces = new Map<string, { method: string; path: string; thumbprint: string }>()
  /** Every HTTP request, for assertions. */
  readonly requests: { method: string; path: string; headers: Headers; body?: unknown }[] = []
  /** Scripted failures: path -> [status, code, retryAfter?] consumed once. */
  readonly failNext = new Map<string, [number, string, string?]>()
  /** Mutations applied to the next envelope for `path` (to break the wire on purpose). */
  readonly tamper = new Map<string, (response: Response) => Response>()
  devices = new Map<string, { name: string; thumbprint: string }>()
  epoch = 0
  discovery: "cli" | "empty" | "missing" = "cli"
  challenges = new Map<
    string,
    { code: string; status: string; request: null | { requestId: string; phoneName: string } }
  >()
  decisions = new Map<string, { status: string; bindingId: string | null }>()
  grants = new Map<string, Record<string, unknown>>()
  /** Last fence state sent per lane path: a revoked fence ends with fence-confirmed on ack. */
  private fenceStates = new Map<string, "active" | "revoked">()
  bindings = new Map<string, Record<string, unknown>>()
  control: Socket | undefined
  lanes = new Map<string, Socket>()
  /** Frames received on WS, by path. */
  readonly frames: { path: string; frame: Record<string, unknown> }[] = []
  /** When false, content lanes stop after fence (to test fence handling). */
  sendTransportReady = true

  constructor(options: FakeOptions = {}) {
    this.environment = options.environment ?? "china-test"
    this.accountSessionId = options.accountSessionId ?? crypto.randomUUID()
    this.accessToken = options.accessToken ?? "A".repeat(43)
  }

  get origin(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  account() {
    return {
      origin: this.origin,
      environment: this.environment,
      accountSessionId: this.accountSessionId,
      accessToken: this.accessToken,
    }
  }

  start(): this {
    this.server = Bun.serve<{ path: string; lane?: string }>({
      port: 0,
      fetch: (request, server) => this.handle(request, server),
      websocket: {
        open: (ws) => this.wsOpen(ws),
        message: (ws, message) => this.wsMessage(ws, String(message)),
        close: (ws) => {
          if (ws === this.control) this.control = undefined
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
    server: Server<{ path: string; lane?: string }>,
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
      return this.error(id, scripted[0], scripted[1], "1.0", scripted[2])
    }
    if (request.headers.get("Authorization") !== `Bearer ${this.accessToken}`) {
      return this.error(id, 401, "unauthenticated", null)
    }
    const version = request.headers.get("Mimo-Connect-Version")
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
        contract: "connector-discovery-v1",
        profiles: this.discovery === "cli" ? ["cli-connector-v1"] : [],
      })
    }
    if (path === "/api/connect/device-challenges") {
      const nonce = crypto.randomUUID()
      this.nonces.set(nonce, { method: body.method, path: body.path, thumbprint: body.keyThumbprint })
      return respond({
        nonce,
        accountSessionId: this.accountSessionId,
        environment: this.environment,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    }
    // Everything below is a CLI actor endpoint: profile required, proof required.
    if (profile !== "cli-connector-v1") return this.error(id, 426, "protocol_incompatible", null)
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
    return respond(this.business(request.method, path, body, url), this.businessStatus)
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
        contract: "connector-bindings-v1",
        deviceId: list[1],
        bindings: page.map((binding) => ({ binding, phoneName: "Pixel" })),
        nextCursor: next,
      }
    }
    const meta = path.match(/^\/api\/connect\/bindings\/([^/]+)\/content-upgrade-metadata$/)
    if (meta) {
      const grant = this.grants.get(meta[1])
      return {
        bindingId: meta[1],
        connectorId: [...this.devices.keys()][0],
        targetKind: grant ? "cli" : null,
        protocolVersion: grant ? 4 : null,
        grantVersion: (grant?.grantVersion as number) ?? 0,
      }
    }
    const grant = path.match(/^\/api\/connect\/bindings\/([^/]+)\/content-grant$/)
    if (grant && method === "GET") return this.grants.get(grant[1])
    if (grant && method === "PUT") {
      const view = {
        protocolVersion: 4,
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
    const token = path.match(/^\/api\/connect\/bindings\/([^/]+)\/content-channel-tokens\/cli$/)
    if (token) {
      return {
        protocolVersion: 4,
        targetKind: "cli",
        bindingId: token[1],
        connectorId: [...this.devices.keys()][0],
        role: "cli",
        lane: body.lane,
        deviceGroupId: body.deviceGroupId,
        grantVersion: body.grantVersion,
        connectionEpoch: body.connectionEpoch,
        revocationVersion: 0,
        scopes: this.bindings.get(token[1])?.state === "revoked" ? [] : (this.grants.get(token[1])?.scopes ?? []),
        token: base64url(crypto.getRandomValues(new Uint8Array(32))).slice(0, 43),
        audience: `${this.origin}/api/connect/content-relay/${body.lane}`,
        expiresAt: Date.now() + 3_600_000,
      }
    }
    const binding = path.match(/^\/api\/connect\/bindings\/([^/]+)(\/revoke)?$/)
    if (binding) {
      const view = this.bindings.get(binding[1])!
      if (binding[2]) {
        view.state = "revoked"
        view.relayFence = "pending"
        view.revocationVersion = (view.revocationVersion as number) + 1
        setTimeout(() => this.revokeLive(binding[1]), 10)
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
      claims.accountSessionId !== this.accountSessionId ||
      claims.environment !== this.environment ||
      !(claims.exp > claims.iat && claims.exp - claims.iat <= 60 && Math.abs(now - claims.iat) <= 60)
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
    return new Response(JSON.stringify({ contractVersion: version, requestId: id, error: { code } }), {
      status,
      headers,
    })
  }

  // ---- WebSocket ----------------------------------------------------------

  private async upgrade(request: Request, server: Server<{ path: string; lane?: string }>, path: string) {
    const expected = path === "/api/connect/control" ? CONTROL_PROTOCOL : CONTENT_PROTOCOL
    if (request.headers.get("Sec-WebSocket-Protocol") !== expected) return new Response(null, { status: 426 })
    if (request.headers.get("Mimo-Connect-Version") || request.headers.get("Mimo-Connect-Profile")) {
      return new Response(null, { status: 400 })
    }
    const thumbprint = await this.verifyProof("GET", path, undefined, request.headers.get("X-Device-Proof"))
    const deviceId = request.headers.get("X-Device-Id")
    if (!thumbprint || !deviceId || this.devices.get(deviceId)?.thumbprint !== thumbprint) {
      return new Response(null, { status: 401 })
    }
    const lane = path.split("/").pop()
    server.upgrade(request, { data: { path, lane }, headers: { "Sec-WebSocket-Protocol": expected } })
    return undefined
  }

  private wsOpen(ws: Socket): void {
    if (ws.data.path === "/api/connect/control") {
      this.control = ws
      this.epoch += 1
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
    const frame = JSON.parse(message) as Record<string, unknown>
    this.frames.push({ path: ws.data.path, frame })
    if (ws.data.path === "/api/connect/control") {
      if (frame.type === "heartbeat")
        ws.send(JSON.stringify({ protocolVersion: 1, type: "pong", connectionEpoch: this.epoch }))
      return
    }
    if (frame.type === "attach") {
      this.lanes.set(ws.data.lane!, ws)
      const binding = this.bindings.get(frame.bindingId as string)
      this.fence(ws.data.lane!, frame, binding?.state === "revoked" ? "revoked" : "active")
      return
    }
    if (frame.type === "fence-ack" && this.fenceStates.get(ws.data.lane!) === "revoked") {
      const attach = this.lastAttach(ws.data.path)
      ws.send(
        JSON.stringify({
          protocolVersion: 4,
          type: "fence-confirmed",
          bindingId: attach.bindingId,
          targetKind: "cli",
          deviceGroupId: attach.deviceGroupId,
          grantVersion: attach.grantVersion,
          revocationVersion: 1,
          connectionEpoch: attach.connectionEpoch,
        }),
      )
      this.confirmedRevocations.add(attach.bindingId as string)
      const view = this.bindings.get(attach.bindingId as string)
      if (view) view.relayFence = "complete"
      ws.close(1008, "binding_revoked")
      return
    }
    if (frame.type === "fence-ack" && this.sendTransportReady) {
      const attach = this.lastAttach(ws.data.path)
      ws.send(
        JSON.stringify({
          protocolVersion: 4,
          type: "transport-ready",
          channelId: crypto.randomUUID(),
          bindingId: attach.bindingId,
          targetKind: "cli",
          deviceGroupId: attach.deviceGroupId,
          lane: ws.data.lane,
          grantVersion: attach.grantVersion,
          revocationVersion: 0,
          connectionEpoch: attach.connectionEpoch,
        }),
      )
    }
    if (frame.type === "ping") ws.send(JSON.stringify({ protocolVersion: 4, type: "pong" }))
  }

  private lastAttach(path: string): Record<string, unknown> {
    return this.frames.findLast((f) => f.path === path && f.frame.type === "attach")!.frame
  }

  /** Bindings whose revocation a connector confirmed on a lane. */
  readonly confirmedRevocations = new Set<string>()

  /** Re-fence every live lane of a binding as revoked, like the service after a revoke. */
  revokeLive(bindingId: string): void {
    for (const [lane] of this.lanes) {
      const attach = this.lastAttach(`/api/connect/content-relay/${lane}`)
      if (attach.bindingId === bindingId) this.fence(lane, attach, "revoked")
    }
  }

  /** Send a fence on a lane (initial after attach, or a re-fence from a test). */
  fence(lane: string, attach: Record<string, unknown>, state: "active" | "revoked" = "active"): string {
    const fenceId = crypto.randomUUID()
    this.fenceStates.set(lane, state)
    this.lanes.get(lane)!.send(
      JSON.stringify({
        protocolVersion: 4,
        type: "fence",
        bindingId: attach.bindingId,
        targetKind: "cli",
        deviceGroupId: attach.deviceGroupId,
        grantVersion: attach.grantVersion,
        revocationVersion: 0,
        connectionEpoch: attach.connectionEpoch,
        state,
        grantState: state,
        fenceId,
      }),
    )
    return fenceId
  }

  sendOnLane(lane: string, frame: Record<string, unknown>): void {
    this.lanes.get(lane)!.send(JSON.stringify(frame))
  }
}
