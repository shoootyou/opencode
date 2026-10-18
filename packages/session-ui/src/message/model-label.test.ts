/**
 * @spec-handoff
 * @interface assistantModelLabel(model: ModelLabelRef | undefined, providers: ProviderNames | undefined, formatVariant: FormatModelVariant): string
 * @behavior
 *   - Resolves model display names only when message providerID and id are primitive strings.
 *   - Delegates one sanitized shared label, including its variant, to the app formatter.
 * @edge-cases
 *   - Missing catalog entries preserve raw provider/model IDs.
 *   - Dirty catalogs and unreadable references degrade to a missing display name without throwing.
 * @see ./message-content.tsx
 */
import { describe, expect, test } from "bun:test"
import { assistantModelLabel } from "./model-label"

const providers = new Map([
  [
    "team",
    {
      name: "Team Display Name",
      models: {
        reviewer: { name: "Review Model", modelID: "vendor/model-v1" },
        "vendor/model-v1": { name: "API ID Decoy", modelID: "vendor/model-v1" },
        "reviewer-second": { name: "Second Alias", modelID: "vendor/model-v1" },
      },
    },
  ],
])

describe("session-ui assistantModelLabel", () => {
  test("uses the catalog ID rather than modelID when an aliased message model has an API-ID decoy", () => {
    expect(
      assistantModelLabel(
        { providerID: "team", id: "reviewer" },
        providers,
        (model, variant) => `${model} (${variant})`,
      ),
    ).toBe("team/Review Model")
  })

  test("uses the matching alias name for each catalog ID sharing one API modelID", () => {
    expect(
      assistantModelLabel(
        { providerID: "team", id: "reviewer-second" },
        providers,
        (model, variant) => `${model} (${variant})`,
      ),
    ).toBe("team/Second Alias")
  })

  test("falls back independently for a missing provider map, provider, or model", () => {
    const formatVariant = (model: string, variant: string) => `${model} (${variant})`

    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, undefined, formatVariant)).toBe("team/reviewer")
    expect(assistantModelLabel({ providerID: "other", id: "reviewer" }, providers, formatVariant)).toBe(
      "other/reviewer",
    )
    expect(assistantModelLabel({ providerID: "team", id: "missing" }, providers, formatVariant)).toBe("team/missing")
  })

  test("uses the real ui.message.modelVariant callback with the complete label and capitalized variant", () => {
    const keys: string[] = []
    const i18n = {
      t(key: string, values: { model: string; variant: string }) {
        keys.push(key)
        return `${values.model} (${values.variant})`
      },
    }

    expect(
      assistantModelLabel({ providerID: "team", id: "reviewer", variant: "thinking" }, providers, (model, variant) =>
        i18n.t("ui.message.modelVariant", { model, variant }),
      ),
    ).toBe("team/Review Model (Thinking)")
    expect(keys).toEqual(["ui.message.modelVariant"])
  })

  test("keeps an unknown model's non-default variant and omits empty/default variants", () => {
    const formatVariant = (model: string, variant: string) => `${model} (${variant})`

    expect(assistantModelLabel({ providerID: "team", id: "missing", variant: "high" }, providers, formatVariant)).toBe(
      "team/missing (High)",
    )
    expect(assistantModelLabel({ providerID: "team", id: "missing", variant: "" }, providers, formatVariant)).toBe(
      "team/missing",
    )
    expect(
      assistantModelLabel({ providerID: "team", id: "missing", variant: "default" }, providers, formatVariant),
    ).toBe("team/missing")
  })

  test("returns an empty label for a missing model or identity without producing a separator", () => {
    const formatVariant = (model: string, variant: string) => `${model} (${variant})`

    expect(assistantModelLabel(undefined, providers, formatVariant)).toBe("")
    expect(assistantModelLabel({ providerID: "team" }, providers, formatVariant)).toBe("")
    expect(assistantModelLabel({ id: "reviewer" }, providers, formatVariant)).toBe("")
    expect(assistantModelLabel({ providerID: "", id: "reviewer" }, providers, formatVariant)).toBe("")
    expect(assistantModelLabel({ providerID: "team", id: "" }, providers, formatVariant)).toBe("")
  })

  test("does not resolve prototype-key IDs through inherited record properties", () => {
    const formatVariant = (model: string, variant: string) => `${model} (${variant})`

    expect(assistantModelLabel({ providerID: "team", id: "__proto__" }, providers, formatVariant)).toBe(
      "team/__proto__",
    )
    expect(assistantModelLabel({ providerID: "team", id: "constructor" }, providers, formatVariant)).toBe(
      "team/constructor",
    )
  })

  test("uses raw catalog keys while returning a control-free label for hostile provider, name, and variant displays", () => {
    const rawProviderID = "team\u001b"
    const hostileProviders = new Map([
      [
        rawProviderID,
        {
          models: {
            reviewer: { name: "Review\u001b[31m\u202e\u200b Model" },
            "vendor/model-v1": { name: "API ID Decoy" },
          },
        },
      ],
    ])
    const label = assistantModelLabel(
      { providerID: rawProviderID, id: "reviewer", variant: "thin\u001b]8;;https://invalid.example\u0007king" },
      hostileProviders,
      (model, variant) => `${model} (${variant})`,
    )

    expect(label).toBe("team/Review[31m Model (Thin]8;;https://invalid.exampleking)")
    expect(label).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u,
    )
    expect(label).not.toContain("API ID Decoy")
  })

  test("does not coerce dirty lookup identities and treats dirty display components as missing", () => {
    const formatVariant = (model: string, variant: string) => `${model} (${variant})`
    const dirtyModel = { providerID: 42, id: "reviewer", variant: true } as unknown as Parameters<
      typeof assistantModelLabel
    >[0]
    const dirtyCatalog = new Map([
      ["team", { models: { reviewer: { name: [] as unknown as string } } }],
    ]) as unknown as Parameters<typeof assistantModelLabel>[1]

    expect(assistantModelLabel(dirtyModel, providers, formatVariant)).toBe("reviewer")
    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, dirtyCatalog, formatVariant)).toBe(
      "team/reviewer",
    )
    expect(
      assistantModelLabel(
        { providerID: "team", id: {} } as unknown as Parameters<typeof assistantModelLabel>[0],
        providers,
        formatVariant,
      ),
    ).toBe("")
  })

  test("does not resolve numeric provider or model IDs through colliding string catalog keys", () => {
    const formatVariant = (model: string, variant: string) => `${model} (${variant})`
    const collidingProviders = new Map([
      ["42", { models: { reviewer: { name: "Wrong Numeric Provider Match" } } }],
      ["team", { models: { "42": { name: "Wrong Numeric Model Match" }, reviewer: { name: "Review Model" } } }],
    ])

    expect(
      assistantModelLabel(
        { providerID: 42, id: "reviewer" } as unknown as Parameters<typeof assistantModelLabel>[0],
        collidingProviders as Parameters<typeof assistantModelLabel>[1],
        formatVariant,
      ),
    ).toBe("reviewer")
    expect(
      assistantModelLabel(
        { providerID: "team", id: 42 } as unknown as Parameters<typeof assistantModelLabel>[0],
        collidingProviders as Parameters<typeof assistantModelLabel>[1],
        formatVariant,
      ),
    ).toBe("")
  })

  test.each([
    ["providerID", "team", "reviewer"],
    ["id", "reviewer", ""],
  ])("does not convert an object %s lookup identity", (position, existingKey, expected) => {
    let conversions = 0
    const conversionObject = {
      toString: () => {
        conversions += 1
        return existingKey
      },
      valueOf: () => {
        conversions += 1
        return existingKey
      },
      [Symbol.toPrimitive]: () => {
        conversions += 1
        return existingKey
      },
    }
    const model = { providerID: "team", id: "reviewer" }
    model[position as keyof typeof model] = conversionObject as never
    const collidingProviders = new Map([["team", { models: { reviewer: { name: "Wrong Converted Match" } } }]])

    expect(assistantModelLabel(model, collidingProviders, (label, variant) => `${label} (${variant})`)).toBe(expected)
    expect(conversions).toBe(0)
  })

  test.each(["providerID", "id"])("does not throw for a throwing %s conversion object", (field) => {
    const model = { providerID: "team", id: "reviewer" }
    model[field as keyof typeof model] = {
      [Symbol.toPrimitive]() {
        throw new Error(`${field} conversion must not escape`)
      },
      toString() {
        throw new Error(`${field} conversion must not escape`)
      },
      valueOf() {
        throw new Error(`${field} conversion must not escape`)
      },
    } as never

    expect(() => assistantModelLabel(model, providers, (label, variant) => `${label} (${variant})`)).not.toThrow()
  })

  test.each([
    ["null models map", { models: null }],
    ["undefined models map", { models: undefined }],
    ["null model entry", { models: { reviewer: null } }],
    ["array models map", { models: [] }],
    ["non-object models map", { models: 42 }],
  ])("treats a %s as a missing catalog name", (_kind, provider) => {
    expect(
      assistantModelLabel(
        { providerID: "team", id: "reviewer" },
        new Map([["team", provider]]) as unknown as Parameters<typeof assistantModelLabel>[1],
        (label, variant) => `${label} (${variant})`,
      ),
    ).toBe("team/reviewer")
  })

  test.each(["providerID", "id", "variant"])("does not throw for a reference %s getter", (field) => {
    const reference = Object.defineProperty({ providerID: "team", id: "reviewer", variant: "thinking" }, field, {
      get() {
        throw new Error(`${field} getter must not escape`)
      },
    })
    expect(() =>
      assistantModelLabel(
        reference as Parameters<typeof assistantModelLabel>[0],
        providers,
        (label, variant) => `${label} (${variant})`,
      ),
    ).not.toThrow()
  })

  test.each([
    ["null", null],
    ["primitive", 42],
  ])("treats a %s reference as missing", (_kind, reference) => {
    expect(() =>
      assistantModelLabel(
        reference as Parameters<typeof assistantModelLabel>[0],
        providers,
        (label, variant) => `${label} (${variant})`,
      ),
    ).not.toThrow()
    expect(
      assistantModelLabel(
        reference as Parameters<typeof assistantModelLabel>[0],
        providers,
        (label, variant) => `${label} (${variant})`,
      ),
    ).toBe("")
  })

  test.each(["reference", "provider entry", "model entry", "catalog name"])(
    "does not throw at a throwing %s Proxy/accessor boundary",
    (boundary) => {
      const trap = () => {
        throw new Error("proxy trap must not escape")
      }
      const reference =
        boundary === "reference"
          ? new Proxy({}, { getOwnPropertyDescriptor: trap })
          : { providerID: "team", id: "reviewer" }
      const dirtyProviders =
        boundary === "provider entry"
          ? new Map([["team", new Proxy({}, { get: trap })]])
          : boundary === "model entry"
            ? new Map([["team", { models: { reviewer: new Proxy({}, { get: trap }) } }]])
            : boundary === "catalog name"
              ? new Map([["team", { models: { reviewer: Object.defineProperty({}, "name", { get: trap }) } }]])
              : providers
      const formatVariant = (label: string, variant: string) => `${label} (${variant})`

      expect(() => assistantModelLabel(reference as never, dirtyProviders as never, formatVariant)).not.toThrow()
    },
  )
})
