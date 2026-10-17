/**
 * @spec-handoff
 * @interface isDisplayOnly(message: unknown): boolean
 * @behavior
 *   - Recognizes only synthetic messages whose `opencode.fork.displayOnly` metadata is exactly true.
 *   - Makes the predicate browser-safe for Core, app, session-ui, and TUI consumers.
 * @edge-cases
 *   - Missing, false, string, or non-synthetic markers remain ordinary messages.
 * @see ../src/fork-command-feedback.ts
 */
import { describe, expect, test } from "bun:test"
import { isDisplayOnly } from "../src/fork-command-feedback.js"

describe("fork command feedback", () => {
  test("recognizes only an exactly marked synthetic message", () => {
    expect(isDisplayOnly({ type: "synthetic", metadata: { "opencode.fork.displayOnly": true } })).toBe(true)

    for (const message of [
      { type: "synthetic", metadata: {} },
      { type: "synthetic", metadata: { "opencode.fork.displayOnly": false } },
      { type: "synthetic", metadata: { "opencode.fork.displayOnly": "true" } },
      { type: "user", metadata: { "opencode.fork.displayOnly": true } },
    ])
      expect(isDisplayOnly(message)).toBe(false)
  })
})
