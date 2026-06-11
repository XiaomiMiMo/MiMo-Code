import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request)))),
  )
}

function mockSpawner(handler: (cmd: string, args: readonly string[]) => string = () => "") {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
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
    }),
  )
}

function testLayer(httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  return Installation.layer.pipe(
    Layer.provide(mockHttpClient(httpHandler)),
    Layer.provide(mockSpawner((cmd, args) => (cmd === "npm" && args.join(" ") === "config get registry" ? "" : ""))),
  )
}

describe("curl upgrade channel", () => {
  test("resolves latest version for curl installations", async () => {
    const result = await Effect.runPromise(
      Installation.Service.use((svc) => svc.latest("curl")).pipe(
        Effect.provide(
          testLayer((req) => {
            expect(req.url).toStartWith("https://registry.npmjs.org/%40mimo-ai%2Fcli/")
            return new Response(JSON.stringify({ version: "2.0.0" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          }),
        ),
      ),
    )

    expect(result).toBe("2.0.0")
  })
})
