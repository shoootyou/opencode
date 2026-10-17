/**
 * @spec-handoff
 * @interface providerModel(models: readonly Pick<ModelInfo, "providerID" | "modelID" | "name">[] | undefined, providerID: string, modelID: string): string
 * @behavior
 *   - Returns "<providerID>/<model display name>" for a catalog hit.
 *   - Returns "<providerID>/<modelID>" when the catalog is absent or model is unknown.
 * @edge-cases
 *   - A model from another provider is not a hit.
 *   - The separator is exactly one slash with no surrounding spaces.
 * @see packages/tui/src/util/model.ts
 */
import { describe, expect, test } from "bun:test"
import type { ModelInfo } from "@opencode/client"
import { providerModel } from "../../src/util/model"

const models = [
  { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
  { providerID: "openai", modelID: "gpt-5", name: "GPT-5" },
] satisfies Pick<ModelInfo, "providerID" | "modelID" | "name">[]

describe("util.model.providerModel", () => {
  test("returns the provider id and catalog model display name", () => {
    expect(providerModel(models, "anthropic", "claude-sonnet-4-20250514")).toBe("anthropic/Claude Sonnet 4")
  })

  test("does not select an identically named model from another provider", () => {
    expect(providerModel(models, "anthropic", "gpt-5")).toBe("anthropic/gpt-5")
  })

  test("falls back to raw provider and model ids for an unknown model", () => {
    expect(providerModel(models, "anthropic", "claude-unknown")).toBe("anthropic/claude-unknown")
  })

  test("falls back to raw provider and model ids without a catalog", () => {
    expect(providerModel(undefined, "anthropic", "claude-sonnet-4-20250514")).toBe("anthropic/claude-sonnet-4-20250514")
  })

  test("uses exactly one unspaced slash separator", () => {
    const result = providerModel(models, "anthropic", "claude-sonnet-4-20250514")
    expect(result).not.toContain(" / ")
    expect(result.split("/")).toHaveLength(2)
  })
})
