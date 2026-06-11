import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(handler: (cmd: string, args: readonly string[]) => string = () => "") {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const output = handler(std?.command ?? "", std?.args ?? [])
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output ? Stream.make(encoder.encode(output)) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string,
) {
  return Installation.layer.pipe(Layer.provide(mockHttpClient(httpHandler)), Layer.provide(mockSpawner(spawnHandler)))
}

describe("installation", () => {
  describe("method", () => {
    test("detects npm when @mimocode/cli-ai is in npm list output", async () => {
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "npm" && args.includes("-g")) return "@mimocode/cli-ai@1.0.0"
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.method()).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("npm")
    })

    test("detects pnpm when @mimocode/cli-ai is in pnpm list output", async () => {
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "pnpm" && args.includes("-g")) return "@mimocode/cli-ai@1.0.0"
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.method()).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("pnpm")
    })

    test("detects bun when @mimocode/cli-ai is in bun pm ls output", async () => {
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "bun" && args.includes("-g")) return "@mimocode/cli-ai@1.0.0"
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.method()).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("bun")
    })

    test("returns unknown when no package manager has @mimocode/cli-ai", async () => {
      const layer = testLayer(
        () => jsonResponse({}),
        () => "",
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.method()).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("unknown")
    })
  })

  describe("latest", () => {
    test("reads version from xiaomi npm registry for npm method", async () => {
      const layer = testLayer(
        (req) => {
          expect(req.url).toContain("pkgs.d.xiaomi.net")
          expect(req.url).toContain(encodeURIComponent("@mimocode/cli-ai"))
          return jsonResponse({ version: "1.5.0" })
        },
        () => "",
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("npm")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.5.0")
    })

    test("reads version from xiaomi npm registry for pnpm method", async () => {
      const layer = testLayer(() => jsonResponse({ version: "1.6.0" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("pnpm")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.6.0")
    })

    test("reads version from xiaomi npm registry for bun method", async () => {
      const layer = testLayer(() => jsonResponse({ version: "1.7.0" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("bun")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.7.0")
    })

    test("dies for unsupported channels (brew/choco/scoop/curl/unknown)", async () => {
      const layer = testLayer(() => jsonResponse({}))
      const unsupported: Installation.Method[] = ["brew", "choco", "scoop", "curl", "unknown"]

      for (const method of unsupported) {
        const result = Effect.runPromise(
          Installation.Service.use((svc) => svc.latest(method)).pipe(Effect.provide(layer)),
        )
        await expect(result).rejects.toThrow("unsupported update channel")
      }
    })
  })

  describe("upgrade", () => {
    test("runs npm install with correct package and registry", async () => {
      let capturedCmd = ""
      let capturedArgs: readonly string[] = []
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "npm" && args.includes("install")) {
            capturedCmd = cmd
            capturedArgs = args
          }
          return ""
        },
      )

      await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("npm", "2.0.0")).pipe(Effect.provide(layer)),
      )
      expect(capturedCmd).toBe("npm")
      expect(capturedArgs).toContain("-g")
      expect(capturedArgs).toContain("@mimocode/cli-ai@2.0.0")
      expect(capturedArgs.find((a) => a.startsWith("--registry="))).toContain("pkgs.d.xiaomi.net")
    })

    test("runs pnpm install with correct package and registry", async () => {
      let capturedArgs: readonly string[] = []
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "pnpm" && args.includes("install")) capturedArgs = args
          return ""
        },
      )

      await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("pnpm", "2.0.0")).pipe(Effect.provide(layer)),
      )
      expect(capturedArgs).toContain("@mimocode/cli-ai@2.0.0")
      expect(capturedArgs.find((a) => a.startsWith("--registry="))).toContain("pkgs.d.xiaomi.net")
    })

    test("runs bun install with correct package and registry", async () => {
      let capturedArgs: readonly string[] = []
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          if (cmd === "bun" && args.includes("install")) capturedArgs = args
          return ""
        },
      )

      await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("bun", "2.0.0")).pipe(Effect.provide(layer)),
      )
      expect(capturedArgs).toContain("@mimocode/cli-ai@2.0.0")
      expect(capturedArgs.find((a) => a.startsWith("--registry="))).toContain("pkgs.d.xiaomi.net")
    })

    test("fails for unknown method", async () => {
      const layer = testLayer(() => jsonResponse({}))

      const result = Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("unknown", "2.0.0")).pipe(Effect.provide(layer)),
      )
      await expect(result).rejects.toThrow()
    })
  })
})
