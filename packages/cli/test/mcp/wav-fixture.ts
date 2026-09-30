/**
 * A real 16 kHz mono 16-bit PCM WAV, built here rather than committed as a binary
 * fixture so the header stays inspectable. `seconds` scales the data chunk.
 *
 * Deliberately a PLAIN module, not a `.test.ts`. When this helper lived in
 * `sampling.test.ts` and `sampling-e2e.test.ts` imported it from there, Bun
 * attributed all 20 of that file's tests to the IMPORTER: the e2e file reported
 * 36 tests (its own 16 plus the 20 it pulled in) and `sampling.test.ts` reported
 * 0 of its own in any combined run. Every test still executed exactly once, but
 * per-file totals were meaningless. A plain module keeps the attribution honest.
 */
export function wav(seconds: number) {
  const sampleRate = 16_000
  const samples = Math.round(sampleRate * seconds)
  const dataBytes = samples * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write("RIFF", 0, "ascii")
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write("WAVE", 8, "ascii")
  buffer.write("fmt ", 12, "ascii")
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write("data", 36, "ascii")
  buffer.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), 44 + i * 2)
  }
  return buffer
}
