import wasmPath from "../asset/ten_vad.wasm" with { type: "file" }
import createVADModule from "../asset/ten_vad_loader.js"

const HOP_SIZE = 256
const VAD_SAMPLE_RATE = 16000

interface WasmModule {
  _ten_vad_create(handlePtr: number, hopSize: number, threshold: number): number
  _ten_vad_process(handle: number, audioDataPtr: number, audioDataLength: number, outProbabilityPtr: number, outFlagPtr: number): number
  _ten_vad_destroy(handlePtr: number): number
  _malloc(size: number): number
  _free(ptr: number): void
  HEAP16: Int16Array
  HEAPF32: Float32Array
  HEAP32: Int32Array
  HEAPU8: Uint8Array
}

let modulePromise: Promise<WasmModule> | undefined

async function loadModule(): Promise<WasmModule> {
  const wasmBinary = await Bun.file(wasmPath).arrayBuffer()
  const mod = await createVADModule({
    wasmBinary: new Uint8Array(wasmBinary),
    locateFile: () => wasmPath,
    noInitialRun: false,
    noExitRuntime: true,
  })

  if (!mod.getValue) {
    mod.getValue = (ptr: number, type: string) => {
      if (type === "i32") return mod.HEAP32[ptr >> 2]
      if (type === "float") return mod.HEAPF32[ptr >> 2]
      return 0
    }
  }

  return mod as WasmModule
}

function getModule(): Promise<WasmModule> {
  modulePromise ??= loadModule()
  return modulePromise
}

export interface VADSegment {
  audio: Int16Array
  startS: number
  endS: number
}

export class RealtimeVAD {
  private mod: WasmModule | null = null
  private handle = 0
  private handlePtr = 0
  private audioPtr = 0
  private probPtr = 0
  private flagPtr = 0

  private buffer: Int16Array = new Int16Array(0)
  private bufferOffset = 0

  private srcBuffer: Int16Array = new Int16Array(0)
  private srcBufferOffset = 0

  private active = false
  private activeStartS = 0
  private sumPositiveS = 0
  private silenceStartS: number | null = null

  private startThreshold: number
  private endThreshold: number
  private padStartS: number
  private minSilenceS: number
  private maxSegmentS: number

  private onSegment: (segment: VADSegment) => void
  private onActiveChange?: (active: boolean) => void

  constructor(opts: {
    onSegment: (segment: VADSegment) => void
    onActiveChange?: (active: boolean) => void
    startThreshold?: number
    endThreshold?: number
    padStartS?: number
    minSilenceS?: number
    maxSegmentS?: number
  }) {
    this.onSegment = opts.onSegment
    this.onActiveChange = opts.onActiveChange
    this.startThreshold = opts.startThreshold ?? 0.8
    this.endThreshold = opts.endThreshold ?? 0.7
    this.padStartS = opts.padStartS ?? 0.6
    this.minSilenceS = opts.minSilenceS ?? 0.8
    this.maxSegmentS = opts.maxSegmentS ?? 60
  }

  async init() {
    this.mod = await getModule()
    this.handlePtr = this.mod._malloc(4)
    const result = this.mod._ten_vad_create(this.handlePtr, HOP_SIZE, this.startThreshold)
    if (result !== 0) throw new Error("Failed to create VAD instance")
    this.handle = this.mod.HEAP32[this.handlePtr >> 2]
    this.audioPtr = this.mod._malloc(HOP_SIZE * 2)
    this.probPtr = this.mod._malloc(4)
    this.flagPtr = this.mod._malloc(4)

    const silence = new Int16Array(HOP_SIZE)
    for (let i = 0; i < 25; i++) this.processFrame(silence)
  }

