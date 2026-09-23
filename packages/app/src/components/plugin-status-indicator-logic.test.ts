/**
 * @spec-handoff
 * @interface
 *   Module: `./plugin-status-indicator-logic` (packages/app/src/components/plugin-status-indicator-logic.ts)
 *   ZERO UI IMPORTS — no solid-js, no @opencode-ai/ui, no @kobalte/core. Plain TypeScript only,
 *   so this test file needs no `--preload ./happydom.ts` shim and cannot hit the shim's
 *   `classList`/eager-JSX-evaluation limitations (see `packages/app/AGENTS.md`'s SolidJS notes
 *   and this repo's `titlebar-tab-order.ts` precedent for the pattern this file mirrors).
 *
 *   ```ts
 *   export type PluginID = string
 *   export type EventName = string
 *   export type AuthoredStatus = "ok" | "info" | "warn" | "error"   // what a plugin may write to `_ui.status`
 *   export type Severity = AuthoredStatus | "unknown"                // what the UI actually renders
 *
 *   export const SEVERITY_RANK: Record<Severity, number>  // ok:0 info:1 unknown:2 warn:3 error:4
 *   export const DEFAULT_TTL_SECONDS = 300
 *   export const EVENTS_PER_PLUGIN_CAP = 16
 *   export const PLUGINS_CAP = 32
 *
 *   export interface Entry {
 *     data: Record<string, unknown>   // full decoded `data` payload, INCLUDING `_ui` if present
 *     receivedAt: number              // client-clock epoch ms — the store's one age axis (§2e)
 *   }
 *
 *   export type PluginBucket = Map<EventName, Entry>
 *   export type Store = Map<PluginID, PluginBucket>
 *
 *   export function createStore(): Store
 *
 *   // Writes/refreshes one (pluginID, eventName) entry and applies the D19 caps on every write:
 *   // touching an existing (pluginID, eventName) pair refreshes its recency (moves it to
 *   // most-recently-updated) rather than treating it as a new entry for eviction purposes.
 *   // `receivedAt` is caller-supplied (never `Date.now()` internally) so callers control the
 *   // clock: the live-SSE call site passes `Date.now()` at arrival; the snapshot-merge call site
 *   // passes the output of `snapshotReceivedAt(...)` below. Both paths funnel through this one
 *   // function, which is what makes "snapshot merge does not bypass the caps" true by construction.
 *   export function writeEntry(
 *     store: Store,
 *     pluginID: PluginID,
 *     eventName: EventName,
 *     data: Record<string, unknown>,
 *     receivedAt: number,
 *   ): void
 *
 *   // RFC §2e "Timestamps and clock skew — one clock, no skew". Pure arithmetic over RAW
 *   // epoch-millisecond numbers (never decoded `DateTime.Utc` values — subtracting those is
 *   // invalid). `serverTimeMillis` and `publishedAtMillis` come from the same server clock in the
 *   // same snapshot response, so their difference is a skew-free elapsed duration.
 *   export function snapshotReceivedAt(
 *     nowMillis: number,
 *     serverTimeMillis: number,
 *     publishedAtMillis: number,
 *   ): number
 *
 *   // RFC §2d status vocabulary. Reads `entry.data._ui.status`; downgrades to "unknown" when:
 *   //   - `_ui` is absent, or present but not a plain object, or
 *   //   - `_ui.status` is absent or not one of the 4 recognized `AuthoredStatus` literals, or
 *   //   - the entry is stale: `nowMillis - entry.receivedAt > (ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000`
 *   //     — regardless of what `_ui.status` says (a stale "error" still downgrades to "unknown").
 *   // `ttlSeconds` comes from `entry.data._ui.ttlSeconds` when present and a positive number, else
 *   // `DEFAULT_TTL_SECONDS`.
 *   export function effectiveSeverity(entry: Entry, nowMillis: number): Severity
 *
 *   export interface Row {
 *     pluginID: PluginID
 *     eventName: EventName
 *     severity: Severity
 *     entry: Entry
 *   }
 *
 *   // Flattens the store into one Row per (pluginID, eventName) leaf, UNSORTED.
 *   export function toRows(store: Store, nowMillis: number): Row[]
 *
 *   // Total order per RFC §2d: severity desc (via SEVERITY_RANK), then pluginID asc, then
 *   // eventName asc, both by code-unit order. `(pluginID, eventName)` is unique so ties never
 *   // occur past the third key.
 *   export function sortRows(rows: Row[]): Row[]
 *
 *   export type CollapseView =
 *     | { kind: "none" }
 *     | { kind: "glyphs"; rows: Row[] }
 *     | { kind: "badge"; severity: Severity; count: number; rows: Row[] }
 *
 *   // Applies the RFC §2d rendering-rules threshold over ALREADY-SORTED rows:
 *   //   0 rows -> { kind: "none" }
 *   //   1-3 rows -> { kind: "glyphs", rows }  (rows, in the given sort order, one glyph each)
 *   //   >3 rows -> { kind: "badge", severity: <worst = rows[0].severity>, count: rows.length, rows }
 *   // `count` is always the entry count, never a distinct-plugin count.
 *   export function collapseView(rows: Row[]): CollapseView
 *
 *   // Selects the plain `key: value` rows to render for one entry: every top-level key of
 *   // `entry.data` EXCEPT `_ui`, sorted ascending by key (code-unit order). `_ui`'s own sub-keys
 *   // are NEVER included here regardless of whether `_ui` itself is a valid object.
 *   export function dataRows(entry: Entry): Array<[string, unknown]>
 *
 *   // RFC §2e/D9: refetch `GET /plugin-ui/snapshot` on every `server.connected` event (initial
 *   // connect AND every reconnect). Pure predicate, mirrors this repo's existing
 *   // `home-session-index.ts`/`event-reducer.ts` style (stateless per-call boolean over an event
 *   // type string) rather than introducing a new reducer shape.
 *   export function shouldRefetchSnapshot(eventType: string): boolean
 *   ```
 *
 * @behavior
 *   - Store is `Map`-based at every level; a `pluginID` of `__proto__` is an ordinary Map key with
 *     no special meaning and never touches `Object.prototype` (D16).
 *   - One `(pluginID, eventName)` pair is the atomic render unit; a plugin reporting under two
 *     event names yields two independently-sortable rows (D6/§2d).
 *   - Sort is a total, deterministic order: severity desc, pluginID asc, eventName asc (D17).
 *   - `unknown` outranks `ok`/`info` but not `warn`/`error` (D17) — "no news" must never look like
 *     "all good".
 *   - Rendering-rule thresholds count entries, never distinct plugins (§2d).
 *   - `_ui` is a reserved namespace: never rendered via `dataRows`, and a non-object `_ui` is
 *     treated as "no presentation metadata" (`effectiveSeverity` returns `unknown`) without
 *     throwing.
 *   - TTL past-due downgrades severity to `unknown` but the entry is never removed from the store —
 *     eviction is governed exclusively by the D19 caps (16 event names/plugin, 32 plugins), by
 *     `receivedAt` recency, never by TTL and never by insertion order.
 *   - `writeEntry` is the single write path for both live-SSE arrivals and snapshot-merge writes,
 *     so the D19 caps bound both uniformly (a snapshot cannot inflate the store past them).
 *   - `snapshotReceivedAt` cancels server/client clock skew: it is a function of the *elapsed
 *     duration* between `serverTimeMillis` and `publishedAtMillis` (both same-clock), not of any
 *     absolute timestamp comparison across clocks.
 *
 * @edge-cases
 *   - Empty store → `toRows` returns `[]`; `collapseView([])` returns `{ kind: "none" }`.
 *   - Exactly 3 rows → `{ kind: "glyphs" }`, not `{ kind: "badge" }` (threshold is `> 3`, not `>= 3`).
 *   - Exactly 4 rows → `{ kind: "badge" }`.
 *   - A single plugin alone reporting 4+ event names collapses on its own (§2d).
 *   - `_ui` present but a string/number/array (not a plain object) → `effectiveSeverity` returns
 *     `"unknown"`, `dataRows` still excludes the literal `_ui` key, no throw.
 *   - `_ui.status` an unrecognized string (e.g. `"critical"`) → treated as absent → `unknown`.
 *   - Re-writing an already-present `(pluginID, eventName)` pair with a larger `receivedAt` must
 *     move it to most-recently-updated for eviction purposes — eviction order is by *last update*,
 *     never by original insertion order.
 *   - The 33rd distinct `pluginID` evicts the WHOLE least-recently-updated plugin bucket (by that
 *     bucket's own most-recently-updated entry), never a partial bucket.
 *
 * @see .yui-soul/rfcs/approved/050-opencode-plugin-ui-event-channel/README.md (§2d, §2e, D6, D9,
 *      D16, D17, D19)
 * @see packages/app/src/components/titlebar-tab-order.ts (the zero-UI-import module pattern this
 *      file's companion module mirrors)
 * @see packages/app/src/components/plugin-status-indicator.test.tsx (the companion DOM-mount test
 *      file — XSS acceptance criteria, Popover tap behavior, and `_ui`-vs-plain-key DOM rendering
 *      live there, NOT here, because those specifically require real DOM insertion to verify
 *      `textContent`-vs-`innerHTML` behavior; this file only proves the selection/sort/collapse/
 *      eviction MATH, which needs no DOM and no solid-js shim at all)
 */

