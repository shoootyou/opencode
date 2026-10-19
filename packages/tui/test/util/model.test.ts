/**
 * @spec-handoff
 * @interface assistantModelLabel(model: ModelLabelRef | undefined, models: readonly Readonly<{ providerID: string; id: string; name: string }>[] | undefined): string
 * @behavior
 *   - Resolves the exact message (providerID, id) only when both identities are primitive strings.
 *   - Returns a control-free display label while looking up catalog entries by raw providerID/id.
 *   - Adds a parenthesized, first-code-unit-capitalized non-default variant to the complete label.
 *   - Traverses only array catalogs and plain object entries, skipping malformed items.
 * @edge-cases
 *   - Missing or empty reference identities return an empty label.
 *   - Catalog modelID is never a lookup key; aliases sharing an API ID retain their own display names.
 *   - Dirty catalogs and unreadable references degrade as missing without throwing.
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

  test.each([
    ["leading provider space", " team", "reviewer", "team/reviewer"],
    ["trailing provider space", "team ", "reviewer", "team/reviewer"],
    ["provider tab", "\tteam", "reviewer", "team/reviewer"],
    ["provider no-break space", "\u00a0team", "reviewer", "team/reviewer"],
    ["provider newline", "team\n", "reviewer", "team/reviewer"],
    ["leading model space", "team", " reviewer", "team/reviewer"],
    ["trailing model space", "team", "reviewer ", "team/reviewer"],
    ["model tab", "team", "\treviewer", "team/reviewer"],
    ["model no-break space", "team", "\u00a0reviewer", "team/reviewer"],
    ["model newline", "team", "reviewer\n", "team/reviewer"],
    ["case-distinct provider", "Team", "reviewer", "Team/reviewer"],
    ["case-distinct model", "team", "Reviewer", "team/Reviewer"],
    ["NFD provider", "te\u0301am", "reviewer", "te\u0301am/reviewer"],
    ["NFD model", "team", "re\u0301viewer", "team/re\u0301viewer"],
  ])("does not normalize or otherwise rewrite a %s catalog key", (_case, providerID, id, fallback) => {
    const models = [
      { providerID: "team", id: "reviewer", name: "Review Model" },
      { providerID: "téam", id: "reviewer", name: "Accent Provider Model" },
      { providerID: "team", id: "réviewer", name: "Accent Model" },
    ]

    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, models)).toBe("team/Review Model")
    expect(assistantModelLabel({ providerID, id }, models)).toBe(fallback)
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

  test("resolves every raw case, padding, and Unicode key to its own provider and model entry", () => {
    const decomposed = "cafe\u0301"
    const composed = "café"
    const keys = [decomposed, composed, "reviewer", "Reviewer", " reviewer", "reviewer "]
    const models = [
      ...keys.map((providerID, index) => ({ providerID, id: "model", name: `Provider ${index}` })),
      ...keys.map((id, index) => ({ providerID: "team", id, name: `Model ${index}` })),
    ]

    for (const [index, key] of keys.entries()) {
      expect(assistantModelLabel({ providerID: key, id: "model" }, models)).toBe(`${key.trim()}/Provider ${index}`)
      expect(assistantModelLabel({ providerID: "team", id: key }, models)).toBe(`team/Model ${index}`)
    }
  })

  test.each([
    ["number", 42, "7"],
    ["boolean", true, "7"],
    ["null", null, "7"],
    ["undefined", undefined, "7"],
    ["array", ["a"], "7"],
    ["String object", new String("team"), "7"],
  ])("does not coerce a %s provider identity into a colliding catalog key", (_kind, providerID, expected) => {
    const models = [
      { providerID: "42", id: "7", name: "Coerced Match" },
      { providerID: "true", id: "7", name: "Coerced Match" },
      { providerID: "null", id: "7", name: "Coerced Match" },
      { providerID: "undefined", id: "7", name: "Coerced Match" },
      { providerID: "a", id: "7", name: "Coerced Match" },
      { providerID: "team", id: "7", name: "Coerced Match" },
    ]

    expect(assistantModelLabel({ providerID, id: "7" } as never, models)).toBe(expected)
  })

  test.each([
    ["number", 7],
    ["boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["array", ["a"]],
    ["String object", new String("7")],
  ])("does not coerce a %s model identity into a colliding catalog key", (_kind, id) => {
    const models = [
      { providerID: "team", id: "7", name: "Coerced Match" },
      { providerID: "team", id: "true", name: "Coerced Match" },
      { providerID: "team", id: "null", name: "Coerced Match" },
      { providerID: "team", id: "undefined", name: "Coerced Match" },
      { providerID: "team", id: "a", name: "Coerced Match" },
    ]

    expect(assistantModelLabel({ providerID: "team", id } as never, models)).toBe("")
  })

  test.each([
    ["provider", "7"],
    ["id", ""],
  ])("does not convert an object %s lookup identity", (position, expected) => {
    let conversions = 0
    const conversionObject = {
      toString: () => {
        conversions += 1
        return position === "provider" ? "team" : "7"
      },
      valueOf: () => {
        conversions += 1
        return position === "provider" ? "team" : "7"
      },
      [Symbol.toPrimitive]: () => {
        conversions += 1
        return position === "provider" ? "team" : "7"
      },
    }
    const model =
      position === "provider" ? { providerID: conversionObject, id: "7" } : { providerID: "team", id: conversionObject }

    expect(assistantModelLabel(model as never, [{ providerID: "team", id: "7", name: "Coerced Match" }])).toBe(expected)
    expect(conversions).toBe(0)
  })

  test.each(["providerID", "id"])("does not throw for a throwing %s conversion object", (field) => {
    const conversionObject = {
      [Symbol.toPrimitive]() {
        throw new Error(`${field} conversion must not escape`)
      },
      toString() {
        throw new Error(`${field} conversion must not escape`)
      },
      valueOf() {
        throw new Error(`${field} conversion must not escape`)
      },
    }
    const model =
      field === "providerID"
        ? { providerID: conversionObject, id: "reviewer" }
        : { providerID: "team", id: conversionObject }

    expect(() => assistantModelLabel(model as never, [])).not.toThrow()
  })

  test.each([
    ["null entry", [null]],
    ["sparse array", new Array(1)],
    ["non-array catalog", {}],
  ])("treats a %s as a missing catalog", (_kind, models) => {
    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, models as never)).toBe("team/reviewer")
  })

  test.each([
    ["null", () => [null]],
    ["undefined", () => [undefined]],
    ["primitive", () => [42]],
    ["sparse hole", () => new Array(1)],
  ])("skips a %s item before a later valid catalog entry", (_kind, buildPrefix) => {
    const models = buildPrefix() as unknown[]
    const valid = { providerID: "team", id: "reviewer", name: "Review Model" }
    models.push(valid)

    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, models as never)).toBe("team/Review Model")
    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, [valid])).toBe("team/Review Model")
  })

  test("rejects non-array and hostile-find catalogs without dispatching their find methods", () => {
    let nonArrayFindCalls = 0
    let decoratedArrayFindCalls = 0
    const nonArrayCatalog = {
      find() {
        nonArrayFindCalls += 1
        return { providerID: "team", id: "reviewer", name: "Wrong Non-Array Find" }
      },
    }
    const decoratedArray = Object.assign([{ providerID: "team", id: "reviewer", name: "Review Model" }], {
      find() {
        decoratedArrayFindCalls += 1
        return { providerID: "team", id: "reviewer", name: "Wrong Decorated Find" }
      },
    })

    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, nonArrayCatalog as never)).toBe("team/reviewer")
    expect(nonArrayFindCalls).toBe(0)
    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, decoratedArray)).toBe("team/Review Model")
    expect(decoratedArrayFindCalls).toBe(0)
  })

  test("rejects a non-array iterator without dispatching it", () => {
    let iteratorCalls = 0
    const catalog = {
      [Symbol.iterator]() {
        iteratorCalls += 1
        return [{ providerID: "team", id: "reviewer", name: "Wrong Iterator" }][Symbol.iterator]()
      },
    }

    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, catalog as never)).toBe("team/reviewer")
    expect(iteratorCalls).toBe(0)
  })

  test.each([
    ["array entry", Object.assign([], { providerID: "team", id: "reviewer", name: "Wrong Array Entry" })],
    ["function entry", Object.assign(function wrongFunction() {}, { providerID: "team", id: "reviewer" })],
  ])("rejects a %s even when it carries matching primitive fields", (_kind, malformed) => {
    const models = [malformed, { providerID: "team", id: "reviewer", name: "Review Model" }]

    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, models as never)).toBe("team/Review Model")
    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, [malformed] as never)).toBe("team/reviewer")
  })

  test("falls back when the matching entry has a non-string name", () => {
    const models = [{ providerID: "team", id: "reviewer", name: function builtInName() {} }]

    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, models as never)).toBe("team/reviewer")
    expect(
      assistantModelLabel({ providerID: "team", id: "reviewer" }, [
        { providerID: "team", id: "reviewer", name: "Review Model" },
      ]),
    ).toBe("team/Review Model")
  })

  test.each(["providerID", "id", "variant"])(
    "reaches a throwing reference %s getter and returns an empty label",
    (field) => {
      let reads = 0
      const reference = Object.defineProperty({ providerID: "team", id: "reviewer", variant: "thinking" }, field, {
        get() {
          reads += 1
          throw new Error(`${field} getter must not escape`)
        },
      })
      expect(assistantModelLabel(reference as never, [])).toBe("")
      expect(reads).toBe(1)
    },
  )

  test.each([
    ["null", null],
    ["primitive", 42],
  ])("treats a %s reference as missing", (_kind, reference) => {
    expect(() => assistantModelLabel(reference as never, [])).not.toThrow()
    expect(assistantModelLabel(reference as never, [])).toBe("")
  })

  test("reaches a throwing reference Proxy descriptor trap and returns an empty label", () => {
    let hits = 0
    const reference = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          hits += 1
          throw new Error("trap")
        },
      },
    )
    expect(assistantModelLabel(reference as never, [])).toBe("")
    expect(hits).toBeGreaterThan(0)
    expect(
      assistantModelLabel({ providerID: "team", id: "reviewer" }, [
        { providerID: "team", id: "reviewer", name: "Review Model" },
      ]),
    ).toBe("team/Review Model")
  })

  test.each(["providerID", "id", "name"])("reaches a throwing catalog %s getter and falls back exactly", (field) => {
    let hits = 0
    const entry = Object.defineProperty({ providerID: "team", id: "reviewer", name: "Review Model" }, field, {
      get() {
        hits += 1
        throw new Error("getter")
      },
    })
    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, [entry] as never)).toBe("team/reviewer")
    expect(hits).toBeGreaterThan(0)
    expect(
      assistantModelLabel({ providerID: "team", id: "reviewer" }, [
        { providerID: "team", id: "reviewer", name: "Review Model" },
      ]),
    ).toBe("team/Review Model")
  })

  test("reaches a throwing catalog entry Proxy trap and falls back exactly", () => {
    let hits = 0
    const entry = new Proxy(
      {},
      {
        get: () => {
          hits += 1
          throw new Error("trap")
        },
      },
    )
    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, [entry] as never)).toBe("team/reviewer")
    expect(hits).toBeGreaterThan(0)
    expect(
      assistantModelLabel({ providerID: "team", id: "reviewer" }, [
        { providerID: "team", id: "reviewer", name: "Review Model" },
      ]),
    ).toBe("team/Review Model")
  })

  test.each(["reference", "entry"])("degrades a revoked %s Proxy to its exact fallback", (boundary) => {
    const revocable = Proxy.revocable({}, {})
    revocable.revoke()
    expect(
      assistantModelLabel(
        boundary === "reference" ? (revocable.proxy as never) : { providerID: "team", id: "reviewer" },
        boundary === "entry" ? ([revocable.proxy] as never) : [],
      ),
    ).toBe(boundary === "reference" ? "" : "team/reviewer")
  })

  test.each(["providerID", "id", "variant"])("reads a stable %s getter exactly once", (field) => {
    let reads = 0
    const reference = Object.defineProperty({ providerID: "team", id: "reviewer", variant: "thinking" }, field, {
      get() {
        reads += 1
        if (reads > 1) throw new Error(`${field} was read more than once`)
        return field === "providerID" ? "team" : field === "id" ? "reviewer" : "thinking"
      },
    })
    expect(
      assistantModelLabel(reference as never, [{ providerID: "team", id: "reviewer", name: "Review Model" }]),
    ).toBe("team/Review Model (Thinking)")
    expect(reads).toBe(1)
  })
})
