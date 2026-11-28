// The phone connector of one local agent installation.
//
// Lifecycle: sign-in material and a protected store are required up front;
// the installation key is registered once per account; the control socket is
// the online lease and every reconnect starts a new connection generation in
// which each locally confirmed binding gets a fresh grant and a bus device group.
// Pairing always ends with an explicit local decision. Turning the connector
// off only goes offline: bindings stay until the user unpairs.

import { ConnectApi, type BindingView, type GrantView, type Scopes } from "./api"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { ControlChannel } from "./control"
import { DeviceGroup, type GroupContext } from "./group"
import { HeartbeatRuntime } from "./heartbeat"
import { ACCOUNT_REJECTION_CODES, ConnectError, ConnectHttp, type AccountSession, type ClientInfo } from "./http"
import { InstanceLock } from "./lock"
import { generateDeviceKey, importDeviceKey, type DeviceKey, type PrivateJwk } from "./proof"
import type { AgentBackend, SecretStore } from "./ports"
import { wsDial, type Dial } from "./socket"
import { StateFile, type Consent, type ConnectorState } from "./state"
import { Submissions } from "./submissions"

const KEY_SECRET = "device-key"
const PAIRING_POLL_MS = 2_000
const PENDING_TTL_MS = 10 * 60_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** A generation that stayed up this long resets the reconnect backoff. */
const STABLE_MS = 60_000
/** How often the account is read again, so a newer credential of the same sign-in is picked up. */
const ACCOUNT_CHECK_MS = 30_000
const READ_ONLY: Consent["scopes"] = ["sessions:list", "sessions:read"]
const READ_SEND: Consent["scopes"] = ["sessions:list", "sessions:read", "sessions:send"]

export type ConnectorAccount = AccountSession & {
  /** Stable account subject; local consent is only valid for the subject that gave it. */
  subject: string
}

export type UnavailableReason =
  | "secure_storage_unavailable"
  | "not_signed_in"
  | "account_rejected"
  /** The account is not on the service's admission list (internal testing). */
  | "not_admitted"
  | "service_without_cli"
  | "discovery_failed"
  | "protocol_incompatible"
  | "state_unreadable"
  | "registration_conflict"
  /** Another MiMo Code process on this computer is already connected. */
  | "in_use"

export type PhoneStatus = { bindingId: string; phoneName: string; canSend: boolean; connected: boolean }
export type PairingStatus = { code: string; expiresAt: string; phoneName?: string }

export type ConnectorStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "unavailable"; reason: UnavailableReason }
  | { state: "reconnecting"; retryInMs: number; phones: PhoneStatus[]; reason?: "service_unreachable" }
  | { state: "online"; phones: PhoneStatus[]; pairing?: PairingStatus }

export type PairingOutcome = "approved" | "rejected" | "expired" | "cancelled" | "failed" | "protocol_incompatible"

export interface ConnectorHost {
  /** Ask the local user whether this phone may connect; undefined rejects it. */
  confirmPairing(request: { phoneName: string; code: string }): Promise<{ canSend: boolean } | undefined>
  status(status: ConnectorStatus): void
}

export type ConnectorOptions = {
  backend: AgentBackend
  secrets: SecretStore
  stateFile: string
  account: () => Promise<ConnectorAccount | undefined>
  client: ClientInfo
  /** Name shown on the phone (1..80 characters). */
  name: string
  host: ConnectorHost
  dial?: Dial
  clock?: () => number
  /** How often a shown pairing code is polled for a claim. */
  pairingPollMs?: number
}

type GrantAttempt = { expectedVersion: number; scopes: Scopes; sent: boolean }

type Generation = {
  control: ControlChannel
  epoch: number
  startedAt: number
  ended: boolean
  grants: Map<string, GrantAttempt>
  exposing: Set<string>
}

type Runtime = {
  account: ConnectorAccount
  http: ConnectHttp
  api: ConnectApi
  deviceId: string
  /** The single heartbeat owner of every socket of this runtime. */
  heartbeats: HeartbeatRuntime
}

