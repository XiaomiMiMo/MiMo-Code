import z from "zod"
import { BusEvent } from "@/bus/bus-event"

export const ModelCall = BusEvent.define(
  "metrics.model_call",
  z.object({
    sessionID: z.string(),
    finish_reason: z.string(),
    ttft_ms: z.number().optional(),
    latency_ms: z.number(),
    cached_read_tokens: z.number(),
    model_id: z.string(),
    provider: z.string(),
    total_tokens_in: z.number(),
    total_tokens_out: z.number(),
  }),
)

export const ToolCall = BusEvent.define(
  "metrics.tool_call",
  z.object({
    sessionID: z.string(),
    tool_name: z.string(),
    input_bytes: z.number(),
    output_bytes: z.number(),
    tool_call_id: z.string(),
    tool_call_status: z.enum(["success", "error", "cancelled"]),
  }),
)

export const AgentRequest = BusEvent.define(
  "metrics.agent_request",
  z.object({
    sessionID: z.string(),
    phase: z.string(),
    task_type: z.string(),
    surface: z.string(),
    total_tokens_in: z.number(),
    total_tokens_out: z.number(),
    files_changed: z.number(),
    validation_status: z.string(),
  }),
)

export const TryBestDetected = BusEvent.define(
  "metrics.try_best_detected",
  z.object({
    sessionID: z.string(),
    reason: z.enum(["edit_repeat", "bash_retry", "action_streak"]),
    provider: z.string(),
    model_id: z.string(),
    count: z.number().int().positive(),
    similarity: z.number().optional(),
    action: z.enum(["edit", "verify"]).optional(),
  }),
)
