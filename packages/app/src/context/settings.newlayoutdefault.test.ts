/**
 * @spec-handoff
 * @interface newLayoutDesignsDefault: boolean (module-level const, settings.tsx)
 * @behavior
 *   Point 6 reconciliation (spec-reconciliation.md): the fork's PWA `index.html` keeps its own
 *   (non-v2) theme colors specifically BECAUSE `newLayoutDesignsDefault` resolves to `false` on
 *   the `prod` channel (`import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"`) — i.e. the v2 layout
 *   is NOT the default experience for production users. If upstream ever silently flips this
 *   default (e.g. removes the `prod` exemption, or defaults to `true` unconditionally), the
 *   static `index.html` colors (chosen to match the v1/fork experience) would start flashing the
 *   wrong theme for the majority of users on first paint, before any JS/flag resolution runs.
 * @edge-cases
 *   - `VITE_OPENCODE_CHANNEL === "prod"` → `newLayoutDesignsDefault === false`.
 *   - `VITE_OPENCODE_CHANNEL` unset or any non-"prod" value (e.g. "dev", "beta") →
 *     `newLayoutDesignsDefault === true`.
 * @testability
 *   `newLayoutDesignsDefault` is computed once at module load from `import.meta.env` (a Vite
 *   build-time constant; under `bun test`, Bun aliases `import.meta.env` to `process.env`). Since
 *   `settings.tsx` is imported by many other files in this same test run, a plain `import` would
 *   read whatever `process.env.VITE_OPENCODE_CHANNEL` was at whatever time some other file first
 *   imported it (module caching). Each case here uses a cache-busting dynamic import (`?channel=`
 *   query) so the module re-evaluates against the exact channel set immediately before.
 * @see ./settings.tsx
 * @see spec-reconciliation.md Point 6 (PWA index.html — final verdict)
 */

import { afterEach, describe, expect, test } from "bun:test"

const ENV_KEY = "VITE_OPENCODE_CHANNEL"
const original = process.env[ENV_KEY]

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = original
})

async function loadWithChannel(channel: string | undefined) {
  if (channel === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = channel
  const mod = await import(`./settings?channel=${channel ?? "unset"}-${Date.now()}-${Math.random()}`)
  return mod.newLayoutDesignsDefault as boolean
}

describe("newLayoutDesignsDefault (Point 6 — PWA index.html regression guard)", () => {
  test('resolves to false on the "prod" channel', async () => {
    expect(await loadWithChannel("prod")).toBe(false)
  })

  test('resolves to true on the "dev" channel', async () => {
    expect(await loadWithChannel("dev")).toBe(true)
  })

  test('resolves to true on the "beta" channel', async () => {
    expect(await loadWithChannel("beta")).toBe(true)
  })

  test("resolves to true when the channel is unset", async () => {
    expect(await loadWithChannel(undefined)).toBe(true)
  })
})
