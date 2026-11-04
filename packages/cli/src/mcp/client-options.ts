import { NATIVE_APP_POLICY_CAPABILITY } from "./native-app-policy"

export const TURN_LIFECYCLE_CAPABILITY = "com.xiaomi.mimo/turn-lifecycle"
export const TURN_LIFECYCLE_VERSION = 1

/** Capabilities advertised by the actual MCP client during initialization. */
export const CLIENT_OPTIONS = {
  capabilities: {
    // Sampling tools and context are intentionally not advertised.
    sampling: {},
    elicitation: { form: {} },
    experimental: {
      [TURN_LIFECYCLE_CAPABILITY]: { version: TURN_LIFECYCLE_VERSION },
      [NATIVE_APP_POLICY_CAPABILITY]: { version: 1 },
    },
  },
}
