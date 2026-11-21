// One authorized device group of a binding: three content lanes opened with
// one deviceGroupId under one grant, plus the dispatcher that serves them.
//
// Each lane's fence is made durable before it is acknowledged. A fence that no
// longer matches this group's grant (revoked binding or grant, a new grant
// version, another epoch) stops all output of the group first; the service then
// confirms the revocation or closes the lane, and the runtime rebuilds.

import type { ChannelCredential, ConnectApi, GrantView, Lane } from "./api"
import { Dispatcher } from "./dispatcher"
import type { ConnectHttp } from "./http"
import { ContentLane, type Fence } from "./lane"
import type { AgentBackend } from "./ports"
import type { HeartbeatRuntime } from "./heartbeat"
import type { Dial } from "./socket"
import type { StateFile } from "./state"
import type { Submissions } from "./submissions"

export const LANES: Lane[] = ["command", "state", "text"]

export type GroupContext = {
  api: ConnectApi
  http: ConnectHttp
  origin: () => string
  dial: Dial
  heartbeats: HeartbeatRuntime
  backend: AgentBackend
  submissions: Submissions
  state: StateFile
  clock?: () => number
}

/** The grant a group serves; a recovery group carries the stored version and no scopes. */
export type GroupGrant = Pick<GrantView, "bindingId" | "grantVersion" | "connectionEpoch" | "scopes">

export type GroupEnd = {
  reason: string
  /** The service confirmed a revocation on at least one lane. */
  revoked: boolean
}

export class DeviceGroup {
  readonly deviceGroupId = crypto.randomUUID()
  private readonly lanes = new Map<Lane, ContentLane>()
  private dispatcher: Dispatcher | undefined
  private ended = false
  /** Recovery waits for every lane to finish its own revoked fence instead of ending at the first close. */
  private recovering = false
  /** All three lanes are ready and the group serves the phone. */
  ready = false

  constructor(
    private readonly context: GroupContext,
    readonly grant: GroupGrant,
    private readonly onEnded: (end: GroupEnd) => void,
  ) {}

  /** Issue the lane credentials and open all three lanes; resolves once every lane is ready. */
  async open(): Promise<void> {
    const credentials = await this.credentials()
    const canSend = (this.grant.scopes as string[]).includes("sessions:send")
    this.dispatcher = new Dispatcher(
      {
        bindingId: this.grant.bindingId,
        deviceGroupId: this.deviceGroupId,
        connectionEpoch: this.grant.connectionEpoch,
        grantVersion: this.grant.grantVersion,
        canSend,
      },
      this.context.backend,
      this.context.submissions,
      (lane, frame) => this.lanes.get(lane)?.send(frame) ?? false,
      this.context.clock,
    )
    this.build(credentials)
    try {
      await Promise.all([...this.lanes.values()].map((lane) => lane.open()))
      this.ready = !this.ended
    } catch (error) {
      this.close()
      throw error
    }
  }

  /**
   * For a binding revoked while this installation was away: attach with the
   * recovery credentials so the service can record that this connector stopped.
   * Resolves true once every lane confirmed the revocation.
   */
  async confirmRevocation(): Promise<boolean> {
    this.recovering = true
    this.build(await this.credentials())
    await Promise.allSettled([...this.lanes.values()].map((lane) => lane.open()))
    const confirmed = [...this.lanes.values()].some((lane) => lane.revoked)
    this.close()
    return confirmed
  }

  close(): void {
    if (this.ended) return
    this.end({ reason: "closed_by_client", revoked: false }, false)
  }

  private async credentials(): Promise<ChannelCredential[]> {
    const credentials: ChannelCredential[] = []
    for (const lane of LANES) {
      credentials.push(
        await this.context.api.channelToken(this.grant.bindingId, {
          deviceGroupId: this.deviceGroupId,
          lane,
          grantVersion: this.grant.grantVersion,
          connectionEpoch: this.grant.connectionEpoch,
        }),
      )
    }
    return credentials
  }

  private build(credentials: ChannelCredential[]): void {
    for (const credential of credentials) {
      this.lanes.set(
        credential.lane,
        new ContentLane(credential.lane, credential, this.context.http, this.context.origin, this.context.dial, this.context.heartbeats, {
          onFence: (lane, fence) => this.gate(lane, fence),
          onFrame: (lane, frame) => {
            if (lane === "command") this.dispatcher?.handle(frame)
          },
          onClosed: (lane, reason) => {
            if (this.ended || this.recovering) return
            this.end({ reason, revoked: this.lanes.get(lane)?.revoked ?? false }, true)
          },
        }),
      )
    }
  }

  private async gate(lane: Lane, fence: Fence): Promise<void> {
    const allowed =
      fence.state === "active" &&
      fence.grantState === "active" &&
      fence.grantVersion === this.grant.grantVersion &&
      fence.connectionEpoch === this.grant.connectionEpoch
    // Close admission before anything is persisted or acknowledged.
    if (!allowed) this.dispatcher?.close()
    await this.context.state.update((state) => {
      state.gates[`${fence.bindingId}:${lane}`] = {
        fenceId: fence.fenceId,
        grantVersion: fence.grantVersion,
        revocationVersion: fence.revocationVersion,
        connectionEpoch: fence.connectionEpoch,
        active: allowed,
      }
    })
  }

  private end(end: GroupEnd, notify: boolean): void {
    this.ended = true
    this.ready = false
    this.dispatcher?.close()
    for (const lane of this.lanes.values()) lane.close()
    if (notify) this.onEnded(end)
  }
}
