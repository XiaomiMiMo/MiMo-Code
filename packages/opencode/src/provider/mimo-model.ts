/** Model identities only: callers must not pass the provider name as an identity. */
export function isMimoModel(id: string) {
  const leaf = id.split("/").at(-1)?.toLowerCase()
  return leaf === "v2.6-flash-test" || /(^|[/_-])mimo(?:[.-]|$)/i.test(id)
}
