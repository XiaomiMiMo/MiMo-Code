import { afterAll, spyOn } from "bun:test"

// Exercise the real storage adapter against an isolated S3 HTTP fixture.
// Never use developer credentials or write to a deployed bucket during tests.
const env = {
  OPENCODE_STORAGE_ADAPTER: "s3",
  OPENCODE_STORAGE_BUCKET: "test-bucket",
  OPENCODE_STORAGE_REGION: "us-east-1",
  OPENCODE_STORAGE_ACCESS_KEY_ID: "test-key",
  OPENCODE_STORAGE_SECRET_ACCESS_KEY: "test-secret",
}
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
Object.assign(process.env, env)

const objects = new Map<string, string>()
const original = globalThis.fetch
const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== "https://s3.us-east-1.amazonaws.com") return original(input, init)
  if (url.searchParams.get("list-type") === "2") {
    const keys = [...objects.keys()]
      .sort()
      .filter((key) => key.startsWith(url.searchParams.get("prefix") ?? ""))
      .filter((key) => key > (url.searchParams.get("start-after") ?? ""))
      .slice(0, Number(url.searchParams.get("max-keys") ?? 1000))
    return new Response(`<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}</ListBucketResult>`)
  }
  const key = decodeURIComponent(url.pathname.slice("/test-bucket/".length))
  if (request.method === "PUT") {
    objects.set(key, await request.text())
    return new Response(null)
  }
  if (request.method === "DELETE") {
    objects.delete(key)
    return new Response(null, { status: 204 })
  }
  const value = objects.get(key)
  return new Response(value ?? null, { status: value == null ? 404 : 200 })
}) as typeof globalThis.fetch)

afterAll(() => {
  fetch.mockRestore()
  Object.entries(previous).forEach(([key, value]) => {
    if (value == null) delete process.env[key]
    if (value != null) process.env[key] = value
  })
})
