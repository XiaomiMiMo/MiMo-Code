import { Effect, Stream } from "effect"

export class ByteLimitError extends Error {
  readonly _tag = "ByteLimitError"
  constructor() {
    super("Read exceeds its byte budget")
  }
}

/** Enforce the limit while reading, before concatenation or decoding. */
export function readLimited<E, R>(stream: Stream.Stream<Uint8Array, E, R>, maxBytes: number) {
  return Effect.gen(function* () {
    const chunks: Uint8Array[] = []
    let size = 0
    yield* Stream.runForEach(stream, (chunk) =>
      Effect.gen(function* () {
        size += chunk.byteLength
        if (size > maxBytes) yield* Effect.fail(new ByteLimitError())
        chunks.push(chunk)
      }),
    )
    return Buffer.concat(chunks, size)
  })
}
