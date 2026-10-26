import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Stream } from "effect"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { AppFileSystem } from "../../file"

export interface ReviewClient {
  submitPlan(plan: string): Effect.Effect<any, Error>
  submitDiff(diff: string, description: string): Effect.Effect<any, Error>
}

export const makeReviewClient = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fsys = yield* AppFileSystem.Service

  const runPlannotator = (mode: string, input: any) =>
    Effect.gen(function* () {
      const plannotatorBin = process.env.PLANNOTATOR_BIN || "plannotator"
      const readyFile = path.join(
        tmpdir(),
        `plannotator-mimo-${process.pid}-${Date.now()}-${randomUUID()}.jsonl`
      )

      const env = {
        ...process.env,
        PLANNOTATOR_ORIGIN: "mimo-code",
        PLANNOTATOR_READY_FILE: readyFile,
      }

      const proc = ChildProcess.make(plannotatorBin, [mode], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      })
      
      const handle = yield* spawner.spawn(proc)
      
      // Gửi input qua stdin
      const inputStr = JSON.stringify(input)
      yield* Stream.fromIterable([Buffer.from(inputStr)]).pipe(
        Stream.run(handle.stdin)
      )

      const [stdout, stderr] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr))
        ],
        { concurrency: 2 }
      )

      const exitCode = yield* handle.exitCode
      
      // Dọn dẹp ready file
      if (yield* fsys.existsSafe(readyFile)) {
        yield* fsys.remove(readyFile).pipe(Effect.ignore)
      }

      if (exitCode !== 0) {
        return yield* Effect.fail(new Error(`Plannotator failed (exit ${exitCode}): ${stderr}`))
      }

      try {
        return JSON.parse(stdout)
      } catch (e) {
        return yield* Effect.fail(new Error(`Failed to parse Plannotator output: ${stdout}`))
      }
    }).pipe(Effect.scoped)

  return {
    submitPlan: (plan: string) => runPlannotator("opencode-plan", { plan }),
    submitDiff: (diff: string, description: string) => 
      runPlannotator("opencode-review", { arguments: "--git", description, diff }),
  }
})
