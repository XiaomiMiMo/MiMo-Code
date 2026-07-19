import { Effect } from "effect"
import { Bus } from "@/bus"
import { Flag } from "@/flag/flag"
import { ModelCall, ToolCall, AgentRequest, TryBestDetected } from "./event"
import { buildHeader, postEvents, type EventType } from "./client"
import { getInstallationID } from "./installation"

function send(event: EventType, sessionID: string, body: Record<string, unknown>) {
  return postEvents([{ H: buildHeader(event, sessionID), B: body }])
}

export const subscribe = Effect.fn("Metrics.subscribe")(function* () {
  if (!Flag.MIMOCODE_ENABLE_ANALYSIS) return
  // Touch installation_id so the file exists on first launch even before any
  // event fires. The value is intentionally NOT included in wire payloads —
  // H.instance_id is a fresh random UUID per report.
  yield* Effect.promise(() => getInstallationID().catch(() => ""))

  yield* Bus.Service.use((svc) =>
    Effect.all([
      svc.subscribeCallback(ModelCall, (e) => {
        const p = e.properties
        return send("model_call", p.sessionID, {
          finish_reason: p.finish_reason,
          ttft_ms: p.ttft_ms,
          latency_ms: p.latency_ms,
          cached_read_tokens: p.cached_read_tokens,
          model_id: p.model_id,
          provider: p.provider,
          total_tokens_in: p.total_tokens_in,
          total_tokens_out: p.total_tokens_out,
        })
      }),
      svc.subscribeCallback(ToolCall, (e) => {
        const p = e.properties
        return send("tool_call", p.sessionID, {
          tool_name: p.tool_name,
          input_bytes: p.input_bytes,
          output_bytes: p.output_bytes,
          tool_call_id: p.tool_call_id,
          tool_call_status: p.tool_call_status,
        })
      }),
      svc.subscribeCallback(AgentRequest, (e) => {
        const p = e.properties
        return send("agent_request", p.sessionID, {
          phase: p.phase,
          task_type: p.task_type,
          surface: p.surface,
          total_tokens_in: p.total_tokens_in,
          total_tokens_out: p.total_tokens_out,
          files_changed: p.files_changed,
          validation_status: p.validation_status,
        })
      }),
      svc.subscribeCallback(TryBestDetected, (e) => {
        const p = e.properties
        return send("try_best_detected", p.sessionID, {
          reason: p.reason,
          provider: p.provider,
          model_id: p.model_id,
          count: p.count,
          similarity: p.similarity,
          action: p.action,
        })
      }),
    ]),
  )
})
