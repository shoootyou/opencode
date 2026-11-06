/**
 * @spec-handoff
 * @interface createProviderConnectionController(options).auth.connectKey(key: string, label?: string): Promise<void>
 * @behavior
 *   - Calls serverSDK.api.integration.connect.key once with { integrationID, location, key, answer, label }.
 *   - label is normalizeAccountName(label): trimmed, and the property is absent (not undefined) when the name is blank or omitted.
 *   - integrationID, location, key and answer reach the server unchanged.
 *   - A rejected connect.key rejects connectKey with the same error; the controller does not catch it and keeps no key or error text in its state.
 *   - A successful connect.key is followed by the catalog refresh (finish) and onComplete.
 * @edge-cases
 *   - Whitespace-only label → no label property.
 *   - Rejection → catalogs are not refreshed and onComplete does not run.
 * @see ./account-label.ts
 * @testability controller.ts imports the provider graph (language, platform, server client, server data); each is mocked with its real exports spread and only the hook replaced. No DOM is mounted. Under the bun shim createEffect never runs, so the integration is not fetched and the key method is selected by hand.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { IntegrationConnectKeyInput } from "@opencode/client/promise"
import { createRoot } from "solid-js"

const KEY = "test-key-REDACTED-7f3a9c1e"

type ConnectInput = IntegrationConnectKeyInput

const state = {
  inputs: new Array<ConnectInput>(),
  connect: async (_input: ConnectInput): Promise<void> => undefined,
  syncs: 0,
}

const sdk = {
  api: {
    integration: {
      get: async () => ({ data: undefined }),
      connect: {
        key: (input: ConnectInput) => {
          state.inputs.push(input)

          return state.connect(input)
        },
      },
    },
  },
}

const resource = { invalidate: () => undefined, sync: async () => void state.syncs++ }

const data = { location: { integration: resource, provider: resource, model: resource } }

const language = await import("@/runtime/i18n/language")

const platform = await import("@/runtime/platform/platform")

const client = await import("@/runtime/server/client")

const current = await import("@/runtime/server/current")

mock.module("@/runtime/i18n/language", () => ({ ...language, useLanguage: () => ({ t: (key: string) => key }) }))

mock.module("@/runtime/platform/platform", () => ({ ...platform, usePlatform: () => ({}) }))

mock.module("@/runtime/server/client", () => ({ ...client, useServerSDK: () => sdk }))

mock.module("@/runtime/server/current", () => ({ ...current, useData: () => data }))

const { createProviderConnectionController } = await import("./controller")

async function mounted() {
  let completed = 0
  let dispose = () => {}

  const controller = createRoot((disposer) => {
    dispose = disposer

    return createProviderConnectionController({
      provider: () => "openai",
      directory: () => "/repo",
      onComplete: () => void completed++,
    })
  })

  // Selecting the key method with a form answer is what stores the answer connectKey forwards.
  await controller.auth.select(0, { region: "eu" })

  return { controller, dispose, completed: () => completed }
}

beforeEach(() => {
  state.inputs = []
  state.syncs = 0
  state.connect = async () => undefined
})

describe("connectKey label forwarding", () => {
  test("forwards the trimmed label", async () => {
    const { controller, dispose } = await mounted()
    await controller.auth.connectKey(KEY, "  Work  ")

    expect(state.inputs).toHaveLength(1)
    expect(state.inputs[0]?.label).toBe("Work")
    dispose()
  })

  test.each([undefined, "", "   ", "\t "])("omits the label property for %j but sends a real name", async (blank) => {
    const { controller, dispose } = await mounted()
    await controller.auth.connectKey(KEY, blank)
    await controller.auth.connectKey(KEY, "Work")

    expect(state.inputs).toHaveLength(2)
    expect("label" in state.inputs[0]!).toBe(false)
    expect(state.inputs[1]?.label).toBe("Work")
    dispose()
  })

  test("forwards key, integrationID, location and answer unchanged next to the label", async () => {
    const { controller, dispose } = await mounted()
    await controller.auth.connectKey(KEY, "Work")

    expect(state.inputs[0]).toEqual({
      integrationID: "openai",
      location: { directory: "/repo" },
      key: KEY,
      answer: { region: "eu" },
      label: "Work",
    })
    dispose()
  })
})

describe("connectKey completion and failure", () => {
  test("refreshes the catalogs and completes after a successful save", async () => {
    const { controller, completed, dispose } = await mounted()
    await controller.auth.connectKey(KEY, "Work")

    expect(state.inputs[0]?.label).toBe("Work")
    expect(state.syncs).toBe(3)
    expect(completed()).toBe(1)
    dispose()
  })

  test("rejects with the server error, without refreshing or completing", async () => {
    const failure = new Error("gateway rejected the request")
    state.connect = async () => {
      throw failure
    }

    const { controller, completed, dispose } = await mounted()

    await expect(controller.auth.connectKey(KEY, "Work")).rejects.toBe(failure)
    expect(state.inputs).toHaveLength(1)
    expect(state.inputs[0]?.label).toBe("Work")
    expect(state.syncs).toBe(0)
    expect(completed()).toBe(0)
    dispose()
  })

  test("keeps neither the key nor an error text in the controller state after a rejection", async () => {
    state.connect = async () => {
      throw new Error(`invalid key ${KEY}`)
    }

    const { controller, dispose } = await mounted()
    await controller.auth.connectKey(KEY, "Work").catch(() => undefined)

    // Positive witnesses: the request carried the key and the label.
    expect(state.inputs[0]?.key).toBe(KEY)
    expect(state.inputs[0]?.label).toBe("Work")
    expect(controller.auth.error()).toBeUndefined()
    expect(controller.auth.state()).not.toBe("error")
    expect(JSON.stringify([controller.auth.error(), controller.auth.state()])).not.toContain(KEY)
    dispose()
  })
})
