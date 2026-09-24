/** Model identities only: callers must not pass the provider name as an identity. */
export function isMimoModel(id: string) {
  return /(^|[/_-])mimo(?:[.-]|$)/i.test(id)
}
