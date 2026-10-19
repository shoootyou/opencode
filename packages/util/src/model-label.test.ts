/**
 * @spec-handoff
 * @interface formatModelLabel(model: ModelLabelRef | undefined, name?: string, formatVariant?: FormatModelVariant): string
 * @behavior
 *   - Sanitizes each display component without changing raw lookup identities.
 *   - Renders safe resolved names or safe raw IDs and non-default variants.
 *   - Treats unreadable or non-object references as missing without swallowing callback errors.
 * @edge-cases
 *   - Sanitized-empty components fall back or are omitted; each is capped at 64 code points.
 *   - Missing, hostile, or unreadable reference fields return an empty label.
 * @see ../../session-ui/src/message/model-label.ts
 */
import { describe, expect, test } from "bun:test"
import { formatModelLabel } from "./model-label.js"

const forbiddenDisplayCharacters =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u

describe("formatModelLabel", () => {
  test("renders the raw provider ID with a known model display name", () => {
    expect(formatModelLabel({ providerID: "team", id: "reviewer" }, "Review Model")).toBe("team/Review Model")
  })

  test("falls back independently to the raw model ID for an unknown model or provider", () => {
    expect(formatModelLabel({ providerID: "team", id: "reviewer" })).toBe("team/reviewer")
    expect(formatModelLabel({ providerID: "unknown-provider", id: "unknown-model" })).toBe(
      "unknown-provider/unknown-model",
    )
  })

  test("returns an empty label when the reference or either identity is absent or empty", () => {
    expect(formatModelLabel(undefined)).toBe("")
    expect(formatModelLabel({ id: "reviewer" })).toBe("")
    expect(formatModelLabel({ providerID: "team" })).toBe("")
    expect(formatModelLabel({ providerID: "", id: "reviewer" })).toBe("")
    expect(formatModelLabel({ providerID: "team", id: "" })).toBe("")
  })

  test("preserves nested IDs and falls back from an empty catalog name to the raw model ID", () => {
    expect(formatModelLabel({ providerID: "team/vendor", id: "reviewer/v1" })).toBe("team/vendor/reviewer/v1")
    expect(formatModelLabel({ providerID: "team", id: "reviewer" }, "")).toBe("team/reviewer")
  })

  test("preserves long unicode and RTL display names without inserting control characters", () => {
    const name = "長いモデル e\u0301 نموذج"
    const label = formatModelLabel({ providerID: "team", id: "reviewer" }, name)

    expect(label).toBe(`team/${name}`)
    expect(label).not.toMatch(/[\u001b\u2066-\u2069]/)
  })

  test("omits undefined, empty, and exact default variants without invoking the callback", () => {
    let calls = 0
    const formatVariant = (label: string, variant: string) => {
      calls += 1
      return `${label} (${variant})`
    }

    expect(formatModelLabel({ providerID: "team", id: "reviewer" }, "Review Model", formatVariant)).toBe(
      "team/Review Model",
    )
    expect(formatModelLabel({ providerID: "team", id: "reviewer", variant: "" }, "Review Model", formatVariant)).toBe(
      "team/Review Model",
    )
    expect(
      formatModelLabel({ providerID: "team", id: "reviewer", variant: "default" }, "Review Model", formatVariant),
    ).toBe("team/Review Model")
    expect(calls).toBe(0)
  })

  test("formats non-default variants with app-compatible capitalization", () => {
    expect(formatModelLabel({ providerID: "team", id: "reviewer", variant: "thinking" }, "Review Model")).toBe(
      "team/Review Model (Thinking)",
    )
    expect(formatModelLabel({ providerID: "team", id: "reviewer", variant: "Default" }, "Review Model")).toBe(
      "team/Review Model (Default)",
    )
    expect(formatModelLabel({ providerID: "team", id: "reviewer", variant: "high" })).toBe("team/reviewer (High)")
  })

  test("passes the complete base and capitalized variant to an injected formatter", () => {
    const received: Array<[string, string]> = []
    const result = formatModelLabel(
      { providerID: "team", id: "reviewer", variant: "thinking" },
      "Review Model",
      (label: string, variant: string) => {
        received.push([label, variant])
        return `translated: ${label} :: ${variant}`
      },
    )

    expect(received).toEqual([["team/Review Model", "Thinking"]])
    expect(result).toBe("translated: team/Review Model :: Thinking")
  })

  test("does not mutate frozen reference inputs", () => {
    const model = Object.freeze({ providerID: "team", id: "reviewer", variant: "thinking" })

    expect(formatModelLabel(model, "Review Model")).toBe("team/Review Model (Thinking)")
    expect(model).toEqual({ providerID: "team", id: "reviewer", variant: "thinking" })
  })

  test("removes ESC, OSC, and CSI controls independently from provider, name, and variant display components", () => {
    const label = formatModelLabel(
      { providerID: "pro\u001b]8;;https://invalid.example\u0007vider", id: "model", variant: "thin\u001b[31mking" },
      "Mo\u001b[2Jdel",
    )

    expect(label).toBe("pro]8;;https://invalid.examplevider/Mo[2Jdel (Thin[31mking)")
    expect(label).not.toMatch(forbiddenDisplayCharacters)
  })

  test("removes bidi overrides independently from provider, name, and variant display components", () => {
    const label = formatModelLabel(
      { providerID: "pro\u202evider", id: "model", variant: "thin\u202eking" },
      "Mo\u202edel",
    )

    expect(label).toBe("provider/Model (Thinking)")
    expect(label).not.toMatch(forbiddenDisplayCharacters)
  })

  test("removes zero-width and every C0, DEL, and C1 character from display components", () => {
    const controls = `${String.fromCodePoint(...Array.from({ length: 32 }, (_, index) => index))}\u007f${String.fromCodePoint(
      ...Array.from({ length: 32 }, (_, index) => index + 0x80),
    )}\u200b\u200c\u200d\u2060\ufeff\u00ad`
    const label = formatModelLabel(
      { providerID: `pro${controls}vider`, id: "model", variant: `thin${controls}king` },
      `Mo${controls}del`,
    )

    expect(label).toBe("provider/Model (Thinking)")
    expect(label).not.toMatch(forbiddenDisplayCharacters)
  })

  test("collapses whitespace and trims every display component", () => {
    expect(
      formatModelLabel(
        { providerID: "  team   one  ", id: "model", variant: "  high   focus  " },
        "  Review   Model  ",
      ),
    ).toBe("team one/Review Model (High focus)")
  })

  test("uses sanitized fallbacks and omits display parts that are empty after sanitization", () => {
    expect(formatModelLabel({ providerID: "team", id: "review\u001b" }, "\u001b\u202e")).toBe("team/review")
    expect(formatModelLabel({ providerID: "team", id: "\u001b\u202e", variant: "high" }, "\u001b\u202e")).toBe("")
    expect(formatModelLabel({ providerID: "\u001b\u202e", id: "model" }, "Model")).toBe("Model")
    expect(formatModelLabel({ providerID: "team", id: "model", variant: "\u001b\u202e" }, "Model")).toBe("team/Model")
  })

  const dirtyValues: Array<[string, unknown]> = [
    ["number", 42],
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
    ["array", []],
    ["symbol", Symbol("dirty")],
    ["bigint", 1n],
    ["boolean", true],
    ["function", () => {}],
    [
      "object with a throwing toString",
      {
        toString: () => {
          throw new Error("must not coerce")
        },
      },
    ],
  ]

  test.each(dirtyValues)("treats a %s provider ID as missing without coercion", (_kind, value) => {
    expect(
      formatModelLabel(
        { providerID: value, id: "model" } as unknown as Parameters<typeof formatModelLabel>[0],
        "Model",
      ),
    ).toBe("Model")
  })

  test.each(dirtyValues)("treats a %s fallback model ID as missing without coercion", (_kind, value) => {
    expect(
      formatModelLabel({ providerID: "team", id: value } as unknown as Parameters<typeof formatModelLabel>[0]),
    ).toBe("")
  })

  test.each(dirtyValues)("treats a %s catalog name as missing without coercion", (_kind, value) => {
    expect(formatModelLabel({ providerID: "team", id: "model" }, value as unknown as string)).toBe("team/model")
  })

  test.each(dirtyValues)("treats a %s variant as missing without coercion", (_kind, value) => {
    expect(
      formatModelLabel(
        { providerID: "team", id: "model", variant: value } as unknown as Parameters<typeof formatModelLabel>[0],
        "Model",
      ),
    ).toBe("team/Model")
  })

  test("caps the final capitalized variant at 64 code points before invoking the callback", () => {
    const received: string[] = []
    const result = formatModelLabel(
      { providerID: "team", id: "model", variant: `ß${"x".repeat(63)}` },
      "Model",
      (_label, variant) => {
        received.push(variant)
        return variant
      },
    )

    expect(received).toEqual([`SS${"x".repeat(61)}…`])
    expect(Array.from(received[0]!)).toHaveLength(64)
    expect(result).toBe(`SS${"x".repeat(61)}…`)
  })

  test.each([
    ["U+061C", "\u061c"],
    ["U+200E", "\u200e"],
    ["U+200F", "\u200f"],
    ["U+2066", "\u2066"],
    ["U+2067", "\u2067"],
    ["U+2068", "\u2068"],
    ["U+2069", "\u2069"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
  ])("removes %s from every display component", (codePoint, forbidden) => {
    const label = formatModelLabel(
      { providerID: `pro${forbidden}vider`, id: "model", variant: `thin${forbidden}king` },
      `Mo${forbidden}del`,
    )

    expect(label, codePoint).toBe("provider/Model (Thinking)")
  })

  test.each([
    ["provider", { providerID: "p".repeat(64), id: "model" }, "Model", `${"p".repeat(64)}/Model`],
    ["name", { providerID: "team", id: "model" }, "n".repeat(64), `team/${"n".repeat(64)}`],
    [
      "variant",
      { providerID: "team", id: "model", variant: "v".repeat(64) },
      "Model",
      `team/Model (V${"v".repeat(63)})`,
    ],
  ])("keeps a %s component at the 64-code-point boundary", (_component, model, name, expected) => {
    expect(formatModelLabel(model, name)).toBe(expected)
  })

  test.each([
    ["provider", { providerID: "p".repeat(65), id: "model" }, "Model", `${"p".repeat(63)}…/Model`],
    ["name", { providerID: "team", id: "model" }, "n".repeat(65), `team/${"n".repeat(63)}…`],
    [
      "variant",
      { providerID: "team", id: "model", variant: "v".repeat(65) },
      "Model",
      `team/Model (V${"v".repeat(62)}…)`,
    ],
  ])("cuts an overlong %s component to 63 code points plus an ellipsis", (_component, model, name, expected) => {
    expect(formatModelLabel(model, name)).toBe(expected)
  })

  test("caps by Unicode code points without splitting an astral character at the boundary", () => {
    const name = `${"a".repeat(62)}😀xx`
    const label = formatModelLabel({ providerID: "team", id: "model" }, name)

    expect(label).toBe(`team/${"a".repeat(62)}😀…`)
    expect(Array.from(label)).toHaveLength(5 + 64)
  })

  test("keeps a 64th astral code point instead of applying a UTF-16-unit cap", () => {
    const name = `${"a".repeat(63)}😀`
    const label = formatModelLabel({ providerID: "team", id: "model" }, name)

    expect(label).toBe(`team/${name}`)
    expect(Array.from(name)).toHaveLength(64)
  })

  test("caps a one-megabyte component in bounded time without retaining control characters", () => {
    const started = performance.now()
    const label = formatModelLabel({ providerID: "team", id: "model" }, `safe${"x".repeat(1_000_000)}\u001b[31m`)

    expect(label).toBe(`team/safe${"x".repeat(59)}…`)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(label).not.toMatch(forbiddenDisplayCharacters)
  })

  test("does not throw when a display component contains a lone surrogate", () => {
    expect(() =>
      formatModelLabel({ providerID: "team\ud800", id: "model", variant: "high\udc00" }, "Model\ud800"),
    ).not.toThrow()
  })

  test.each([
    ["null", null],
    ["number", 42],
    ["string", "team/reviewer"],
    ["array", []],
  ])("treats a %s reference as missing", (_kind, reference) => {
    expect(() => formatModelLabel(reference as Parameters<typeof formatModelLabel>[0])).not.toThrow()
    expect(formatModelLabel(reference as Parameters<typeof formatModelLabel>[0])).toBe("")
  })

  test.each(["providerID", "id", "variant"])(
    "reads a throwing %s reference getter once and returns an empty label",
    (field) => {
      let reads = 0
      const reference = Object.defineProperty({ providerID: "team", id: "reviewer", variant: "thinking" }, field, {
        enumerable: true,
        get() {
          reads += 1
          throw new Error(`${field} getter must not escape`)
        },
      })

      expect(formatModelLabel(reference as Parameters<typeof formatModelLabel>[0])).toBe("")
      expect(reads).toBe(1)
    },
  )

  test("reaches a throwing reference Proxy descriptor trap and returns an empty label", () => {
    let traps = 0
    const reference = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          traps += 1
          throw new Error("reference proxy trap must not escape")
        },
      },
    )

    expect(formatModelLabel(reference as Parameters<typeof formatModelLabel>[0])).toBe("")
    expect(traps).toBe(1)
  })

  test.each(["providerID", "id", "variant"])("reads each stable %s reference getter exactly once", (field) => {
    let reads = 0
    const reference = Object.defineProperty({ providerID: "team", id: "reviewer", variant: "thinking" }, field, {
      enumerable: true,
      get() {
        reads += 1
        if (reads > 1) throw new Error(`${field} was read more than once`)
        return field === "providerID" ? "team" : field === "id" ? "reviewer" : "thinking"
      },
    })

    expect(formatModelLabel(reference as Parameters<typeof formatModelLabel>[0], "Review Model")).toBe(
      "team/Review Model (Thinking)",
    )
    expect(reads).toBe(1)
  })

  test("propagates errors from the caller-supplied variant formatter", () => {
    const error = new Error("caller callback failure")

    expect(() =>
      formatModelLabel({ providerID: "team", id: "reviewer", variant: "thinking" }, "Review Model", () => {
        throw error
      }),
    ).toThrow(error)
  })
})
