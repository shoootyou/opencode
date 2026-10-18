/**
 * @spec-handoff
 * @interface assistantModelLabel(model: ModelLabelRef | undefined, models: readonly Readonly<{ providerID: string; id: string; name: string }>[] | undefined): string
 * @behavior
 *   - Resolves the exact message (providerID, id) against the TUI catalog and formats it through @opencode/util/model-label.
 *   - Returns a control-free display label while looking up catalog entries by raw providerID/id.
 *   - Adds a parenthesized, first-code-unit-capitalized non-default variant to the complete label.
 * @edge-cases
 *   - Missing or empty reference identities return an empty label.
 *   - Catalog modelID is never a lookup key; aliases sharing an API ID retain their own display names.
 *   - Long, Unicode, slash-containing names remain untruncated plain text for native footer wrapping.
 * @see ../../src/util/model.ts
 */
import { describe, expect, test } from "bun:test"
import { assistantModelLabel, formatRef, parse, switchLabel } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  test("includes the selected variant in model refs", () => {
    expect(formatRef({ providerID: "anthropic", id: "sonnet", variant: "thinking" })).toBe("anthropic/sonnet/thinking")
    expect(formatRef({ providerID: "anthropic", id: "sonnet" })).toBe("anthropic/sonnet")
  })

  test("includes the selected variant in model switch notices", () => {
    expect(switchLabel({ providerID: "anthropic", id: "sonnet", variant: "thinking" })).toBe(
      "Switched model to anthropic/sonnet/thinking",
    )
  })

  test("uses the catalog display name in model switch notices", () => {
    const models = [
      { providerID: "openai", id: "gpt-5.5-fast", name: "GPT-5.5 Fast" },
      { providerID: "anthropic", id: "sonnet", name: "Claude Sonnet" },
    ]
    expect(switchLabel({ providerID: "openai", id: "gpt-5.5-fast", variant: "high" }, models)).toBe(
      "Switched model to GPT-5.5 Fast (high)",
    )
    expect(switchLabel({ providerID: "anthropic", id: "sonnet" }, models)).toBe("Switched model to Claude Sonnet")
    expect(switchLabel({ providerID: "anthropic", id: "sonnet", variant: "default" }, models)).toBe(
      "Switched model to Claude Sonnet",
    )
    expect(switchLabel({ providerID: "removed", id: "gone", variant: "high" }, models)).toBe(
      "Switched model to removed/gone/high",
    )
  })

  test("distinguishes variant-only switches from model switches", () => {
    const previous = { providerID: "openai", id: "gpt-5.5", variant: "medium" }

    expect(switchLabel({ ...previous, variant: "high" }, undefined, previous)).toBe("Switched variant to high")
    expect(switchLabel({ providerID: "openai", id: "gpt-5.5" }, undefined, previous)).toBe(
      "Switched variant to default",
    )
    expect(switchLabel({ providerID: "anthropic", id: "sonnet", variant: "high" }, undefined, previous)).toBe(
      "Switched model to anthropic/sonnet/high",
    )
  })

  test("formats the assistant footer label with the shared formatter using the matching catalog identity", () => {
    expect(
      assistantModelLabel({ providerID: "team", id: "reviewer", variant: "thinking" }, [
        { providerID: "team", id: "reviewer", name: "Review Model" },
      ]),
    ).toBe("team/Review Model (Thinking)")
  })

  test("resolves aliased assistant models by provider and catalog id rather than API modelID", () => {
    const models = [
      { providerID: "other", id: "reviewer", modelID: "vendor/model-v1", name: "Other Review Model" },
      { providerID: "team", id: "writer", modelID: "vendor/model-v1", name: "Writer Model" },
      { providerID: "team", id: "reviewer", modelID: "vendor/model-v1", name: "Review Model" },
      { providerID: "team", id: "vendor/model-v1", modelID: "unrelated-api-id", name: "API ID Decoy" },
    ]

    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, models)).toBe("team/Review Model")
    expect(assistantModelLabel({ providerID: "team", id: "writer" }, [...models].reverse())).toBe("team/Writer Model")
  })

  test("falls back independently for unknown models, unknown providers, and an unavailable catalog", () => {
    const models = [{ providerID: "team", id: "reviewer", name: "Review Model" }]

    expect(assistantModelLabel({ providerID: "team", id: "missing" }, models)).toBe("team/missing")
    expect(assistantModelLabel({ providerID: "unknown", id: "reviewer" }, models)).toBe("unknown/reviewer")
    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, undefined)).toBe("team/reviewer")
  })

  test("keeps a non-default variant when the assistant model is absent from the catalog", () => {
    expect(assistantModelLabel({ providerID: "team", id: "reviewer", variant: "high" }, [])).toBe(
      "team/reviewer (High)",
    )
    expect(assistantModelLabel({ providerID: "team", id: "reviewer", variant: "default" }, [])).toBe("team/reviewer")
  })

  test("returns an empty assistant footer label for a missing or incomplete model reference", () => {
    expect(assistantModelLabel(undefined, [])).toBe("")
    expect(assistantModelLabel({ id: "reviewer" }, [])).toBe("")
    expect(assistantModelLabel({ providerID: "team" }, [])).toBe("")
    expect(assistantModelLabel({ providerID: "", id: "reviewer" }, [])).toBe("")
    expect(assistantModelLabel({ providerID: "team", id: "" }, [])).toBe("")
  })

  test("preserves long Unicode catalog names for native footer wrapping", () => {
    const name = "長いモデル名e\u0301/مرحبا"
    expect(
      assistantModelLabel({ providerID: "team", id: "reviewer" }, [{ providerID: "team", id: "reviewer", name }]),
    ).toBe(`team/${name}`)
  })

  test("uses raw catalog identities while returning a control-free assistant footer label for hostile displays", () => {
    const rawProviderID = "team\u001b"
    const label = assistantModelLabel(
      { providerID: rawProviderID, id: "reviewer", variant: "thin\u001b]8;;https://invalid.example\u0007king" },
      [
        { providerID: rawProviderID, id: "reviewer", name: "Review\u001b[31m\u202e\u200b Model" },
        { providerID: rawProviderID, id: "vendor/model-v1", name: "API ID Decoy" },
      ],
    )

    expect(label).toBe("team/Review[31m Model (Thin]8;;https://invalid.exampleking)")
    expect(label).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u,
    )
    expect(label).not.toContain("API ID Decoy")
  })

  test("does not coerce dirty lookup identities and treats dirty display components as missing", () => {
    const dirtyModel = { providerID: 42, id: "reviewer", variant: true } as unknown as Parameters<
      typeof assistantModelLabel
    >[0]
    const dirtyCatalog = [
      { providerID: "team", id: "reviewer", name: [] as unknown as string },
    ] as unknown as Parameters<typeof assistantModelLabel>[1]

    expect(assistantModelLabel(dirtyModel, [{ providerID: "42", id: "reviewer", name: "Wrong Catalog Match" }])).toBe(
      "reviewer",
    )
    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, dirtyCatalog)).toBe("team/reviewer")
    expect(
      assistantModelLabel({ providerID: "team", id: {} } as unknown as Parameters<typeof assistantModelLabel>[0], []),
    ).toBe("")
  })
})