import { describe, expect, test } from "bun:test"
import {
  collapseView,
  createStore,
  DEFAULT_TTL_SECONDS,
  dataRows,
  effectiveSeverity,
  EVENTS_PER_PLUGIN_CAP,
  PLUGINS_CAP,
  shouldRefetchSnapshot,
  snapshotReceivedAt,
  sortRows,
  toRows,
  writeEntry,
} from "./plugin-status-indicator-logic"

// ---------------------------------------------------------------------------
// Task 1 / Group 1 — Map-based store, __proto__ safety (D16)
// ---------------------------------------------------------------------------
describe("store safety — Map, never Record", () => {
  test("a pluginID of '__proto__' does not pollute Object.prototype", () => {
    const store = createStore()
    writeEntry(store, "__proto__", "probe", { ok: true }, 1_000)

    // Object.prototype itself must remain untouched.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).probe).toBeUndefined()

    // The entry is nonetheless retained under the literal Map key "__proto__".
    expect(store instanceof Map).toBe(true)
    expect(store.get("__proto__")).toBeInstanceOf(Map)
    expect(store.get("__proto__")?.get("probe")?.data).toEqual({ ok: true })
  })

  test("an eventName of 'constructor' is an ordinary Map key, not a property lookup", () => {
    const store = createStore()
    writeEntry(store, "plugin-a", "constructor", { x: 1 }, 1_000)
    expect(store.get("plugin-a")?.get("constructor")?.data).toEqual({ x: 1 })
    expect(store.get("plugin-a")?.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Task 1 / Group 2 — Granularity: one plugin, two event names → two rows
// ---------------------------------------------------------------------------
describe("rendering granularity — (pluginID, eventName), never plugin", () => {
  test("one plugin reporting two event names produces two independent rows", () => {
    const store = createStore()
    writeEntry(store, "budget", "spend", { _ui: { status: "error" } }, 1_000)
    writeEntry(store, "budget", "probe", { _ui: { status: "ok" } }, 1_000)

    const rows = toRows(store, 1_000)
    expect(rows).toHaveLength(2)
    const eventNames = rows.map((row) => row.eventName).sort()
    expect(eventNames).toEqual(["probe", "spend"])
  })

  test("two plugins reporting one event each and one plugin reporting two events both yield 2 rows", () => {
    const twoPlugins = createStore()
    writeEntry(twoPlugins, "a", "e", {}, 1_000)
    writeEntry(twoPlugins, "b", "e", {}, 1_000)

    const onePluginTwoEvents = createStore()
    writeEntry(onePluginTwoEvents, "a", "e1", {}, 1_000)
    writeEntry(onePluginTwoEvents, "a", "e2", {}, 1_000)

    expect(toRows(twoPlugins, 1_000)).toHaveLength(2)
    expect(toRows(onePluginTwoEvents, 1_000)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Task 1 / Group 3 — Sort order: severity desc, pluginID asc, eventName asc (D17)
// ---------------------------------------------------------------------------
describe("sortRows — total deterministic order", () => {
  test("orders by severity descending first", () => {
    const store = createStore()
    writeEntry(store, "p", "ok-event", { _ui: { status: "ok" } }, 1_000)
    writeEntry(store, "p", "error-event", { _ui: { status: "error" } }, 1_000)
    writeEntry(store, "p", "warn-event", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    expect(sorted.map((row) => row.eventName)).toEqual(["error-event", "warn-event", "ok-event"])
  })

  test("breaks severity ties by pluginID ascending", () => {
    const store = createStore()
    writeEntry(store, "zebra", "e", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "alpha", "e", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    expect(sorted.map((row) => row.pluginID)).toEqual(["alpha", "zebra"])
  })

  test("breaks pluginID ties by eventName ascending — the tie-breaker only meaningful at entry granularity", () => {
    const store = createStore()
    writeEntry(store, "budget", "zzz", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "budget", "aaa", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    expect(sorted.map((row) => row.eventName)).toEqual(["aaa", "zzz"])
  })

  test("is a total order — (pluginID, eventName) uniqueness means ties never survive all three keys", () => {
    const store = createStore()
    writeEntry(store, "b", "y", { _ui: { status: "ok" } }, 1_000)
    writeEntry(store, "a", "z", { _ui: { status: "error" } }, 1_000)
    writeEntry(store, "a", "y", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "b", "z", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    // error(a,z) > warn(a,y) & warn(b,z) tie-broken by pluginID asc > ok(b,y)
    expect(sorted.map((row) => `${row.pluginID}:${row.eventName}`)).toEqual(["a:z", "a:y", "b:z", "b:y"])
  })
})

// ---------------------------------------------------------------------------
// Task 1 / Group 4 — Rendering rules: 0 / 1-3 / >3
// ---------------------------------------------------------------------------
describe("collapseView — rendering-rule thresholds count entries, never plugins", () => {
  test("zero entries collapse to 'none' (no empty box, no placeholder)", () => {
    expect(collapseView([])).toEqual({ kind: "none" })
  })

  test("1-3 entries render one glyph each, in sort order", () => {
    const store = createStore()
    writeEntry(store, "a", "e1", {}, 1_000)
    writeEntry(store, "a", "e2", {}, 1_000)
    writeEntry(store, "a", "e3", {}, 1_000)
    const view = collapseView(sortRows(toRows(store, 1_000)))
    expect(view.kind).toBe("glyphs")
    if (view.kind === "glyphs") expect(view.rows).toHaveLength(3)
  })

  test("exactly 3 does not collapse — threshold is strictly greater than 3", () => {
    const rows = [1, 2, 3].map((n) => ({
      pluginID: "p",
      eventName: `e${n}`,
      severity: "ok" as const,
      entry: { data: {}, receivedAt: 1_000 },
    }))
    expect(collapseView(rows).kind).toBe("glyphs")
  })

  test("4 entries collapse to a single aggregate badge with worst severity + entry count", () => {
    const store = createStore()
    writeEntry(store, "budget", "e1", { _ui: { status: "ok" } }, 1_000)
    writeEntry(store, "budget", "e2", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "budget", "e3", { _ui: { status: "info" } }, 1_000)
    writeEntry(store, "budget", "e4", { _ui: { status: "ok" } }, 1_000)

    const view = collapseView(sortRows(toRows(store, 1_000)))
    expect(view.kind).toBe("badge")
    if (view.kind === "badge") {
      expect(view.severity).toBe("warn")
      expect(view.count).toBe(4) // entry count, NEVER plugin count
      expect(view.rows).toHaveLength(4)
    }
  })

  test("a single plugin holding 4+ event names collapses on its own", () => {
    const store = createStore()
    for (let i = 0; i < 4; i++) writeEntry(store, "chatty", `event-${i}`, {}, 1_000)
    expect(collapseView(sortRows(toRows(store, 1_000))).kind).toBe("badge")
  })

  test("16 entries from one plugin still report entry count, never distinct-plugin count of 1", () => {
    const store = createStore()
    for (let i = 0; i < EVENTS_PER_PLUGIN_CAP; i++) writeEntry(store, "chatty", `event-${i}`, {}, 1_000 + i)
    const view = collapseView(sortRows(toRows(store, 1_000 + EVENTS_PER_PLUGIN_CAP)))
    expect(view.kind).toBe("badge")
    if (view.kind === "badge") expect(view.count).toBe(EVENTS_PER_PLUGIN_CAP)
  })
})

// ---------------------------------------------------------------------------
// Task 1 / Group 5 — `_ui` reserved namespace
// ---------------------------------------------------------------------------
describe("_ui reserved namespace", () => {
  test("_ui is never rendered as a key: value row", () => {
    const entry = { data: { _ui: { status: "warn", label: "X" }, spendPct: 82 }, receivedAt: 1_000 }
    const rows = dataRows(entry)
    expect(rows.find(([key]) => key === "_ui")).toBeUndefined()
    expect(rows).toEqual([["spendPct", 82]])
  })

  test("unrecognized _ui sub-keys are ignored entirely, not rendered, no throw", () => {
    const entry = { data: { _ui: { status: "ok", futureKey: "not yet defined" }, a: 1 }, receivedAt: 1_000 }
    expect(() => effectiveSeverity(entry, 1_000)).not.toThrow()
    expect(effectiveSeverity(entry, 1_000)).toBe("ok")
    expect(dataRows(entry)).toEqual([["a", 1]])
  })

  test("a _ui present but not an object is treated as no presentation metadata (status: unknown)", () => {
    const stringUi = { data: { _ui: "not-an-object", a: 1 }, receivedAt: 1_000 }
    const arrayUi = { data: { _ui: [1, 2, 3], a: 1 }, receivedAt: 1_000 }
    const numberUi = { data: { _ui: 42, a: 1 }, receivedAt: 1_000 }

    expect(effectiveSeverity(stringUi, 1_000)).toBe("unknown")
    expect(effectiveSeverity(arrayUi, 1_000)).toBe("unknown")
    expect(effectiveSeverity(numberUi, 1_000)).toBe("unknown")

    // and _ui is still excluded from dataRows in every case, without throwing
    expect(dataRows(stringUi)).toEqual([["a", 1]])
    expect(dataRows(arrayUi)).toEqual([["a", 1]])
    expect(dataRows(numberUi)).toEqual([["a", 1]])
  })

  test("every other top-level key renders as a plain key: value row in ascending key order", () => {
    const entry = { data: { _ui: { status: "ok" }, zKey: "z", aKey: "a", mKey: "m" }, receivedAt: 1_000 }
    expect(dataRows(entry)).toEqual([
      ["aKey", "a"],
      ["mKey", "m"],
      ["zKey", "z"],
    ])
  })

  test("no data keys other than _ui renders an empty row list, not an error", () => {
    const entry = { data: { _ui: { status: "ok" } }, receivedAt: 1_000 }
    expect(dataRows(entry)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Task 1 / Group 6 — status vocabulary: closed, ordered, total (D17)
// ---------------------------------------------------------------------------
describe("status vocabulary — closed, ordered, total", () => {
  test("ok(0) < info(1) < unknown(2) < warn(3) < error(4)", () => {
    const now = 1_000
    const ok = effectiveSeverity({ data: { _ui: { status: "ok" } }, receivedAt: now }, now)
    const info = effectiveSeverity({ data: { _ui: { status: "info" } }, receivedAt: now }, now)
    const unknown = effectiveSeverity({ data: {}, receivedAt: now }, now)
    const warn = effectiveSeverity({ data: { _ui: { status: "warn" } }, receivedAt: now }, now)
    const error = effectiveSeverity({ data: { _ui: { status: "error" } }, receivedAt: now }, now)

    expect([ok, info, unknown, warn, error]).toEqual(["ok", "info", "unknown", "warn", "error"])

    const rank = { ok: 0, info: 1, unknown: 2, warn: 3, error: 4 }
    expect(rank[ok]).toBeLessThan(rank[info])
    expect(rank[info]).toBeLessThan(rank[unknown])
    expect(rank[unknown]).toBeLessThan(rank[warn])
    expect(rank[warn]).toBeLessThan(rank[error])
  })

  test("unknown ranks ABOVE ok/info — 'no news' must never sort as 'all good'", () => {
    const store = createStore()
    writeEntry(store, "a", "unknown-event", {}, 1_000) // no _ui at all -> unknown
    writeEntry(store, "a", "ok-event", { _ui: { status: "ok" } }, 1_000)
    writeEntry(store, "a", "info-event", { _ui: { status: "info" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    expect(sorted[0].eventName).toBe("unknown-event")
  })

  test("an unrecognized status string is treated as unknown, not silently accepted", () => {
    const entry = { data: { _ui: { status: "critical" } }, receivedAt: 1_000 }
    expect(effectiveSeverity(entry, 1_000)).toBe("unknown")
  })

  test("a stale entry is downgraded to unknown regardless of its last-known status, even 'error'", () => {
    const receivedAt = 1_000
    const ttlSeconds = 300
    const staleNow = receivedAt + ttlSeconds * 1_000 + 1 // 1ms past TTL
    const entry = { data: { _ui: { status: "error", ttlSeconds } }, receivedAt }
    expect(effectiveSeverity(entry, staleNow)).toBe("unknown")
  })

  test("an entry exactly at TTL boundary is not yet stale; one ms later it is", () => {
    const receivedAt = 1_000
    const ttlSeconds = 300
    const entry = { data: { _ui: { status: "ok", ttlSeconds } }, receivedAt }
    expect(effectiveSeverity(entry, receivedAt + ttlSeconds * 1_000)).toBe("ok")
    expect(effectiveSeverity(entry, receivedAt + ttlSeconds * 1_000 + 1)).toBe("unknown")
  })

  test("default TTL of 300s applies when _ui.ttlSeconds is absent", () => {
    const receivedAt = 1_000
    const entry = { data: { _ui: { status: "ok" } }, receivedAt }
    expect(effectiveSeverity(entry, receivedAt + DEFAULT_TTL_SECONDS * 1_000 - 1)).toBe("ok")
    expect(effectiveSeverity(entry, receivedAt + DEFAULT_TTL_SECONDS * 1_000 + 1)).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 1 — one age axis: receivedAt is caller-supplied client-clock time
// ---------------------------------------------------------------------------
describe("freshness — one age axis, client clock only for live arrivals", () => {
  test("writeEntry stores the caller-supplied receivedAt verbatim (the live-SSE call site's Date.now())", () => {
    const store = createStore()
    const arrivalTime = 1_726_000_000_000
    writeEntry(store, "p", "e", { hello: "world" }, arrivalTime)
    expect(store.get("p")?.get("e")?.receivedAt).toBe(arrivalTime)
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 2 — skew-free snapshot merge
// ---------------------------------------------------------------------------
describe("snapshotReceivedAt — skew-free clock derivation (§2e)", () => {
  test("derives receivedAt from the elapsed server-side duration, not from absolute clock comparison", () => {
    const serverTime = 1_700_000_000_000
    const publishedAt = serverTime - 5_000 // published 5s before the snapshot was taken, server clock
    const clientNow = 1_700_000_100_000 // an arbitrary, unrelated client clock value (simulated skew)

    const receivedAt = snapshotReceivedAt(clientNow, serverTime, publishedAt)
    // The elapsed duration (5s) must be preserved regardless of the absolute skew between clocks.
    expect(clientNow - receivedAt).toBe(5_000)
  })

  test("snapshot-derived age matches live-event age for the same elapsed duration under a non-zero clock offset", () => {
    const elapsedMs = 42_000

    // Live path: an event that arrived 42s before "now" on the client's own clock.
    const clientNow = 5_000_000
    const liveReceivedAt = clientNow - elapsedMs

    // Snapshot path: same 42s elapsed duration, but expressed via a server clock that is offset
    // by an arbitrary +37s from the client clock (simulated skew) — the formula must still recover
    // exactly 42s of elapsed time, not 42s +/- the skew term.
    const skewMs = 37_000
    const serverTime = clientNow + skewMs
    const publishedAt = serverTime - elapsedMs
    const snapshotReceived = snapshotReceivedAt(clientNow, serverTime, publishedAt)

    expect(clientNow - snapshotReceived).toBe(clientNow - liveReceivedAt)
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 3 — TTL is presentational, never an eviction trigger
// ---------------------------------------------------------------------------
describe("TTL never evicts", () => {
  test("an entry past its TTL is downgraded to unknown but remains in the store and the row list", () => {
    const store = createStore()
    const receivedAt = 1_000
    writeEntry(store, "p", "e", { _ui: { status: "error", ttlSeconds: 60 } }, receivedAt)

    const farFuture = receivedAt + 10 * 60 * 1_000 // 10 minutes later — well past a 60s TTL
    expect(store.get("p")?.has("e")).toBe(true) // never removed

    const rows = toRows(store, farFuture)
    expect(rows).toHaveLength(1)
    expect(rows[0].severity).toBe("unknown") // downgraded, not deleted
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 4 — client-side eviction (D19), against live-arrival-shaped writes
// ---------------------------------------------------------------------------
describe("client-side eviction (D19)", () => {
  test("the 17th distinct eventName for one plugin evicts that plugin's least-recently-updated entry", () => {
    const store = createStore()
    for (let i = 0; i < EVENTS_PER_PLUGIN_CAP; i++) {
      writeEntry(store, "chatty", `event-${i}`, {}, 1_000 + i) // event-0 oldest (receivedAt 1000)
    }
    expect(store.get("chatty")?.size).toBe(EVENTS_PER_PLUGIN_CAP)

    writeEntry(store, "chatty", "event-16", {}, 1_000 + EVENTS_PER_PLUGIN_CAP) // the 17th distinct name

    const bucket = store.get("chatty")
    expect(bucket?.size).toBe(EVENTS_PER_PLUGIN_CAP) // still capped at 16
    expect(bucket?.has("event-0")).toBe(false) // least-recently-updated evicted
    expect(bucket?.has("event-16")).toBe(true) // newest present
    expect(bucket?.has("event-1")).toBe(true) // second-oldest survives (only one evicted)
  })

  test("eviction order is by last-update recency, not insertion order — refreshing an old entry protects it", () => {
    const store = createStore()
    for (let i = 0; i < EVENTS_PER_PLUGIN_CAP; i++) {
      writeEntry(store, "chatty", `event-${i}`, {}, 1_000 + i)
    }
    // Refresh event-0 (originally oldest) to be the MOST recently updated.
    writeEntry(store, "chatty", "event-0", { touched: true }, 5_000)

    // Now event-1 (receivedAt 1001) is the true least-recently-updated entry.
    writeEntry(store, "chatty", "event-16", {}, 5_001) // 17th distinct name

    const bucket = store.get("chatty")
    expect(bucket?.has("event-0")).toBe(true) // protected by the refresh
    expect(bucket?.has("event-1")).toBe(false) // now the oldest by receivedAt, evicted instead
  })

  test("the 33rd distinct pluginID evicts the WHOLE least-recently-updated plugin bucket", () => {
    const store = createStore()
    for (let i = 0; i < PLUGINS_CAP; i++) {
      writeEntry(store, `plugin-${i}`, "status", {}, 1_000 + i) // plugin-0 oldest
    }
    expect(store.size).toBe(PLUGINS_CAP)

    writeEntry(store, "plugin-32", "status", {}, 1_000 + PLUGINS_CAP) // 33rd distinct plugin

    expect(store.size).toBe(PLUGINS_CAP) // still capped at 32
    expect(store.has("plugin-0")).toBe(false) // the WHOLE oldest bucket is gone
    expect(store.has("plugin-32")).toBe(true)
  })

  test("plugin-bucket eviction is by the bucket's own most-recently-updated entry, never partial", () => {
    const store = createStore()
    for (let i = 0; i < PLUGINS_CAP; i++) {
      writeEntry(store, `plugin-${i}`, "status", {}, 1_000 + i)
    }
    // Refresh plugin-0's entry so it is no longer the least-recently-updated plugin.
    writeEntry(store, "plugin-0", "status", { touched: true }, 10_000)

    writeEntry(store, "plugin-32", "status", {}, 10_001)

    expect(store.has("plugin-0")).toBe(true) // protected by the refresh
    expect(store.has("plugin-1")).toBe(false) // now the true least-recently-updated bucket
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 5 — snapshot merge does not bypass the caps
// ---------------------------------------------------------------------------
describe("snapshot merge shares the same write path and caps", () => {
  test("applying more snapshot entries than the caps allow does not inflate the store past them", () => {
    const store = createStore()
    const serverTime = 2_000_000
    const clientNow = 2_000_000 // zero skew, for a simple test

    // 40 snapshot entries for one plugin — more than the 16-per-plugin cap.
    for (let i = 0; i < 40; i++) {
      const publishedAt = serverTime - (40 - i) * 1_000 // increasing recency
      const receivedAt = snapshotReceivedAt(clientNow, serverTime, publishedAt)
      writeEntry(store, "one-plugin", `event-${i}`, {}, receivedAt)
    }

    expect(store.get("one-plugin")?.size).toBe(EVENTS_PER_PLUGIN_CAP)

    // 40 distinct plugins — more than the 32-plugin cap.
    const secondStore = createStore()
    for (let i = 0; i < 40; i++) {
      const publishedAt = serverTime - (40 - i) * 1_000
      const receivedAt = snapshotReceivedAt(clientNow, serverTime, publishedAt)
      writeEntry(secondStore, `plugin-${i}`, "status", {}, receivedAt)
    }

    expect(secondStore.size).toBe(PLUGINS_CAP)
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 6 — reconnect-driven refetch predicate (D9)
// ---------------------------------------------------------------------------
describe("shouldRefetchSnapshot — reconnect-driven refetch predicate (D9)", () => {
  test("is true for server.connected, on every occurrence (initial connect and every reconnect)", () => {
    expect(shouldRefetchSnapshot("server.connected")).toBe(true)
    expect(shouldRefetchSnapshot("server.connected")).toBe(true) // stateless — same answer every call
  })

  test("is false for any other event type", () => {
    expect(shouldRefetchSnapshot("session.updated")).toBe(false)
    expect(shouldRefetchSnapshot("plugin.custom")).toBe(false)
    expect(shouldRefetchSnapshot("global.disposed")).toBe(false)
  })
})
