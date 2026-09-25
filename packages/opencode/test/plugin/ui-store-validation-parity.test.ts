/**
 * @spec-handoff
 * @interface `validatePayload` and `publishDirect` (`@/plugin/ui-store`) — the shared validation
 *   gate (D3) both the external `/plugin-ui/publish` HTTP handler and the plugin runtime's
 *   internal self-flush path (`sendPublish` in `plugin/index.ts`) call before writing to the
 *   retained store.
 * @behavior
 *   - `publishDirect` must reject the EXACT SAME invalid payloads the wire path rejects:
 *     `payload_too_large` (16 KiB, UTF-8 byte-measured, never JS `.length`), `invalid_event_name`,
 *     `invalid_plugin_id`, and `reserved_key` (including nested `data` keys at any depth, and
 *     `pluginID`/`event` themselves).
 *   - A rejected `publishDirect` call must never write into the shared store — no partial write,
 *     no retention of invalid data.
 *   - The direct path must never be a WEAKER gate than the wire path — this is the reason the
 *     validation logic is a single shared function rather than two independently-maintained
 *     copies (D3).
 * @edge-cases
 *   - The byte-vs-code-unit distinction: a CJK string under `MAX_DATA_BYTES` by JS `.length` but
 *     over it by UTF-8 byte count must still be rejected (mirrors the existing HTTP-handler test
 *     in `test/server/httpapi-plugin-ui.test.ts`).
 *   - `__proto__` supplied via `JSON.parse` (a genuine own enumerable property, distinct from a
 *     JS object literal's `__proto__` key) must be caught at top level, nested, and as
 *     `pluginID`/`event` themselves.
 * @see .yui-soul/reviews/293-opencode-plugin-ui-event-channel/r1-sho-e5e6e6b.md
 * @see ../../src/plugin/ui-store.ts (the shared validation gate under test)
 * @see ./test/server/httpapi-plugin-ui.test.ts (the wire-path equivalent of these same checks)
 */

import { expect, test } from "bun:test"
import { directories, publishDirect, storeFor, validatePayload, MAX_DATA_BYTES } from "../../src/plugin/ui-store"
import { disposeInstance } from "../../src/effect/instance-registry"

function freshDirectory(label: string) {
  return `/tmp/kou-e6c-validation-parity-${label}-${Math.random().toString(36).slice(2)}`
}

test("direct path enforces payload_too_large (byte-measured, not .length)", () => {
  // 6000 CJK codepoints: under MAX_DATA_BYTES by .length, over by UTF-8 bytes — the exact
  // distinction the RFC's revision-3 fix (Ei N2) closed on the wire path.
  const big = { note: "\u4f60".repeat(6000) }
  expect(JSON.stringify(big).length).toBeLessThan(MAX_DATA_BYTES)
  expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeGreaterThan(MAX_DATA_BYTES)

  const directory = freshDirectory("size")
  const reason = publishDirect({ directory, workspaceID: undefined, pluginID: "p", event: "e", data: big })
  expect(reason).toBe("payload_too_large")
  // Never a partial write on rejection.
  expect(directories().find(([d]) => d === directory)).toBeUndefined()
})

test("direct path enforces reserved_key at top level, nested depth, and as pluginID/event themselves", () => {
  const directory = freshDirectory("reserved")

  const top = JSON.parse('{"__proto__": {"x": 1}}')
  expect(publishDirect({ directory, workspaceID: undefined, pluginID: "p", event: "e", data: top })).toBe(
    "reserved_key",
  )

  const nested = JSON.parse('{"a": {"b": {"constructor": 1}}}')
  expect(publishDirect({ directory, workspaceID: undefined, pluginID: "p", event: "e", data: nested })).toBe(
    "reserved_key",
  )

  expect(
    publishDirect({ directory, workspaceID: undefined, pluginID: "__proto__", event: "e", data: {} }),
  ).toBe("reserved_key")

  expect(
    publishDirect({ directory, workspaceID: undefined, pluginID: "p", event: "constructor", data: {} }),
  ).toBe("reserved_key")

  // None of the above may have retained anything for this directory.
  expect(directories().find(([d]) => d === directory)).toBeUndefined()
})

test("direct path enforces invalid_event_name and invalid_plugin_id", () => {
  expect(validatePayload({ pluginID: "p", event: "bad name!", data: {} })).toBe("invalid_event_name")
  expect(validatePayload({ pluginID: "", event: "e", data: {} })).toBe("invalid_plugin_id")
  expect(validatePayload({ pluginID: "x".repeat(257), event: "e", data: {} })).toBe("invalid_plugin_id")
})

test("a valid payload passes and Object.prototype is never polluted by the reserved-key scan", () => {
  const directory = freshDirectory("valid")
  const reason = publishDirect({ directory, workspaceID: undefined, pluginID: "p", event: "ok", data: { a: 1 } })
  expect(reason).toBeUndefined()
  expect(({} as any).x).toBeUndefined()

  const [, store] = directories().find(([d]) => d === directory) ?? []
  expect(store).toBeDefined()
})

// D2: the shared module-level store must still be evicted by the existing `registerDisposer`
// disposal hook, exactly like every other per-directory `InstanceState` cell — otherwise the new
// shared store leaks memory per directory that never gets cleaned up.
test("the shared store is evicted by the existing registerDisposer disposal hook", async () => {
  const directory = freshDirectory("disposal")
  storeFor(directory).set("k" as any, new Map())
  expect(directories().some(([d]) => d === directory)).toBe(true)

  await disposeInstance(directory)

  expect(directories().some(([d]) => d === directory)).toBe(false)
})