export class Connector {
  private readonly state: StateFile
  private readonly submissions: Submissions
  private readonly dial: Dial
  private readonly clock: () => number
  private runtime: Runtime | undefined
  private generation: Generation | undefined
  private readonly groups = new Map<string, DeviceGroup>()
  private lastPhones: PhoneStatus[] = []
  private readonly retries = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>()
  private enabled = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  private pairing: { challengeId: string; status: PairingStatus; cancelled: boolean } | undefined
  private current: ConnectorStatus = { state: "off" }
  /** Bumped by start and stop, so a boot that outlived a stop does nothing. */
  private session = 0
  private readonly lock: InstanceLock
  /** Reconciles and pairing settlement run one at a time: each reads and rewrites the consents. */
  private serial: Promise<unknown> = Promise.resolve()
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined
  private accountTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: ConnectorOptions) {
    this.state = new StateFile(options.stateFile, options.secrets, options.clock)
    this.submissions = new Submissions(options.backend, this.state, options.clock)
    this.dial = options.dial ?? wsDial
    this.clock = options.clock ?? Date.now
    this.lock = new InstanceLock(`${options.stateFile}.lock`)
  }

  get status(): ConnectorStatus {
    return this.current
  }

  /** Go online. Resolves after the first connection attempt (online, reconnecting or unavailable). */
  async start(): Promise<void> {
    if (this.enabled) return
    this.enabled = true
    const session = ++this.session
    this.publish({ state: "starting" })
    await mkdir(path.dirname(this.options.stateFile), { recursive: true, mode: 0o700 })
    if (!(await this.lock.acquire())) {
      if (session !== this.session) return
      this.enabled = false
      return this.publish({ state: "unavailable", reason: "in_use" })
    }
    await this.boot(session)
  }

  /**
   * Read the account and installation again and connect. Every reconnect boots,
   * so an expired or replaced sign-in is noticed instead of retried forever.
   */
  private async boot(session: number): Promise<void> {
    if (!this.enabled || session !== this.session) return
    let runtime: Runtime | UnavailableReason
    try {
      runtime = await this.prepare()
    } catch (error) {
      // Service or network trouble before connecting is retried like a lost connection.
      if (session === this.session) {
        const network = error instanceof ConnectError && error.code === "network"
        this.lost(error, network ? "service_unreachable" : undefined)
      }
      return
    }
    if (!this.enabled || session !== this.session) return
    if (typeof runtime === "string") return this.disable(runtime)
    this.runtime = runtime
    this.watchAccount(runtime, session)
    await this.connect(session)
  }

  private async disable(reason: UnavailableReason): Promise<void> {
    if (!this.enabled) return
    const session = this.session
    this.enabled = false
    this.endGeneration()
    clearInterval(this.accountTimer)
    clearTimeout(this.reconnectTimer)
    this.runtime = undefined
    await this.lock.release()
    if (session === this.session) this.publish({ state: "unavailable", reason })
  }

  /** Keep the runtime on the current credential; a changed or ended sign-in starts over. */
  private watchAccount(runtime: Runtime, session: number): void {
    clearInterval(this.accountTimer)
    this.accountTimer = setInterval(async () => {
      const next = await this.options.account().catch(() => runtime.account)
      if (session !== this.session || this.runtime !== runtime) return
      const same =
        next &&
        next.subject === runtime.account.subject &&
        next.environment === runtime.account.environment &&
        next.origin === runtime.account.origin &&
        next.userId === runtime.account.userId
      if (same) runtime.account = next
      else if (this.generation) this.lost()
    }, ACCOUNT_CHECK_MS)
  }

  /** Go offline. Bindings and consents are kept; phones see this computer as offline. */
  async stop(): Promise<void> {
    this.enabled = false
    this.session += 1
    clearTimeout(this.reconnectTimer)
    clearInterval(this.accountTimer)
    if (this.pairing) this.pairing.cancelled = true
    this.endGeneration()
    this.runtime = undefined
    await this.lock.release()
    this.publish({ state: "off" })
  }

  /**
   * Show a pairing code and wait for a phone to claim it. A claim is only
   * approved after the host's local confirmation.
   */
  async pair(): Promise<PairingOutcome> {
    const runtime = this.runtime
    const generation = this.generation
    if (!runtime || !generation || !this.live(generation) || generation.epoch === 0 || this.pairing) return "failed"
    let challenge: Awaited<ReturnType<ConnectApi["createPairingCode"]>>
    try {
      challenge = await runtime.api.createPairingCode(generation.epoch)
    } catch (error) {
      if (!this.live(generation)) return "cancelled"
      return error instanceof ConnectError && error.code === "protocol_incompatible" ? "protocol_incompatible" : "failed"
    }
    if (!this.live(generation) || this.pairing) return "failed"
    const pairing = (this.pairing = {
      challengeId: challenge.challengeId,
      status: { code: challenge.code, expiresAt: challenge.expiresAt },
      cancelled: false,
    })
    this.refresh()
    try {
      return await this.awaitClaim(runtime, generation, pairing)
    } finally {
      if (this.pairing === pairing) this.pairing = undefined
      this.refresh()
    }
  }

  /** Withdraw the code being shown. */
  async cancelPairing(): Promise<void> {
    const pairing = this.pairing
    if (!pairing) return
    pairing.cancelled = true
    const epoch = this.generation?.epoch
    if (this.runtime && epoch)
      await this.runtime.api.cancelPairingCode(pairing.challengeId, epoch).catch(() => undefined)
  }

  /** Remove a phone: the binding is revoked on the service and the local consent dropped. */
  async unpair(bindingId: string): Promise<void> {
    const runtime = this.runtime
    if (!runtime) throw new ConnectError("offline")
    await runtime.api.revoke(bindingId)
    await this.forget(bindingId)
  }

  // ---- setup ----------------------------------------------------------------

  private async prepare(): Promise<Runtime | UnavailableReason> {
    if (!(await this.options.secrets.available().catch(() => false))) return "secure_storage_unavailable"
    const account = await this.options.account().catch(() => undefined)
    if (!account) return "not_signed_in"
    let state: ConnectorState
    try {
      state = await this.state.read()
    } catch {
      return "state_unreadable"
    }
    const key = await this.deviceKey()
    if (!key) return "secure_storage_unavailable"
    let deviceId: string | undefined
    const installation = state.installation
    if (
      installation &&
      installation.origin === account.origin &&
      installation.environment === account.environment &&
      installation.subject === account.subject
    ) {
      deviceId = installation.deviceId
    }
    const current = { account }
    const http = new ConnectHttp({
      account: () => current.account,
      key,
      deviceId: () => deviceId,
      client: this.options.client,
    })
    const api = new ConnectApi(http)
    try {
      if (!(await api.offersCliProfile())) return "service_without_cli"
      if (!deviceId) {
        // Registration is idempotent per account and key, so a lost answer is simply repeated.
        const registered = await api.register(this.options.name)
        deviceId = registered.deviceId
        await this.state.update((next) => {
          next.installation = {
            origin: account.origin,
            environment: account.environment,
            subject: account.subject,
            deviceId: registered.deviceId,
          }
        })
      }
    } catch (error) {
      if (error instanceof ConnectError) {
        if (error.code === "discovery_failed" || error.code === "protocol_incompatible") return error.code
        if (error.code === "allowlist_denied") return "not_admitted"
      }
      if (error instanceof ConnectError && ACCOUNT_REJECTION_CODES.has(error.code)) return "account_rejected"
      // This key is already registered for the account under another name.
      if (error instanceof ConnectError && error.code === "conflict") return "registration_conflict"
      throw error
    }
    return {
      get account() {
        return current.account
      },
      set account(next) {
        current.account = next
      },
      http,
      api,
      deviceId,
      heartbeats: new HeartbeatRuntime(),
    }
  }

  private async deviceKey(): Promise<DeviceKey | undefined> {
    let stored: string | undefined
    try {
      stored = await this.options.secrets.get(KEY_SECRET)
    } catch {
      // A store that cannot be read must never lead to a replacement key.
      return undefined
    }
    if (stored) return importDeviceKey(JSON.parse(stored) as PrivateJwk)
    const { key, privateJwk } = await generateDeviceKey()
    await this.options.secrets.set(KEY_SECRET, JSON.stringify(privateJwk))
    // Read back: a store that silently drops writes must not leave an unrecoverable key in use.
    return (await this.options.secrets.get(KEY_SECRET)) ? key : undefined
  }

  // ---- connection generations -------------------------------------------------

  private async connect(session: number): Promise<void> {
    const runtime = this.runtime
    if (!this.enabled || !runtime || session !== this.session) return
    const generation: Generation = {
      control: undefined!,
      epoch: 0,
      startedAt: this.clock(),
      ended: false,
      grants: new Map(),
      exposing: new Set(),
    }
    generation.control = new ControlChannel(runtime.http, () => runtime.account.origin, this.dial, runtime.heartbeats, {
      onClosed: () => {
        if (this.generation === generation) this.lost()
      },
    })
    this.generation = generation
    try {
      generation.epoch = await generation.control.open()
    } catch (error) {
      if (this.generation === generation) this.lost(error)
      return
    }
    this.refresh()
    await this.reconcileUntilDone(runtime, generation, 0)
  }

  /** Reconcile, retrying with backoff while the generation lives: nothing else would bring phones online. */
  private async reconcileUntilDone(runtime: Runtime, generation: Generation, attempt: number): Promise<void> {
    try {
      await this.reconcile(runtime, generation)
    } catch (error) {
      if (!this.live(generation)) return
      if (error instanceof ConnectError && error.code === "protocol_incompatible") {
        return this.disable("protocol_incompatible")
      }
      const cooldown = error instanceof ConnectError ? (error.retryAfterMs ?? 0) : 0
      const wait = Math.max(
        Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt),
        cooldown,
        runtime.http.cooldownRemainingMs(),
      )
      clearTimeout(this.reconcileTimer)
      this.reconcileTimer = setTimeout(() => void this.reconcileUntilDone(runtime, generation, attempt + 1), wait)
    }
  }

  private lost(error?: unknown, reason?: "service_unreachable"): void {
    if (error instanceof ConnectError && error.code === "protocol_incompatible") {
      void this.disable("protocol_incompatible")
      return
    }
    const generation = this.generation
    const stable = generation && generation.epoch > 0 && this.clock() - generation.startedAt >= STABLE_MS
    this.endGeneration()
    if (!this.enabled) return
    if (stable) this.reconnectAttempts = 0
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.reconnectAttempts)
    const cooldown = error instanceof ConnectError ? (error.retryAfterMs ?? 0) : 0
    const wait = Math.max(backoff, cooldown, this.runtime?.http.cooldownRemainingMs() ?? 0)
    this.reconnectAttempts += 1
    this.publish({ state: "reconnecting", retryInMs: wait, phones: this.lastPhones, ...(reason ? { reason } : {}) })
    clearInterval(this.accountTimer)
    this.runtime = undefined
    const session = this.session
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => void this.boot(session), wait)
  }

  private endGeneration(): void {
    const generation = this.generation
    this.generation = undefined
    if (this.pairing) this.pairing.cancelled = true
    clearTimeout(this.reconcileTimer)
    for (const retry of this.retries.values()) clearTimeout(retry.timer)
    this.retries.clear()
    for (const group of this.groups.values()) group.close()
    this.groups.clear()
    if (generation && !generation.ended) {
      generation.ended = true
      generation.control.close()
    }
  }

  private live(generation: Generation): boolean {
    return this.enabled && this.generation === generation && !generation.ended
  }

  // ---- bindings ---------------------------------------------------------------

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work)
    this.serial = run.catch(() => undefined)
    return run
  }

  /** Bring the service's bindings and the local consents into agreement for this generation. */
  private reconcile(runtime: Runtime, generation: Generation): Promise<void> {
    return this.exclusive(() => this.reconcileNow(runtime, generation))
  }

  private async reconcileNow(runtime: Runtime, generation: Generation): Promise<void> {
    await this.settlePending(runtime)
    const bindings = await runtime.api.bindings(runtime.deviceId)
    if (!this.live(generation)) return
    const known = new Set(bindings.map(({ binding }) => binding.bindingId))
    const state = await this.state.read()
    for (const { binding } of bindings) {
      const consent = state.consents[binding.bindingId]
      if (binding.state === "active") {
        if (consent && this.consentHolds(consent, runtime, binding))
          void this.expose(runtime, generation, binding.bindingId)
        continue
      }
      // A revoked binding is never served again; its local records go.
      if (consent || this.groups.has(binding.bindingId)) await this.forget(binding.bindingId)
    }
    // Consents for bindings the service no longer lists cannot be exposed again.
    await this.state.update((next) => {
      for (const bindingId of Object.keys(next.consents)) {
        if (!known.has(bindingId) && next.consents[bindingId].subject === runtime.account.subject) {
          delete next.consents[bindingId]
        }
      }
    })
    this.refresh()
  }

  private consentHolds(consent: Consent, runtime: Runtime, binding: BindingView): boolean {
    return (
      consent.subject === runtime.account.subject &&
      consent.environment === runtime.account.environment &&
      consent.bindingId === binding.bindingId &&
      consent.phoneId === binding.phoneId &&
      consent.connectorId === runtime.deviceId &&
      binding.connectorId === runtime.deviceId &&
      consent.revocationVersion === binding.revocationVersion
    )
  }

  /** Revalidate consent, settle the generation's grant, then attach one bus group. */
  private async expose(runtime: Runtime, generation: Generation, bindingId: string): Promise<void> {
    if (!this.live(generation) || this.groups.has(bindingId) || generation.exposing.has(bindingId)) return
    generation.exposing.add(bindingId)
    let grant: GrantView
    try {
      const binding = await runtime.api.binding(bindingId)
      if (!this.live(generation)) return
      if (binding.state === "revoked") return void this.retire(runtime, generation, bindingId)
      const consent = (await this.state.read()).consents[bindingId]
      if (!this.live(generation) || !consent || !this.consentHolds(consent, runtime, binding)) return
      grant = await this.grantFor(runtime, generation, binding, consent.scopes)
    } catch (error) {
      if (!this.live(generation)) return
      if (error instanceof ConnectError && error.code === "protocol_incompatible") {
        return void this.disable("protocol_incompatible")
      }
      if (error instanceof ConnectError && error.code === "binding_revoked") {
        return void this.retire(runtime, generation, bindingId)
      }
      return this.retry(runtime, generation, bindingId)
    } finally {
      generation.exposing.delete(bindingId)
    }
    if (!this.live(generation)) return
    const group = new DeviceGroup(this.groupContext(runtime), grant, (end) => {
      if (this.groups.get(bindingId) !== group) return
      this.groups.delete(bindingId)
      this.refresh()
      if (end.incompatible) return void this.disable("protocol_incompatible")
      if (end.revoked) return void this.retire(runtime, generation, bindingId)
      this.retry(runtime, generation, bindingId)
    })
    this.groups.set(bindingId, group)
    try {
      await group.open()
      clearTimeout(this.retries.get(bindingId)?.timer)
      this.retries.delete(bindingId)
      this.refresh()
    } catch (error) {
      if (this.groups.get(bindingId) === group) {
        this.groups.delete(bindingId)
        if (error instanceof ConnectError && error.code === "protocol_incompatible") {
          return void this.disable("protocol_incompatible")
        }
        this.retry(runtime, generation, bindingId)
      }
    }
  }

  private async grantFor(runtime: Runtime, generation: Generation, binding: BindingView, scopes: Scopes) {
    const { bindingId, revocationVersion } = binding
    let attempt = generation.grants.get(bindingId)
    if (!attempt) {
      const meta = await runtime.api.upgradeMetadata(bindingId, generation.epoch)
      if (meta.connectorId !== runtime.deviceId) throw new ConnectError("protocol")
      // Freeze the proposed write. No subsequent attempt in this epoch can choose a newer version.
      attempt = { expectedVersion: meta.grantVersion, scopes, sent: false }
      generation.grants.set(bindingId, attempt)
    }
    const { expectedVersion } = attempt
    if (!this.live(generation) || scopes.join(",") !== attempt.scopes.join(",")) {
      throw new ConnectError("grant_unavailable")
    }
    let grant: GrantView
    if (attempt.sent) {
      // This is either a bus-only rebuild or a read-back after an ambiguous PUT.
      grant = await runtime.api.grant(bindingId)
    } else {
      attempt.sent = true
      try {
        grant = await runtime.api.publishGrant(bindingId, {
          connectionEpoch: generation.epoch,
          expectedVersion,
          state: "active",
          scopes,
        })
      } catch (error) {
        // No request during a local cooldown; proof_expired is a pre-execution rejection.
        // In either case keep the original expectedVersion.
        if (error instanceof ConnectError && (error.code === "cooldown" || error.code === "proof_expired")) {
          attempt.sent = false
        }
        throw error
      }
    }
    if (
      grant.state !== "active" ||
      grant.connectorId !== runtime.deviceId ||
      grant.revocationVersion !== revocationVersion ||
      grant.connectionEpoch !== generation.epoch ||
      grant.grantVersion !== expectedVersion + 1 ||
      grant.scopes.join(",") !== scopes.join(",")
    ) {
      throw new ConnectError("grant_unavailable")
    }
    return grant
  }

  private retry(runtime: Runtime, generation: Generation, bindingId: string): void {
    if (!this.live(generation)) return
    const retry = this.retries.get(bindingId) ?? { attempts: 0 }
    clearTimeout(retry.timer)
    const wait = Math.max(
      Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** retry.attempts),
      runtime.http.cooldownRemainingMs(),
    )
    retry.attempts += 1
    retry.timer = setTimeout(() => void this.expose(runtime, generation, bindingId), wait)
    this.retries.set(bindingId, retry)
  }

  /** A binding was revoked while this connector served it: stop exposing it at once. */
  private async retire(runtime: Runtime, generation: Generation, bindingId: string): Promise<void> {
    if (!this.live(generation)) return
    await this.forget(bindingId)
    if (this.live(generation)) await this.reconcileUntilDone(runtime, generation, 0)
  }

  private async forget(bindingId: string): Promise<void> {
    clearTimeout(this.retries.get(bindingId)?.timer)
    this.retries.delete(bindingId)
    this.groups.get(bindingId)?.close()
    this.groups.delete(bindingId)
    await this.state.update((state) => {
      delete state.consents[bindingId]
    })
    this.refresh()
  }

  private groupContext(runtime: Runtime): GroupContext {
    return {
      api: runtime.api,
      http: runtime.http,
      origin: () => runtime.account.origin,
      dial: this.dial,
      backend: this.options.backend,
      submissions: this.submissions,
      clock: this.options.clock,
    }
  }

  // ---- pairing ---------------------------------------------------------------

  private async awaitClaim(
    runtime: Runtime,
    generation: Generation,
    pairing: { challengeId: string; status: PairingStatus; cancelled: boolean },
  ): Promise<PairingOutcome> {
    const expiresAt = Date.parse(pairing.status.expiresAt)
    while (!pairing.cancelled && this.clock() < expiresAt) {
      await Bun.sleep(this.options.pairingPollMs ?? PAIRING_POLL_MS)
      if (pairing.cancelled) break
      const status = await runtime.api.pairingStatus(pairing.challengeId).catch(() => undefined)
      if (pairing.cancelled || !this.live(generation)) return "cancelled"
      if (!status) continue
      if (status.status === "open") continue
      if (status.status !== "claimed" || !status.request) {
        return status.status === "approved" || status.status === "rejected" || status.status === "cancelled"
          ? status.status
          : "expired"
      }
      pairing.status = { ...pairing.status, phoneName: status.request.phoneName }
      this.refresh()
      return this.decide(runtime, generation, pairing, status.request)
    }
    return pairing.cancelled ? "cancelled" : "expired"
  }

  private async decide(
    runtime: Runtime,
    generation: Generation,
    pairing: { challengeId: string; status: PairingStatus; cancelled: boolean },
    request: { requestId: string; phoneName: string },
  ): Promise<PairingOutcome> {
    const answer = await this.options.host
      .confirmPairing({ phoneName: request.phoneName, code: pairing.status.code })
      .catch(() => undefined)
    if (pairing.cancelled || !this.live(generation)) return "cancelled"
    if (!answer) {
      await runtime.api.decide(request.requestId, "reject", generation.epoch).catch(() => undefined)
      return "rejected"
    }
    // The confirmation is durable before approval, so a crash in between still
    // ends with a consent for the binding the service created.
    await this.state.update((state) => {
      state.pending[request.requestId] = {
        phoneName: request.phoneName,
        subject: runtime.account.subject,
        environment: runtime.account.environment,
        connectorId: runtime.deviceId,
        scopes: answer.canSend ? READ_SEND : READ_ONLY,
        confirmedAt: this.clock(),
      }
    })
    if (pairing.cancelled || !this.live(generation)) return "cancelled"
    const decision = await runtime.api.decide(request.requestId, "approve", generation.epoch).catch(() => undefined)
    // Settles the confirmation into a consent and exposes the binding, also when the approve answer was lost.
    await this.reconcile(runtime, generation).catch(() => undefined)
    const bindingId =
      decision?.bindingId ??
      (await runtime.api
        .pairingRequest(request.requestId)
        .then((result) => (result.status === "approved" ? result.bindingId : null))
        .catch(() => null))
    if (!bindingId) return "failed"
    return (await this.state.read()).consents[bindingId] ? "approved" : "failed"
  }

  /** Turn recorded confirmations into consents once their pairing request is decided. */
  private async settlePending(runtime: Runtime): Promise<void> {
    const pending = (await this.state.read()).pending
    for (const [requestId, confirmation] of Object.entries(pending)) {
      const request = await runtime.api.pairingRequest(requestId).catch((error) => {
        // Gone for good: the confirmation can never become a binding.
        if (error instanceof ConnectError && error.status === 404) return null
        return undefined
      })
      if (request === undefined) continue
      // Still undecided: an approval may be in flight. Codes live 5 minutes, so an older one is abandoned.
      const undecided = request && (request.status === "open" || request.status === "claimed")
      if (undecided && this.clock() - confirmation.confirmedAt < PENDING_TTL_MS) continue
      const binding =
        request?.status === "approved" && request.bindingId
          ? await runtime.api.binding(request.bindingId).catch(() => undefined)
          : undefined
      if (request?.status === "approved" && !binding) continue
      await this.state.update((state) => {
        delete state.pending[requestId]
        if (binding?.state === "active" && binding.connectorId === confirmation.connectorId)
          state.consents[binding.bindingId] = {
            ...confirmation,
            bindingId: binding.bindingId,
            phoneId: binding.phoneId,
            revocationVersion: binding.revocationVersion,
          }
      })
    }
  }

  // ---- status ----------------------------------------------------------------

  private refresh(): void {
    const generation = this.generation
    if (!this.enabled || !generation || generation.epoch === 0) return
    void this.state
      .read()
      .then((state) => {
        if (this.generation !== generation) return
        this.lastPhones = this.phones(state)
        this.publish({
          state: "online",
          phones: this.lastPhones,
          ...(this.pairing ? { pairing: this.pairing.status } : {}),
        })
      })
      .catch(() => undefined)
  }

  private phones(state: ConnectorState | undefined): PhoneStatus[] {
    const consents = state?.consents ?? {}
    const subject = this.runtime?.account.subject
    return Object.values(consents)
      .filter((consent) => consent.subject === subject)
      .map((consent) => ({
        bindingId: consent.bindingId,
        phoneName: consent.phoneName,
        canSend: (consent.scopes as string[]).includes("sessions:send"),
        connected: this.groups.get(consent.bindingId)?.ready ?? false,
      }))
  }

  private publish(status: ConnectorStatus): void {
    this.current = status
    this.options.host.status(status)
  }
}
