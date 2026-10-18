/**
 * @spec-handoff
 * @interface formatModelLabel(model: ModelLabelRef | undefined, name?: string, formatVariant?: FormatModelVariant): string
 * @behavior
 *   - Sanitizes each display component without changing raw lookup identities.
 *   - Renders safe resolved names or safe raw IDs and non-default variants.
 * @edge-cases
 *   - Sanitized-empty components fall back or are omitted; each is capped at 64 code points.
 *   - Missing raw reference identity returns an empty label without throwing for malformed Unicode.
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
    expect(formatModelLabel({ providerID: "team", id: "\u001b\u202e" }, "\u001b\u202e")).toBe("team")
    expect(formatModelLabel({ providerID: "\u001b\u202e", id: "model" }, "Model")).toBe("Model")
    expect(formatModelLabel({ providerID: "team", id: "model", variant: "\u001b\u202e" }, "Model")).toBe("team/Model")
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
})
