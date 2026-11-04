import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import z from "zod/v4"
import { McpElicitation } from "./elicitation"

export const NATIVE_APP_POLICY_CAPABILITY = "com.xiaomi.mimo/native-app-policy"
const TURN = "com.xiaomi.mimo/turn-lifecycle"
const request = z.object({
  method: z.literal(`${NATIVE_APP_POLICY_CAPABILITY}/read`),
  params: z.object({
    _meta: z.object({ [TURN]: z.object({ sessionId: z.string().min(1), turnId: z.string().min(1) }).passthrough() }).passthrough(),
  }).passthrough(),
})

/** App actions still require the ordinary session-scoped user confirmation. */
export function serve(client: Client) {
  client.setRequestHandler(request, async (message, extra) => {
    const scope = message.params._meta[TURN]
    if (!McpElicitation.ownsTurn(client, scope.sessionId, scope.turnId, extra.signal)) {
      throw new McpError(ErrorCode.InvalidRequest, "Native app policy requires the active owning turn")
    }
    const rules = { defaultAccess: "allow" as const, bundleIdentifiers: {} }
    return { policy: { enabled: true, allowPersistentApproval: false, requirements: rules, config: rules } }
  })
}
