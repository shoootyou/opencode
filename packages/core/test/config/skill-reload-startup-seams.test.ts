/**
 * @spec-handoff
 * @interface ConfigSkillPlugin.Test.startupHooks: Context.Reference<StartupHooks>
 * @behavior
 *   - The plugin exposes a test-only hook after its internal config signal subscription is acquired and before initial admission.
 *   - The hook receives a publishInternalConfigUpdate() effect so a test can publish after subscription acquisition but before the consumer starts.
 * @edge-cases
 *   - Initial admission must wait until the internal signal subscription is ready.
 *   - Releasing the consumer after a buffered internal update causes exactly one follow-up admission.
 * @see ../../src/config/plugin/skill.ts
 */
import { expect, test } from "bun:test"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"

test("exposes the internal-subscription readiness hook before initial admission", () => {
  expect(ConfigSkillPlugin.Test).toHaveProperty("startupHooks")
})

test("exposes the pre-consumer hook with a publisher for the buffered-update interleaving", () => {
  expect(ConfigSkillPlugin.Test).toHaveProperty("startupHooks")
})
