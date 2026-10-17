/**
 * @spec-handoff
 * @interface assistantModelLabel(models: readonly Pick<ModelInfo, "providerID" | "modelID" | "name">[] | undefined, message: Pick<SessionMessageAssistant, "model">): string
 * @behavior
 *   - Produces the Provider/Model label for an assistant message through `providerModel`.
 *   - A catalog hit uses the model display name; a miss uses raw ids.
 * @edge-cases
 *   - Does not select a model with the same ID from another provider.
 * @see ../../src/routes/session/assistant-model-label.ts
 */
import { describe, expect, test } from "bun:test"
import type { ModelInfo, SessionMessageAssistant } from "@opencode/client"
import { assistantModelLabel } from "../../src/routes/session/assistant-model-label"

const models = [
  { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
  { providerID: "other", modelID: "claude-sonnet-4-20250514", name: "Other Claude" },
] satisfies Pick<ModelInfo, "providerID" | "modelID" | "name">[]

const message = {
  model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
} satisfies Pick<SessionMessageAssistant, "model">

describe("session AssistantMessage model label", () => {
  test("selects the matching provider model display name", () => {
    expect(assistantModelLabel(models, message)).toBe("anthropic/Claude Sonnet 4")
  })

  test("falls back to raw ids when the model is absent", () => {
    expect(assistantModelLabel(models, { model: { providerID: "anthropic", id: "missing" } })).toBe("anthropic/missing")
  })
})
