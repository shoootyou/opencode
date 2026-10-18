/**
 * @spec-handoff
 * @interface assistantModelLabel(model: ModelLabelRef | undefined, providers: ProviderNames | undefined, formatVariant: FormatModelVariant): string
 * @behavior
 *   - Resolves model display names only by the message (providerID, id) identity.
 *   - Delegates one sanitized shared label, including its variant, to the app formatter.
 * @edge-cases
 *   - Missing catalog entries preserve raw provider/model IDs.
 *   - Missing identity and prototype-key IDs produce a safe empty or raw label.
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
})
