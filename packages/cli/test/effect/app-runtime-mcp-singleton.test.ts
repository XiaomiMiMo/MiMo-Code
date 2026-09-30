import { expect, test } from "bun:test"
import path from "path"
import { Cause, Context, Effect, Exit, Layer, Option } from "effect"

import { Actor } from "../../src/actor/spawn"
import { Command } from "../../src/command"
import { MCP } from "../../src/mcp"
import { SessionPrompt } from "../../src/session/prompt"

// Guards the MCP single-instance ownership chain built in src/effect/app-runtime.ts:
//
//   Actor.appLayer <- SessionPrompt.appLayer <- Command.appLayer <- MCP.defaultLayer
//
// Before that chain existed, MCP, Command, SessionPrompt and Actor were four
// independent AppLayer leaves, three of which provided MCP.defaultLayer
// themselves. That shape still built only ONE MCP instance, because Layer.effect
// memoises on the layer's own identity and every ManagedRuntime here shares the
// single memo map from src/effect/memo-map.ts — so single-instance behaviour was
// incidental, resting on memo identity rather than on the graph. The chain makes
// the ownership explicit instead. The regressions this file exists to catch are
// someone re-adding a self-provided MCP inside any of the three `appLayer`
// variants, or adding a second MCP.defaultLayer leaf — either of which would
// break the memo assumption the old shape silently depended on.
//
// These tests deliberately never build the real MCP.defaultLayer and never build
// the full AppLayer: booting real MCP is precisely the behaviour under guard.
// Layer.build below also intentionally does NOT reuse the process-wide memoMap
// from src/effect/memo-map.ts — a fresh memo map per build keeps this test from
// resolving against (or polluting) instances another test already memoized.

/**
 * Stand-in for MCP.Service. Every property access throws, so if any layer in the
 * chain calls an MCP method while merely *building*, this test fails loudly
 * instead of silently letting a real transport get established later.
 */
function makeCountingMcpLayer() {
  let built = 0
  const layer = Layer.effect(
    MCP.Service,
    Effect.sync(() => {
      built++
      return MCP.Service.of(
        new Proxy(
          {},
          {
            get(_target, property) {
              throw new Error(`stub MCP.Service.${String(property)} used during layer build`)
            },
          },
        ) as never,
      )
    }),
  )
  return { layer, builds: () => built }
}

test("app graph's MCP chain composes, and one MCP instance serves all three consumers", async () => {
  const mcp = makeCountingMcpLayer()

  // Same shape as src/effect/app-runtime.ts, with only MCP.defaultLayer swapped
  // for the counting stub.
  const chain = Actor.appLayer.pipe(
    Layer.provideMerge(
      SessionPrompt.appLayer.pipe(Layer.provideMerge(Command.appLayer.pipe(Layer.provideMerge(mcp.layer)))),
    ),
  )

  const context = await Effect.runPromise(Effect.scoped(Layer.build(chain)))

  // Exactly one MCP construction for Command + SessionPrompt + Actor together.
  expect(mcp.builds()).toBe(1)

  // provideMerge (not provide) keeps MCP.Service in the AppLayer output so
  // server routes can still resolve it, alongside the three consumers.
  // getOption is used rather than get so the throwing stub is never dereferenced.
  expect(Option.isSome(Context.getOption(context, MCP.Service))).toBe(true)
  expect(Option.isSome(Context.getOption(context, Command.Service))).toBe(true)
  expect(Option.isSome(Context.getOption(context, SessionPrompt.Service))).toBe(true)
  expect(Option.isSome(Context.getOption(context, Actor.Service))).toBe(true)
})

// Each appLayer must leave its MCP-bearing dependency *unmet* so the root graph
// supplies it once. Asserting the specific missing service is what makes this a
// real guard: if someone re-adds Layer.provide(MCP.defaultLayer) to Command or
// SessionPrompt, or Layer.provide(SessionPrompt.defaultLayer) to Actor, the
// layer becomes self-sufficient, the build succeeds, and this test fails.
//
// Actor is listed against SessionPrompt rather than MCP because Actor never
// consumes MCP.Service directly; it reaches MCP only through SessionPrompt, so
// SessionPrompt.defaultLayer is the edge that would smuggle a second MCP in.
const unmetDependency = [
  { name: "Command.appLayer", layer: Command.appLayer, missing: "@opencode/MCP" },
  { name: "SessionPrompt.appLayer", layer: SessionPrompt.appLayer, missing: "@opencode/MCP" },
  { name: "Actor.appLayer", layer: Actor.appLayer, missing: "@opencode/SessionPrompt" },
] as const

for (const { name, layer, missing } of unmetDependency) {
  test(`${name} does not provide its own ${missing}`, async () => {
    // The cast is load-bearing: these layers legitimately still declare an unmet
    // requirement, which is exactly the property asserted here.
    const build = Layer.build(layer as unknown as Layer.Layer<never, never, never>)
    const exit = await Effect.runPromiseExit(Effect.scoped(build))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toInclude(`Service not found: ${missing}`)
  })
}

test("app-runtime.ts wires MCP.defaultLayer exactly once", async () => {
  // Structural companion to the behavioural tests above: they cannot see an
  // extra independent `MCP.defaultLayer` leaf added to AppLayer's mergeAll,
  // because building the real AppLayer is off-limits here.
  const source = await Bun.file(path.join(import.meta.dir, "../../src/effect/app-runtime.ts")).text()
  const occurrences = source.match(/MCP\.defaultLayer/g) ?? []

  expect(occurrences).toHaveLength(1)
})