  push(audio: Int16Array) {
    const newSrc = new Int16Array(this.srcBuffer.length + audio.length)
    newSrc.set(this.srcBuffer)
    newSrc.set(audio, this.srcBuffer.length)
    this.srcBuffer = newSrc

    const newBuf = new Int16Array(this.buffer.length + audio.length)
    newBuf.set(this.buffer)
    newBuf.set(audio, this.buffer.length)
    this.buffer = newBuf

    let processed = 0
    for (let pos = 0; pos <= this.buffer.length - HOP_SIZE; pos += HOP_SIZE) {
      processed = pos + HOP_SIZE
      const frame = this.buffer.slice(pos, pos + HOP_SIZE)
      const chunkOffsetS = (this.bufferOffset + pos) / VAD_SAMPLE_RATE
      this.processChunk(chunkOffsetS, frame)
    }

    if (processed > 0) {
      this.buffer = this.buffer.slice(processed)
      this.bufferOffset += processed
    }
  }

  flush() {
    if (!this.active) return
    const audio = this.srcBuffer.slice(0, this.srcBuffer.length)
    if (audio.length > VAD_SAMPLE_RATE * 0.2) {
      const startS = this.srcBufferOffset / VAD_SAMPLE_RATE
      const endS = startS + audio.length / VAD_SAMPLE_RATE
      this.onSegment({ audio, startS, endS })
    }
    this.onActiveChange?.(false)
    this.reset()
  }

  destroy() {
    if (!this.mod) return
    if (this.audioPtr) this.mod._free(this.audioPtr)
    if (this.probPtr) this.mod._free(this.probPtr)
    if (this.flagPtr) this.mod._free(this.flagPtr)
    if (this.handlePtr) {
      this.mod._ten_vad_destroy(this.handlePtr)
      this.mod._free(this.handlePtr)
    }
    this.mod = null
    this.handle = 0
    this.handlePtr = 0
    this.audioPtr = 0
    this.probPtr = 0
    this.flagPtr = 0
  }

  private reset() {
    this.active = false
    this.sumPositiveS = 0
    this.silenceStartS = null
    this.srcBuffer = new Int16Array(0)
    this.srcBufferOffset = this.bufferOffset
  }

  private processFrame(frame: Int16Array): number {
    if (!this.mod) return 0
    this.mod.HEAP16.set(frame, this.audioPtr / 2)
    this.mod._ten_vad_process(this.handle, this.audioPtr, HOP_SIZE, this.probPtr, this.flagPtr)
    return this.mod.HEAPF32[this.probPtr >> 2]
  }

  private processChunk(chunkOffsetS: number, frame: Int16Array) {
    const prob = this.processFrame(frame)
    const hopS = HOP_SIZE / VAD_SAMPLE_RATE

    if (!this.active) {
      if (prob >= this.startThreshold) {
        this.active = true
        this.activeStartS = chunkOffsetS
        this.sumPositiveS = hopS
        this.onActiveChange?.(true)
      } else {
        const newSrcOffset = Math.floor((chunkOffsetS - this.padStartS) * VAD_SAMPLE_RATE)
        const cutPos = newSrcOffset - this.srcBufferOffset
        if (cutPos > 0) {
          this.srcBuffer = this.srcBuffer.slice(cutPos)
          this.srcBufferOffset = newSrcOffset
        }
      }
      return
    }

    if (prob >= this.endThreshold) {
      this.silenceStartS = null
      this.sumPositiveS += hopS
    } else if (this.silenceStartS === null) {
      this.silenceStartS = chunkOffsetS
    }

    const shouldCut =
      (this.silenceStartS !== null && chunkOffsetS - this.silenceStartS >= this.minSilenceS) ||
      (chunkOffsetS - this.activeStartS >= this.maxSegmentS)

    if (shouldCut) {
      const cutSrcPos = Math.floor(chunkOffsetS * VAD_SAMPLE_RATE) - this.srcBufferOffset
      const audio = this.srcBuffer.slice(0, cutSrcPos)
      if (audio.length > VAD_SAMPLE_RATE * 0.2) {
        const startS = this.srcBufferOffset / VAD_SAMPLE_RATE
        const endS = startS + audio.length / VAD_SAMPLE_RATE
        this.onSegment({ audio, startS, endS })
      }
      this.srcBuffer = this.srcBuffer.slice(cutSrcPos)
      this.srcBufferOffset += cutSrcPos
      this.active = false
      this.sumPositiveS = 0
      this.silenceStartS = null
      this.onActiveChange?.(false)
    }
  }
}
