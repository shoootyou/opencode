/**
 * @spec-handoff
 * @interface shouldKeepSessionScopeBinding(input: { archiveBindings(): readonly unknown[]; matchesCtrlA(binding: unknown): boolean }): boolean
 * @behavior
 *   - Re-evaluates the current archive bindings whenever queried, rather than retaining an opening-time snapshot.
 *   - Keeps the session-list Ctrl+A scope binding unless either archive action currently consumes Ctrl+A.
 * @edge-cases
 *   - Ctrl+B and an empty binding set do not conflict with Ctrl+A.
 *   - The matcher is injected so production uses Keymap's canonical sequence/leader matcher, not shortcut-selector output.
 * @see ../src/component/session-list-model.ts
 */
import { expect, test } from "bun:test"

type ScopePolicyModule = {
  shouldKeepSessionScopeBinding?: (input: {
    archiveBindings: () => readonly unknown[]
    matchesCtrlA: (binding: unknown) => boolean
  }) => boolean
}

test("re-evaluates archive bindings after config reload without treating Ctrl+B as a Ctrl+A conflict", async () => {
  const subject: ScopePolicyModule = await import("../src/component/session-list-model").catch(() => ({}))
  expect(subject.shouldKeepSessionScopeBinding).toBeTypeOf("function")

  let configured: readonly unknown[] = []
  const input = {
    archiveBindings: () => configured,
    matchesCtrlA: (binding: unknown) => binding === "ctrl+a",
  }

  expect(subject.shouldKeepSessionScopeBinding!(input)).toBe(true)
  configured = ["ctrl+b"]
  expect(subject.shouldKeepSessionScopeBinding!(input)).toBe(true)
  configured = ["ctrl+a"]
  expect(subject.shouldKeepSessionScopeBinding!(input)).toBe(false)
  configured = []
  expect(subject.shouldKeepSessionScopeBinding!(input)).toBe(true)
})
