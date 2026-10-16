/**
 * @spec-handoff
 * @interface formatModelLabel(providerID: string | undefined, modelID: string | undefined, provider: { models: Record<string, { name: string }> } | undefined): string
 * @interface formatMessageContentModelLabel(model: { providerID: string; id: string; variant?: string }, provider: { models: Record<string, { name: string }> } | undefined, formatVariant: (model: string, variant: string) => string): string
 * @behavior
 *   - Renders the v2 label as "<providerID>/<model display name>".
 *   - Uses raw ids when the model catalog entry is unavailable.
 *   - The message-content helper uses that label before adding a non-default variant.
 * @edge-cases
 *   - Missing providerID or modelID returns "" and never a stray slash.
 *   - The default variant is omitted; a non-default variant delegates to `formatVariant`.
 * @see ../message/message-content.tsx
 */
import { describe, expect, test } from "bun:test"
import { formatMessageContentModelLabel, formatModelLabel } from "./message-part-model"

function provider() {
  return {
    models: {
      "claude-sonnet-4-20250514": { name: "Claude Sonnet" },
    },
  }
}

describe("formatModelLabel", () => {
  test("catalog hit renders provider id and model display name", () => {
    expect(formatModelLabel("anthropic", "claude-sonnet-4-20250514", provider())).toBe("anthropic/Claude Sonnet")
  })

  test("catalog miss falls back to raw providerID/modelID", () => {
    expect(formatModelLabel("anthropic", "claude-sonnet-4-20250514", undefined)).toBe(
      "anthropic/claude-sonnet-4-20250514",
    )
  })

  test("partial catalog miss renders the raw model id", () => {
    expect(formatModelLabel("anthropic", "unknown-model", provider())).toBe("anthropic/unknown-model")
  })

  test("returns empty string when modelID is absent", () => {
    expect(formatModelLabel("anthropic", undefined, provider())).toBe("")
  })

  test("returns empty string when providerID is absent", () => {
    expect(formatModelLabel(undefined, "claude-sonnet-4-20250514", provider())).toBe("")
  })
})

describe("message-content model label", () => {
  test("uses the Provider/Model label for the default variant", () => {
    expect(
      formatMessageContentModelLabel(
        { providerID: "anthropic", id: "claude-sonnet-4-20250514", variant: "default" },
        provider(),
        (model, variant) => `${model} (${variant})`,
      ),
    ).toBe("anthropic/Claude Sonnet")
  })

  test("formats a non-default variant after resolving the Provider/Model label", () => {
    expect(
      formatMessageContentModelLabel(
        { providerID: "anthropic", id: "claude-sonnet-4-20250514", variant: "thinking" },
        provider(),
        (model, variant) => `${model} (${variant})`,
      ),
    ).toBe("anthropic/Claude Sonnet (Thinking)")
  })
})
