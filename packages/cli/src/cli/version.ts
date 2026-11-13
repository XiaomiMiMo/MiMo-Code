export function isVersionRequest(args: string[]) {
  const separator = args.indexOf("--")
  const options = separator === -1 ? args : args.slice(0, separator)
  return options.includes("--version") || options.includes("-v")
}
