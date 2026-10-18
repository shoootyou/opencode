/**
 * @spec-handoff
 * @interface formatModelLabel(model: ModelLabelRef | undefined, name?: string, formatVariant?: FormatModelVariant): string
 * @behavior
 *   - Renders raw providerID plus the resolved name or raw model id.
 *   - Renders non-default variants with app-compatible first-code-unit capitalization.
 * @edge-cases
 *   - Missing or empty identity returns an empty label.
 *   - Empty/default variants add no suffix; catalog strings remain unchanged.
 * @see ../../session-ui/src/message/model-label.ts
 */
import { describe, expect, test } from "bun:test"
import { formatModelLabel } from "./model-label.js"

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

  test("preserves nested IDs and an explicit empty catalog name without rewriting them", () => {
    expect(formatModelLabel({ providerID: "team/vendor", id: "reviewer/v1" })).toBe("team/vendor/reviewer/v1")
    expect(formatModelLabel({ providerID: "team", id: "reviewer" }, "")).toBe("team/")
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
})
