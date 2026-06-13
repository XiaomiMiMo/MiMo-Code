import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

type PathLike = string | URL
type NodeBunFile = {
  path: string
  text(): Promise<string>
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  exists(): Promise<boolean>
  stream(): ReturnType<typeof createReadStream>
}

const toPath = (input: PathLike | NodeBunFile): string => {
  if (typeof input === "string") return input
  if (input instanceof URL) return fileURLToPath(input)
  return input.path
}

function file(input: PathLike): NodeBunFile {
  const path = toPath(input)
  return {
    path,
    async text() {
      return fs.readFile(path, "utf8")
    },
    async json() {
      return JSON.parse(await this.text())
    },
    async arrayBuffer() {
      const buffer = await fs.readFile(path)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    },
    async exists() {
      try {
        await fs.access(path)
        return true
      } catch {
        return false
      }
    },
    stream() {
      return createReadStream(path)
    },
  }
}

async function write(destination: PathLike | NodeBunFile, input: string | ArrayBuffer | ArrayBufferView | Blob) {
  const path = toPath(destination)
  let data: string | NodeJS.ArrayBufferView

  if (typeof input === "string") {
    data = input
  } else if (input instanceof Blob) {
    data = Buffer.from(await input.arrayBuffer())
  } else if (input instanceof ArrayBuffer) {
    data = Buffer.from(input)
  } else {
    data = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }

  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, data)
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength
}

const globals = globalThis as typeof globalThis & {
  Bun?: {
    file: typeof file
    write: typeof write
    stringWidth: (value: string) => number
  }
}

globals.Bun ??= {
  file,
  write,
  stringWidth(value: string) {
    return Array.from(value).length
  },
}
