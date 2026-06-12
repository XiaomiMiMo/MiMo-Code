import { describe, expect, test } from "bun:test"
import {
  claudeSettingsEnvSources,
  resolveClaudeApiKey,
  resolveClaudeEnvValue,
} from "../../../src/cli/cmd/tui/util/claude-settings"

describe("claude settings import", () => {
  test("uses ANTHROPIC_AUTH_TOKEN from settings env when API key is absent", () => {
    const envs = claudeSettingsEnvSources({
      env: {
        ANTHROPIC_AUTH_TOKEN: "auth-token",
      },
    })

    expect(resolveClaudeApiKey((name) => resolveClaudeEnvValue(envs, name, {}))).toBe("auth-token")
  })

  test("prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN", () => {
    const envs = claudeSettingsEnvSources({
      env: {
        ANTHROPIC_API_KEY: "api-key",
        ANTHROPIC_AUTH_TOKEN: "auth-token",
      },
    })

    expect(resolveClaudeApiKey((name) => resolveClaudeEnvValue(envs, name, {}))).toBe("api-key")
  })
})
