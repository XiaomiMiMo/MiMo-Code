/**
 * Shared contract for the instance middleware's directory whitelist rejection.
 *
 * The rejection itself is correct policy (a client may not point the server at a
 * directory outside its cwd), but a client has to be able to RECOGNISE it: the
 * generated SDK throws the parsed response body, with no status code attached, so
 * a 403 is otherwise indistinguishable from a transport failure and gets treated
 * as fatal. `code` is the stable discriminator — never match on `error` prose.
 *
 * Leaf module on purpose: the TUI imports the guard, so this file must not pull
 * the server's instance/bootstrap graph into the TUI bundle.
 */
export const DIRECTORY_DENIED_CODE = "directory_not_allowed"

export function isDirectoryDeniedError(e: unknown): e is { code: string; error: string; directory?: string } {
  return typeof e === "object" && e !== null && "code" in e && e.code === DIRECTORY_DENIED_CODE
}
