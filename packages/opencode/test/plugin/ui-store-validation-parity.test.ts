/**
 * @spec-handoff
 * @interface `validatePayload(payload: { pluginID: string; event: string; data: unknown }):
 *   ValidationKind | undefined` and `publishDirect(input: { directory: string; workspaceID:
 *   string | undefined; pluginID: string; event: string; data: unknown }): ValidationKind |
 *   undefined` (`@/plugin/ui-store`) — the shared validation gate (D3) both the external
 *   `/plugin-ui/publish` HTTP handler and the plugin runtime's internal self-flush path
 *   (`sendPublish` in `plugin/index.ts`) call before writing to the retained store.
 * @behavior
 *   - `publishDirect` must reject the EXACT SAME invalid payloads the wire path rejects:
 *     `payload_too_large` (16 KiB, UTF-8 byte-measured, never JS `.length`), `invalid_event_name`,
 *     `invalid_plugin_id`, `reserved_key` (including nested `data` keys at any depth, and
 *     `pluginID`/`event` themselves), and — **new, per round-2 Sho finding #1 (r2-sho-e6c-deadlock.md)** —
 *     `invalid_data`: `data` must decode as a plain JSON object (`Schema.Record(Schema.String,
 *     Schema.Json)` — the exact shape the wire path's upstream `PublishPayload` Schema decode
 *     already enforces via `PluginUiEvent.Custom.data`). A `data` of type `string`, `number`,
 *     `boolean`, `null`, or `Array` must be rejected with `invalid_data`, added to
 *     `ValidationKind`'s union.
 *   - **Fix location (Sho's recommendation, either is acceptable):** (a) extend
 *     `validatePayload` itself to type-check `data` before the byte-length/reserved-key checks —
 *     the byte-length check already calls `JSON.stringify(payload.data)`, so a `typeof
 *     payload.data !== "object" || payload.data === null || Array.isArray(payload.data)` guard
 *     ahead of it closes the gap for BOTH callers in one place (preferred — keeps D3's
 *     single-shared-gate invariant literal); or (b) decode `PublishPayload` via
 *     `Schema.decodeUnknownResult` inside `publishDirect` itself before calling
 *     `validatePayload` (note: this file's own probe confirmed `Schema.decodeUnknownEither` does
 *     not exist on this Effect version's `Schema` namespace — use `Schema.decodeUnknownResult`,
 *     whose `Result.Failure`/`Result.Success` tags are the actual API surface). Either way,
 *     `publishDirect`'s bare `input.data as JsonRecord` cast at ui-store.ts:158 becomes sound
 *     only once one of these runs first.
 *   - A rejected `publishDirect` call must never write into the shared store — no partial write,
 *     no retention of invalid data. This holds for `invalid_data` exactly as it already holds for
 *     the other three `ValidationKind`s.
 *   - The direct path must never be a WEAKER gate than the wire path — this is the reason the
 *     validation logic is a single shared function rather than two independently-maintained
 *     copies (D3). Prior to this fix, `publishDirect` accepted (returned `undefined` for) a
 *     `data` of `"i-am-a-string"`, `12345`, `[1,2,3]`, and `null` — empirically confirmed against
 *     the current unfixed implementation via an out-of-tree probe — while the wire path's
 *     `PublishPayload` Schema decode already rejects every one of these with a 400.
 * @edge-cases
 *   - The byte-vs-code-unit distinction: a CJK string under `MAX_DATA_BYTES` by JS `.length` but
 *     over it by UTF-8 byte count must still be rejected (mirrors the existing HTTP-handler test
 *     in `test/server/httpapi-plugin-ui.test.ts`).
 *   - `__proto__` supplied via `JSON.parse` (a genuine own enumerable property, distinct from a
 *     JS object literal's `__proto__` key) must be caught at top level, nested, and as
 *     `pluginID`/`event` themselves.
 *   - `invalid_data` must be checked BEFORE (or independently of) `payload_too_large` — a
 *     non-object `data` might otherwise `JSON.stringify` to something under 16 KiB and slip past
 *     if the byte-length check were mistaken for "the" type gate.
 * @see .yui-soul/reviews/293-opencode-plugin-ui-event-channel/r1-sho-e5e6e6b.md
 * @see .yui-soul/reviews/293-opencode-plugin-ui-event-channel/r2-sho-e6c-deadlock.md finding #1
 *      (the live, cap-exceeding HIGH this extension closes — round 3 remediation)
 * @see ../../src/plugin/ui-store.ts (the shared validation gate under test)
 * @see ./test/server/httpapi-plugin-ui.test.ts (the wire-path equivalent of these same checks)
 * @see ./test/plugin/ui-store-cross-directory-blast-radius.test.ts (the sibling test proving the
 *      actual blast-radius invariant — a malformed retained row in one directory must not break
 *      `GET /plugin-ui/snapshot` for an unrelated healthy directory)
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

// ---------------------------------------------------------------------------
// Round-3 remediation: r2-sho-e6c-deadlock.md finding #1 (live HIGH, cap-exceeding, rodo
// explicitly chose to fix via audit_rounds 2->3, plan README D10). `publishDirect` currently has
// NO runtime type gate on `data` — only a TypeScript-only `as JsonRecord` cast — so a non-object
// `data` is silently accepted and stored, then breaks `readSnapshot`'s response encoder for the
// ENTIRE aggregated snapshot across ALL directories (cross-directory DoS, see the sibling
// blast-radius test file). These four cases MUST all be rejected, matching the wire path's own
// `PublishPayload` Schema decode (`Schema.Record(Schema.String, Schema.Json)`), which already
// rejects every one of them with a 400 `Expected object, got ...` — confirmed against this file's
// own out-of-tree probe of `PublishPayload` via `Schema.decodeUnknownResult`.
// ---------------------------------------------------------------------------

test("direct path REJECTS a string data payload (currently accepted — red until fixed)", () => {
  const directory = freshDirectory("invalid-data-string")
  const reason = publishDirect({
    directory,
    workspaceID: undefined,
    pluginID: "p",
    event: "e",
    data: "i-am-a-string",
  })
  expect(reason).toBe("invalid_data")
  // Never a partial write on rejection — mirrors the existing payload_too_large/reserved_key
  // no-write assertions above.
  expect(directories().find(([d]) => d === directory)).toBeUndefined()
})

test("direct path REJECTS a number data payload (currently accepted — red until fixed)", () => {
  const directory = freshDirectory("invalid-data-number")
  const reason = publishDirect({ directory, workspaceID: undefined, pluginID: "p", event: "e", data: 12345 })
  expect(reason).toBe("invalid_data")
  expect(directories().find(([d]) => d === directory)).toBeUndefined()
})

test("direct path REJECTS an array data payload (currently accepted — red until fixed)", () => {
  const directory = freshDirectory("invalid-data-array")
  const reason = publishDirect({ directory, workspaceID: undefined, pluginID: "p", event: "e", data: [1, 2, 3] })
  expect(reason).toBe("invalid_data")
  expect(directories().find(([d]) => d === directory)).toBeUndefined()
})

test("direct path REJECTS a null data payload (currently accepted — red until fixed)", () => {
  const directory = freshDirectory("invalid-data-null")
  const reason = publishDirect({ directory, workspaceID: undefined, pluginID: "p", event: "e", data: null })
  expect(reason).toBe("invalid_data")
  expect(directories().find(([d]) => d === directory)).toBeUndefined()
})

test("direct path still accepts a well-formed plain-object data payload after the invalid_data gate lands", () => {
  const directory = freshDirectory("invalid-data-control")
  const reason = publishDirect({
    directory,
    workspaceID: undefined,
    pluginID: "p",
    event: "e",
    data: { valid: true },
  })
  expect(reason).toBeUndefined()
  expect(directories().find(([d]) => d === directory)).toBeDefined()
})

// ---------------------------------------------------------------------------
// Round-4 remediation: round-3's `typeof`/`Array.isArray`/`null` guard only inspected `data`'s
// own TOP-LEVEL shape — a nested `Symbol`/`BigInt` at any depth passed it cleanly and reproduced
// the exact same cross-directory DoS blast radius (r3-sho-publishdirect-fix.md / r3-shin-contracts.md,
// HIGH, round-4-authorized by rodo, plan README D17). `validatePayload` now decodes `data` through
// `Schema.decodeUnknownResult` against the SAME schema the wire path's `PublishPayload` already
// uses (`PluginUiEvent.Custom.data.fields.data`), which recursively validates every nested value.
// ---------------------------------------------------------------------------

test("direct path REJECTS a nested Symbol at depth (currently accepted — red until fixed)", () => {
  const directory = freshDirectory("invalid-data-nested-symbol")
  const reason = publishDirect({
    directory,
    workspaceID: undefined,
    pluginID: "p",
    event: "e",
    data: { nested: { deep: Symbol("x") } },
  })
  expect(reason).toBe("invalid_data")
  expect(directories().find(([d]) => d === directory)).toBeUndefined()
})

test("direct path CLEANLY REJECTS a nested BigInt at depth, not an uncaught throw (currently accepted — red until fixed)", () => {
  const directory = freshDirectory("invalid-data-nested-bigint")
  // Must not throw — a hand-rolled recursive walker could plausibly explode on a BigInt reaching
  // `JSON.stringify` inside the byte-length check; the schema decode must reject it BEFORE that
  // point, as a clean `invalid_data` return, same as every other `ValidationKind`.
  let reason: ReturnType<typeof publishDirect>
  expect(() => {
    reason = publishDirect({
      directory,
      workspaceID: undefined,
      pluginID: "p",
      event: "e",
      data: { nested: { deep: 10n } },
    })
  }).not.toThrow()
  expect(reason).toBe("invalid_data")
  expect(directories().find(([d]) => d === directory)).toBeUndefined()
})

test("direct path still accepts a well-formed NESTED plain-object data payload (control, not over-rejected)", () => {
  const directory = freshDirectory("invalid-data-nested-control")
  const reason = publishDirect({
    directory,
    workspaceID: undefined,
    pluginID: "p",
    event: "e",
    data: { nested: { deep: { a: 1, b: "x", c: [1, 2, 3], d: null } } },
  })
  expect(reason).toBeUndefined()
  expect(directories().find(([d]) => d === directory)).toBeDefined()
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
