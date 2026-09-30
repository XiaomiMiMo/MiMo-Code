/**
 * Env vars that carry the user's credentials in cleartext.
 *
 * `MIMOCODE_AUTH_CONTENT` is the whole `auth.json` (model provider keys, OAuth refresh tokens);
 * `MIMOCODE_CONFIG_CONTENT` can embed MCP `environment` values and request `headers`.
 *
 * Neither may reach a child process the engine spawns. The bash tool and the shell part run
 * agent-authored commands, local MCP servers are third-party binaries, and both run as the user —
 * so plain inheritance means `echo $MIMOCODE_AUTH_CONTENT` exfiltrates the provider key.
 *
 * Scrub the *inherited* environment only, so a caller that puts credentials in an explicit `env` is
 * still honored — `control-plane/workspace.ts` builds its own env that way. The TUI worker keeps a
 * full copy (via `sanitizedProcessEnv`) because it is itself an engine process.
 */
const CREDENTIAL_ENV = new Set(["MIMOCODE_AUTH_CONTENT", "MIMOCODE_CONFIG_CONTENT"])

/**
 * Copy of `env` with the credential vars removed.
 *
 * Always hand the result to `spawn` explicitly: leaving `env` undefined makes the child inherit
 * the parent's environment wholesale, credentials included.
 *
 * This closes inheritance, not every path: a child running as the same user can still read
 * `/proc/<parent-pid>/environ`, so a credential that must not leak should not be in the
 * environment at all — see `Auth.inject`.
 */
export function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !CREDENTIAL_ENV.has(key)))
}

/** Credential var names, for tests and diagnostics that must not hardcode the list. */
export function credentialEnvKeys() {
  return [...CREDENTIAL_ENV]
}
