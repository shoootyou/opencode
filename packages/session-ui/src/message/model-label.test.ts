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
    const formatVariant = (model: string, variant: string) => `${model} (${variant})`
    const catalog = new Map<string, { models: Record<string, { name: string }> }>([
      ["team", { models: { reviewer: { name: "Review Model" } } }],
      ["téam", { models: { reviewer: { name: "Accent Provider Model" } } }],
      ["team", { models: { reviewer: { name: "Review Model" }, réviewer: { name: "Accent Model" } } }],
    ])

    expect(assistantModelLabel({ providerID: "team", id: "reviewer" }, catalog, formatVariant)).toBe(
      "team/Review Model",
    )
    expect(assistantModelLabel({ providerID, id }, catalog, formatVariant)).toBe(fallback)
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

  test("pins primitive raw catalog keys and both primitive-string gates at the adapter boundary", async () => {
    const source = await Bun.file(new URL("./model-label.ts", import.meta.url)).text()

    expect(source).toContain('typeof reference?.providerID === "string" && typeof reference.id === "string"')
    expect(source).toContain("providers?.get(providerID)")
    expect(source).toContain("models[id]")
    expect(source).not.toContain("String(")
    expect(source).not.toContain("`${id}`")
    expect(source).not.toMatch(/(?:^|[^=!])==(?!=)/)
  })

  test.each([
    ["number", 42, "7"],
    ["boolean", true, "7"],
    ["null", null, "7"],
    ["undefined", undefined, "7"],
    ["array", ["a"], "7"],
    ["String object", new String("team"), "7"],
  ])("does not coerce a %s provider identity into a colliding catalog key", (_kind, providerID, expected) => {
    const formatVariant = (model: string, variant: string) => `${model} (${variant})`
    const collidingProviders = new Map([
      ["42", { models: { "7": { name: "Coerced Match" } } }],
      ["true", { models: { "7": { name: "Coerced Match" } } }],
      ["null", { models: { "7": { name: "Coerced Match" } } }],
      ["undefined", { models: { "7": { name: "Coerced Match" } } }],
      ["a", { models: { "7": { name: "Coerced Match" } } }],
      ["team", { models: { "7": { name: "Coerced Match" } } }],
    ])

    expect(assistantModelLabel({ providerID, id: "7" } as never, collidingProviders as never, formatVariant)).toBe(
      expected,
    )
  })

  test.each([
    ["number", 7],
    ["boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["array", ["a"]],
    ["String object", new String("7")],
  ])("does not coerce a %s model identity into a colliding catalog key", (_kind, id) => {
    const formatVariant = (model: string, variant: string) => `${model} (${variant})`
    const collidingProviders = new Map([
      [
        "team",
        {
          models: {
            "7": { name: "Coerced Match" },
            true: { name: "Coerced Match" },
            null: { name: "Coerced Match" },
            undefined: { name: "Coerced Match" },
            a: { name: "Coerced Match" },
          },
        },
      ],
    ])

    expect(assistantModelLabel({ providerID: "team", id } as never, collidingProviders as never, formatVariant)).toBe(
      "",
    )
  })

  test.each([
    ["providerID", "team", "7"],
    ["id", "7", ""],
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
    const model = { providerID: "team", id: "7" }
    model[position as keyof typeof model] = conversionObject as never
    const collidingProviders = new Map([["team", { models: { "7": { name: "Coerced Match" } } }]])

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
      expect(
        assistantModelLabel(
          reference as Parameters<typeof assistantModelLabel>[0],
          providers,
          (label, variant) => `${label} (${variant})`,
        ),
      ).toBe("")
      expect(reads).toBe(1)
    },
  )

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

  test.each([
    [
      "reference descriptor Proxy",
      () => {
        let hits = 0
        return {
          hostile: new Proxy(
            {},
            {
              getOwnPropertyDescriptor: () => (
                (hits += 1),
                (() => {
                  throw new Error("trap")
                })()
              ),
            },
          ),
          control: new Proxy(
            { providerID: "team", id: "reviewer" },
            { getOwnPropertyDescriptor: (target, key) => ((hits += 1), Reflect.getOwnPropertyDescriptor(target, key)) },
          ),
          hits: () => hits,
        }
      },
      "",
    ],
    [
      "provider models Proxy",
      () => {
        let hits = 0
        return {
          hostile: new Map([
            [
              "team",
              new Proxy(
                {},
                {
                  get: () => (
                    (hits += 1),
                    (() => {
                      throw new Error("trap")
                    })()
                  ),
                },
              ),
            ],
          ]),
          control: new Map([
            [
              "team",
              new Proxy(
                { models: { reviewer: { name: "Review Model" } } },
                { get: (target, key) => ((hits += 1), Reflect.get(target, key)) },
              ),
            ],
          ]),
          hits: () => hits,
        }
      },
      "team/reviewer",
    ],
    [
      "model entry Proxy",
      () => {
        let hits = 0
        return {
          hostile: new Map([
            [
              "team",
              {
                models: {
                  reviewer: new Proxy(
                    {},
                    {
                      get: () => (
                        (hits += 1),
                        (() => {
                          throw new Error("trap")
                        })()
                      ),
                    },
                  ),
                },
              },
            ],
          ]),
          control: new Map([
            [
              "team",
              {
                models: {
                  reviewer: new Proxy(
                    { name: "Review Model" },
                    { get: (target, key) => ((hits += 1), Reflect.get(target, key)) },
                  ),
                },
              },
            ],
          ]),
          hits: () => hits,
        }
      },
      "team/reviewer",
    ],
    [
      "catalog name getter",
      () => {
        let hits = 0
        return {
          hostile: new Map([
            [
              "team",
              {
                models: {
                  reviewer: Object.defineProperty({}, "name", {
                    get: () => (
                      (hits += 1),
                      (() => {
                        throw new Error("getter")
                      })()
                    ),
                  }),
                },
              },
            ],
          ]),
          control: new Map([
            [
              "team",
              { models: { reviewer: Object.defineProperty({}, "name", { get: () => ((hits += 1), "Review Model") }) } },
            ],
          ]),
          hits: () => hits,
        }
      },
      "team/reviewer",
    ],
  ])(
    "reaches a throwing %s boundary, degrades exactly, and distinguishes its benign control",
    (_boundary, build, expected) => {
      const fixture = build()
      const formatVariant = (label: string, variant: string) => `${label} (${variant})`

      const model =
        _boundary === "reference descriptor Proxy" ? fixture.hostile : { providerID: "team", id: "reviewer" }
      const controlModel =
        _boundary === "reference descriptor Proxy" ? fixture.control : { providerID: "team", id: "reviewer" }
      const catalog = _boundary === "reference descriptor Proxy" ? providers : fixture.hostile
      const controlCatalog = _boundary === "reference descriptor Proxy" ? providers : fixture.control

      expect(assistantModelLabel(model as never, catalog as never, formatVariant)).toBe(expected)
      expect(fixture.hits()).toBeGreaterThan(0)
      expect(assistantModelLabel(controlModel as never, controlCatalog as never, formatVariant)).toBe(
        "team/Review Model",
      )
    },
  )

  test.each(["reference", "provider entry", "model entry"])(
    "degrades a revoked %s Proxy to its exact fallback",
    (boundary) => {
      const revocable = Proxy.revocable({}, {})
      revocable.revoke()
      const catalog =
        boundary === "provider entry"
          ? new Map([["team", revocable.proxy]])
          : boundary === "model entry"
            ? new Map([["team", { models: { reviewer: revocable.proxy } }]])
            : providers
      const reference = boundary === "reference" ? revocable.proxy : { providerID: "team", id: "reviewer" }

      expect(
        assistantModelLabel(reference as never, catalog as never, (label, variant) => `${label} (${variant})`),
      ).toBe(boundary === "reference" ? "" : "team/reviewer")
    },
  )

  test.each(["providerID", "id", "variant"])("reads a stable %s getter exactly once", (field) => {
    let reads = 0
    const reference = Object.defineProperty({ providerID: "team", id: "reviewer", variant: "thinking" }, field, {
      get() {
        reads += 1
        if (reads > 1) throw new Error(`${field} was read more than once`)
        return field === "providerID" ? "team" : field === "id" ? "reviewer" : "thinking"
      },
    })

    expect(assistantModelLabel(reference as never, providers, (label, variant) => `${label} (${variant})`)).toBe(
      "team/Review Model (Thinking)",
    )
    expect(reads).toBe(1)
  })
})
