export async function GET() {
  return Bun.file(new URL("../../../../sdk/openapi.json", import.meta.url)).json()
}
