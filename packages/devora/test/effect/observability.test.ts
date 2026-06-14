import { afterEach, describe, expect, test } from "bun:test"
import { resource } from "../../src/effect/observability"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const devoraClient = process.env.DEVORA_CLIENT

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (devoraClient === undefined) delete process.env.DEVORA_CLIENT
  else process.env.DEVORA_CLIENT = devoraClient
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=devora,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "devora",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=devora,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["devora.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.DEVORA_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "devora.client=web,service.instance.id=override,service.namespace=devora"

    expect(resource().attributes).toMatchObject({
      "devora.client": "cli",
      "service.namespace": "devora",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
  })
})
