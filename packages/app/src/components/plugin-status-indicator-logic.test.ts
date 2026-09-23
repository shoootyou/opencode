/**
 * @spec-handoff
 * @interface
 *   Module: `./plugin-status-indicator-logic` (packages/app/src/components/plugin-status-indicator-logic.ts)
 *   ZERO UI IMPORTS — no solid-js, no @opencode-ai/ui, no @kobalte/core. Plain TypeScript only,
 *   so this test file needs no `--preload ./happydom.ts` shim and cannot hit the shim's
 *   `classList`/eager-JSX-evaluation limitations (see `packages/app/AGENTS.md`'s SolidJS notes
 *   and this repo's `titlebar-tab-order.ts` precedent for the pattern this file mirrors).
 *
 *   **Amended for RFC 050 revision 5 (D20-D26), cross-directory scope.** The store gains a
 *   `Directory` axis as its OUTERMOST key — `directory` is a plain `string` (the emitter key for
 *   live events, `payload.name`, per D24; the `directory` field on a `SnapshotEntry`, per D22) —
 *   never a branded/checked type, since it is only ever string-compared.
 *
 *   ```ts
 *   export type PluginID = string
 *   export type EventName = string
 *   export type Directory = string
 *   export type AuthoredStatus = "ok" | "info" | "warn" | "error"   // what a plugin may write to `_ui.status`
 *   export type Severity = AuthoredStatus | "unknown"                // what the UI actually renders
 *
 *   export const SEVERITY_RANK: Record<Severity, number>  // ok:0 info:1 unknown:2 warn:3 error:4
 *   export const DEFAULT_TTL_SECONDS = 300
 *   export const EVENTS_PER_PLUGIN_CAP = 16   // AMENDED (D23): now bounds event names per
 *                                               // (directory, pluginID) COMPOSITE bucket, not per
 *                                               // pluginID alone. Magnitude unchanged.
 *   export const PLUGINS_CAP = 32              // AMENDED (D23): now bounds the count of distinct
 *                                               // (directory, pluginID) composite buckets ACROSS
 *                                               // THE WHOLE STORE — not "plugins per directory".
 *                                               // Magnitude unchanged; the key it counts is wider.
 *
 *   export interface Entry {
 *     data: Record<string, unknown>   // full decoded `data` payload, INCLUDING `_ui` if present
 *     receivedAt: number              // client-clock epoch ms — the store's one age axis (§2e)
 *   }
 *
 *   export type PluginBucket = Map<EventName, Entry>
 *   export type DirectoryBucket = Map<PluginID, PluginBucket>
 *   export type Store = Map<Directory, DirectoryBucket>   // AMENDED (D22): directory is the new
 *                                                           // OUTERMOST level. `Map` at every
 *                                                           // level, including this new one, for
 *                                                           // the SAME reason the other two levels
 *                                                           // are `Map`s: one uniform rule (D16).
 *
 *   export function createStore(): Store
 *
 *   // AMENDED (D22): gains a `directory` parameter, second positional argument (right after
 *   // `store`, before `pluginID`) — mirrors the sort key's own placement, directory outranks
 *   // pluginID in both. Writes/refreshes one (directory, pluginID, eventName) entry and applies
 *   // the D23 caps on every write: touching an existing (directory, pluginID, eventName) triple
 *   // refreshes its recency (moves it to most-recently-updated) rather than treating it as a new
 *   // entry for eviction purposes. `receivedAt` is caller-supplied (never `Date.now()`
 *   // internally) so callers control the clock: the live-SSE call site passes `Date.now()` at
 *   // arrival, with `directory` sourced from `payload.name` verbatim (D24, including the literal
 *   // string `"global"` — never dropped); the snapshot-merge call site passes the output of
 *   // `snapshotReceivedAt(...)` below, with `directory` sourced from `SnapshotEntry.directory`
 *   // (D22) — NEVER from the caller's own ambient directory context. Both paths funnel through
 *   // this one function, which is what makes "snapshot merge does not bypass the caps" true by
 *   // construction, now over the wider composite key.
 *   export function writeEntry(
 *     store: Store,
 *     directory: Directory,
 *     pluginID: PluginID,
 *     eventName: EventName,
 *     data: Record<string, unknown>,
 *     receivedAt: number,
 *   ): void
 *
 *   // RFC §2e "Timestamps and clock skew — one clock, no skew". Pure arithmetic over RAW
 *   // epoch-millisecond numbers (never decoded `DateTime.Utc` values — subtracting those is
 *   // invalid). `serverTimeMillis` and `publishedAtMillis` come from the same server clock in the
 *   // same snapshot response, so their difference is a skew-free elapsed duration. UNCHANGED by
 *   // revision 5 — this function has no directory axis.
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
 *   // `DEFAULT_TTL_SECONDS`. UNCHANGED by revision 5 — operates on `Entry`, which carries no
 *   // directory (directory lives on `Row`/the store key, never on `Entry` itself).
 *   export function effectiveSeverity(entry: Entry, nowMillis: number): Severity
 *
 *   export interface Row {
 *     directory: Directory   // NEW (D22) — sourced from the store's outer key, never re-derived
 *     pluginID: PluginID
 *     eventName: EventName
 *     severity: Severity
 *     entry: Entry
 *   }
 *
 *   // Flattens the store into one Row per (directory, pluginID, eventName) leaf, UNSORTED.
 *   // AMENDED (D22): the render unit widens from (pluginID, eventName) to
 *   // (directory, pluginID, eventName) — the same plugin reporting the same event name from two
 *   // open directories now produces two rows, never one.
 *   export function toRows(store: Store, nowMillis: number): Row[]
 *
 *   // AMENDED (D22) total order: severity desc (via SEVERITY_RANK), then `directory` asc
 *   // (INSERTED as the SECOND key — between severity and pluginID, not appended last), then
 *   // pluginID asc, then eventName asc, all by code-unit order. `directory` sorts above
 *   // `pluginID` so that once severity ties, one project's rows stay contiguous instead of
 *   // interleaving with another project's. `(directory, pluginID, eventName)` is unique so ties
 *   // never occur past the fourth key.
 *   export function sortRows(rows: Row[]): Row[]
 *
 *   export type CollapseView =
 *     | { kind: "none" }
 *     | { kind: "glyphs"; rows: Row[] }
 *     | { kind: "badge"; severity: Severity; count: number; rows: Row[] }
 *
 *   // Applies the RFC §2d rendering-rules threshold over ALREADY-SORTED rows. UNCHANGED by
 *   // revision 5 — counts entries (now (directory, pluginID, eventName) entries) exactly as
 *   // before, never distinct plugins and never distinct directories:
 *   //   0 rows -> { kind: "none" }
 *   //   1-3 rows -> { kind: "glyphs", rows }  (rows, in the given sort order, one glyph each)
 *   //   >3 rows -> { kind: "badge", severity: <worst = rows[0].severity>, count: rows.length, rows }
 *   // `count` is always the entry count, never a distinct-plugin or distinct-directory count.
 *   export function collapseView(rows: Row[]): CollapseView
 *
 *   // Selects the plain `key: value` rows to render for one entry: every top-level key of
 *   // `entry.data` EXCEPT `_ui`, sorted ascending by key (code-unit order). `_ui`'s own sub-keys
 *   // are NEVER included here regardless of whether `_ui` itself is a valid object. UNCHANGED by
 *   // revision 5 — operates on `Entry`, which carries no directory.
 *   export function dataRows(entry: Entry): Array<[string, unknown]>
 *
 *   // RFC §2e/D9: refetch `GET /plugin-ui/snapshot` on every `server.connected` event (initial
 *   // connect AND every reconnect). Pure predicate, mirrors this repo's existing
 *   // `home-session-index.ts`/`event-reducer.ts` style (stateless per-call boolean over an event
 *   // type string) rather than introducing a new reducer shape. UNCHANGED by revision 5.
 *   export function shouldRefetchSnapshot(eventType: string): boolean
 *   ```
 *
 * @behavior
 *   - Store is `Map`-based at every level, INCLUDING the new outer `Directory` level — a
 *     `directory`, `pluginID` or `eventName` of `__proto__` is an ordinary Map key with no special
 *     meaning and never touches `Object.prototype` (D16, asserted at all three levels now).
 *   - One `(directory, pluginID, eventName)` triple is the atomic render unit (D22) — a plugin
 *     reporting under two event names yields two independently-sortable rows (as before, D6/§2d),
 *     AND a plugin reporting the SAME event name from two different open directories ALSO yields
 *     two independently-sortable rows, never a collision or a silent overwrite.
 *   - Sort is a total, deterministic order: severity desc, directory asc, pluginID asc, eventName
 *     asc (D22, amending D17). `directory` is the SECOND key, not the last.
 *   - `unknown` outranks `ok`/`info` but not `warn`/`error` (D17) — "no news" must never look like
 *     "all good". Unaffected by the directory axis.
 *   - Rendering-rule thresholds count entries, never distinct plugins and never distinct
 *     directories (§2d, unchanged).
 *   - `_ui` is a reserved namespace: never rendered via `dataRows`, and a non-object `_ui` is
 *     treated as "no presentation metadata" (`effectiveSeverity` returns `unknown`) without
 *     throwing. Unaffected by the directory axis — this operates purely on `Entry`.
 *   - TTL past-due downgrades severity to `unknown` but the entry is never removed from the store —
 *     eviction is governed exclusively by the D23 caps (16 event names per `(directory, pluginID)`
 *     bucket, 32 such composite buckets ACROSS THE WHOLE STORE), by `receivedAt` recency, never by
 *     TTL and never by insertion order. The cap is deliberately global rather than per-directory:
 *     a single busy directory's buckets can fill and evict the whole store's ceiling even while
 *     every other open directory sits far under any old per-directory-scoped number — see the
 *     "the alternative... was considered and rejected" note under D23 in the RFC.
 *   - `writeEntry` is the single write path for both live-SSE arrivals and snapshot-merge writes,
 *     so the D23 caps bound both uniformly (a snapshot cannot inflate the store past them) — same
 *     property as before, now keyed on the wider composite bucket.
 *   - `snapshotReceivedAt` cancels server/client clock skew: it is a function of the *elapsed
 *     duration* between `serverTimeMillis` and `publishedAtMillis` (both same-clock), not of any
 *     absolute timestamp comparison across clocks. Unaffected by the directory axis.
 *
 * @edge-cases
 *   - Empty store → `toRows` returns `[]`; `collapseView([])` returns `{ kind: "none" }`.
 *   - Exactly 3 rows → `{ kind: "glyphs" }`, not `{ kind: "badge" }` (threshold is `> 3`, not `>= 3`).
 *   - Exactly 4 rows → `{ kind: "badge" }`.
 *   - A single plugin alone reporting 4+ event names collapses on its own (§2d), regardless of
 *     directory.
 *   - `_ui` present but a string/number/array (not a plain object) → `effectiveSeverity` returns
 *     `"unknown"`, `dataRows` still excludes the literal `_ui` key, no throw.
 *   - `_ui.status` an unrecognized string (e.g. `"critical"`) → treated as absent → `unknown`.
 *   - Re-writing an already-present `(directory, pluginID, eventName)` triple with a larger
 *     `receivedAt` must move its bucket to most-recently-updated for eviction purposes — eviction
 *     order is by *last update*, never by original insertion order.
 *   - The 33rd distinct `(directory, pluginID)` composite bucket evicts the WHOLE
 *     least-recently-updated bucket (by that bucket's own most-recently-updated entry), never a
 *     partial bucket — and this holds even when the 33rd bucket lands in a directory that, on its
 *     own, is nowhere near any per-directory ceiling, because the cap counts across the whole
 *     store.
 *   - A cross-directory snapshot merge (entries for directory A AND directory B in one response)
 *     populates BOTH directory buckets in one ingestion pass through the same `writeEntry` path —
 *     no special-casing needed at the merge site (D20/D21).
 *
 * @see .yui-soul/rfcs/approved/050-opencode-plugin-ui-event-channel/README.md (§1d cross-directory
 *      read, §2d, §2e, D6, D9, D16, D17, D19, D20, D21, D22, D23, D24)
 * @see packages/app/src/components/titlebar-tab-order.ts (the zero-UI-import module pattern this
 *      file's companion module mirrors)
 * @see packages/app/src/components/plugin-status-indicator.test.tsx (the companion DOM-mount test
 *      file — XSS acceptance criteria, Popover tap behavior, directory basename/title rendering,
 *      the SDK-wired component's `payload.name` → `entry.directory` and
 *      `SnapshotEntry.directory` → `entry.directory` ingestion paths, and `_ui`-vs-plain-key DOM
 *      rendering live there, NOT here, because those specifically require real DOM insertion or a
 *      mocked SDK wire to verify; this file only proves the selection/sort/collapse/eviction MATH,
 *      which needs no DOM and no solid-js shim at all)
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
// Task 1 / Group 1 — Map-based store, __proto__ safety at every level, including the new
// outermost Directory level (D16, D22)
// ---------------------------------------------------------------------------
describe("store safety — Map, never Record, at every level (D16/D22)", () => {
  test("a directory of '__proto__' does not pollute Object.prototype", () => {
    const store = createStore()
    writeEntry(store, "__proto__", "plugin-a", "probe", { ok: true }, 1_000)

    // Object.prototype itself must remain untouched.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).probe).toBeUndefined()

    // The entry is nonetheless retained under the literal Map key "__proto__" at the OUTER level.
    expect(store instanceof Map).toBe(true)
    expect(store.get("__proto__")).toBeInstanceOf(Map)
    expect(store.get("__proto__")?.get("plugin-a")).toBeInstanceOf(Map)
    expect(store.get("__proto__")?.get("plugin-a")?.get("probe")?.data).toEqual({ ok: true })
  })

  test("a pluginID of '__proto__' does not pollute Object.prototype", () => {
    const store = createStore()
    writeEntry(store, "dir", "__proto__", "probe", { ok: true }, 1_000)

    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).probe).toBeUndefined()

    expect(store.get("dir")).toBeInstanceOf(Map)
    expect(store.get("dir")?.get("__proto__")).toBeInstanceOf(Map)
    expect(store.get("dir")?.get("__proto__")?.get("probe")?.data).toEqual({ ok: true })
  })

  test("an eventName of 'constructor' is an ordinary Map key, not a property lookup", () => {
    const store = createStore()
    writeEntry(store, "dir", "plugin-a", "constructor", { x: 1 }, 1_000)
    expect(store.get("dir")?.get("plugin-a")?.get("constructor")?.data).toEqual({ x: 1 })
    expect(store.get("dir")?.get("plugin-a")?.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Task 1 / Group 2 — Granularity: (directory, pluginID, eventName), never a narrower key (D22)
// ---------------------------------------------------------------------------
describe("rendering granularity — (directory, pluginID, eventName), never a narrower key", () => {
  test("one plugin reporting two event names in one directory produces two independent rows", () => {
    const store = createStore()
    writeEntry(store, "dir", "budget", "spend", { _ui: { status: "error" } }, 1_000)
    writeEntry(store, "dir", "budget", "probe", { _ui: { status: "ok" } }, 1_000)

    const rows = toRows(store, 1_000)
    expect(rows).toHaveLength(2)
    const eventNames = rows.map((row) => row.eventName).sort()
    expect(eventNames).toEqual(["probe", "spend"])
    expect(rows.every((row) => row.directory === "dir")).toBe(true)
  })

  test("two plugins reporting one event each and one plugin reporting two events both yield 2 rows", () => {
    const twoPlugins = createStore()
    writeEntry(twoPlugins, "dir", "a", "e", {}, 1_000)
    writeEntry(twoPlugins, "dir", "b", "e", {}, 1_000)

    const onePluginTwoEvents = createStore()
    writeEntry(onePluginTwoEvents, "dir", "a", "e1", {}, 1_000)
    writeEntry(onePluginTwoEvents, "dir", "a", "e2", {}, 1_000)

    expect(toRows(twoPlugins, 1_000)).toHaveLength(2)
    expect(toRows(onePluginTwoEvents, 1_000)).toHaveLength(2)
  })

  test("the SAME plugin reporting the SAME event name from two different directories produces two independent rows, never a collision", () => {
    const store = createStore()
    writeEntry(store, "/repo/project-a", "budget", "spend", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "/repo/project-b", "budget", "spend", { _ui: { status: "warn" } }, 1_000)

    const rows = toRows(store, 1_000)
    expect(rows).toHaveLength(2)
    const directories = rows.map((row) => row.directory).sort()
    expect(directories).toEqual(["/repo/project-a", "/repo/project-b"])
    // Both rows carry the SAME (pluginID, eventName) — the collision is only avoided because
    // directory is now part of the render key.
    expect(rows.every((row) => row.pluginID === "budget" && row.eventName === "spend")).toBe(true)
  })

  test("the literal directory string 'global' is a valid, ordinary directory key — never special-cased away", () => {
    const store = createStore()
    writeEntry(store, "global", "heartbeat", "status", {}, 1_000)
    const rows = toRows(store, 1_000)
    expect(rows).toHaveLength(1)
    expect(rows[0].directory).toBe("global")
  })
})

// ---------------------------------------------------------------------------
// Task 1 / Group 3 — Sort order (D22): severity desc, directory asc, pluginID asc, eventName asc
// ---------------------------------------------------------------------------
describe("sortRows — total deterministic order (D22: severity desc, directory asc, pluginID asc, eventName asc)", () => {
  test("orders by severity descending first", () => {
    const store = createStore()
    writeEntry(store, "dir", "p", "ok-event", { _ui: { status: "ok" } }, 1_000)
    writeEntry(store, "dir", "p", "error-event", { _ui: { status: "error" } }, 1_000)
    writeEntry(store, "dir", "p", "warn-event", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    expect(sorted.map((row) => row.eventName)).toEqual(["error-event", "warn-event", "ok-event"])
  })

  test("breaks severity ties by directory ascending — directory is the SECOND key, before pluginID", () => {
    const store = createStore()
    writeEntry(store, "/repo/zebra-project", "p", "e", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "/repo/alpha-project", "p", "e", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    expect(sorted.map((row) => row.directory)).toEqual(["/repo/alpha-project", "/repo/zebra-project"])
  })

  test("breaks directory ties by pluginID ascending", () => {
    const store = createStore()
    writeEntry(store, "dir", "zebra", "e", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "dir", "alpha", "e", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    expect(sorted.map((row) => row.pluginID)).toEqual(["alpha", "zebra"])
  })

  test("breaks pluginID ties by eventName ascending — the tie-breaker only meaningful at entry granularity", () => {
    const store = createStore()
    writeEntry(store, "dir", "budget", "zzz", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "dir", "budget", "aaa", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    expect(sorted.map((row) => row.eventName)).toEqual(["aaa", "zzz"])
  })

  test("is a total order over all four keys — one directory's rows stay contiguous once severity ties", () => {
    const store = createStore()
    // Two directories, two plugins; three rows tie at "warn" so directory/pluginID/eventName
    // decide their relative order, while the fourth (error) outranks everything via severity.
    writeEntry(store, "/repo/b", "y", "e", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "/repo/a", "z", "e", { _ui: { status: "error" } }, 1_000)
    writeEntry(store, "/repo/a", "y", "e", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "/repo/b", "z", "e", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    // error(/repo/a,z) sorts first via severity alone; the remaining three warn rows are ordered
    // by directory asc first (/repo/a before /repo/b), which is what keeps /repo/a's own row
    // (y) grouped ahead of BOTH /repo/b rows, rather than interleaving by pluginID across
    // directories.
    expect(sorted.map((row) => `${row.directory}:${row.pluginID}`)).toEqual([
      "/repo/a:z",
      "/repo/a:y",
      "/repo/b:y",
      "/repo/b:z",
    ])
  })

  test("is unique and tie-free per (directory, pluginID, eventName) — the same pair across two directories never ties on the first three keys", () => {
    const store = createStore()
    writeEntry(store, "/repo/b", "budget", "spend", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "/repo/a", "budget", "spend", { _ui: { status: "warn" } }, 1_000)

    const sorted = sortRows(toRows(store, 1_000))
    expect(sorted.map((row) => row.directory)).toEqual(["/repo/a", "/repo/b"])
  })
})

// ---------------------------------------------------------------------------
// Task 1 / Group 4 — Rendering rules: 0 / 1-3 / >3 — unchanged by the directory axis
// ---------------------------------------------------------------------------
describe("collapseView — rendering-rule thresholds count entries, never plugins or directories", () => {
  test("zero entries collapse to 'none' (no empty box, no placeholder)", () => {
    expect(collapseView([])).toEqual({ kind: "none" })
  })

  test("1-3 entries render one glyph each, in sort order", () => {
    const store = createStore()
    writeEntry(store, "dir", "a", "e1", {}, 1_000)
    writeEntry(store, "dir", "a", "e2", {}, 1_000)
    writeEntry(store, "dir", "a", "e3", {}, 1_000)
    const view = collapseView(sortRows(toRows(store, 1_000)))
    expect(view.kind).toBe("glyphs")
    if (view.kind === "glyphs") expect(view.rows).toHaveLength(3)
  })

  test("exactly 3 does not collapse — threshold is strictly greater than 3", () => {
    const rows = [1, 2, 3].map((n) => ({
      directory: "dir",
      pluginID: "p",
      eventName: `e${n}`,
      severity: "ok" as const,
      entry: { data: {}, receivedAt: 1_000 },
    }))
    expect(collapseView(rows).kind).toBe("glyphs")
  })

  test("4 entries collapse to a single aggregate badge with worst severity + entry count", () => {
    const store = createStore()
    writeEntry(store, "dir", "budget", "e1", { _ui: { status: "ok" } }, 1_000)
    writeEntry(store, "dir", "budget", "e2", { _ui: { status: "warn" } }, 1_000)
    writeEntry(store, "dir", "budget", "e3", { _ui: { status: "info" } }, 1_000)
    writeEntry(store, "dir", "budget", "e4", { _ui: { status: "ok" } }, 1_000)

    const view = collapseView(sortRows(toRows(store, 1_000)))
    expect(view.kind).toBe("badge")
    if (view.kind === "badge") {
      expect(view.severity).toBe("warn")
      expect(view.count).toBe(4) // entry count, NEVER plugin or directory count
      expect(view.rows).toHaveLength(4)
    }
  })

  test("a single plugin holding 4+ event names collapses on its own", () => {
    const store = createStore()
    for (let i = 0; i < 4; i++) writeEntry(store, "dir", "chatty", `event-${i}`, {}, 1_000)
    expect(collapseView(sortRows(toRows(store, 1_000))).kind).toBe("badge")
  })

  test("4 rows spread across two directories still collapse to a badge — the threshold counts entries, not distinct directories", () => {
    const store = createStore()
    writeEntry(store, "/repo/a", "budget", "e1", {}, 1_000)
    writeEntry(store, "/repo/a", "budget", "e2", {}, 1_000)
    writeEntry(store, "/repo/b", "budget", "e1", {}, 1_000)
    writeEntry(store, "/repo/b", "budget", "e2", {}, 1_000)

    const view = collapseView(sortRows(toRows(store, 1_000)))
    expect(view.kind).toBe("badge")
    if (view.kind === "badge") expect(view.count).toBe(4)
  })

  test("16 entries from one plugin still report entry count, never distinct-plugin count of 1", () => {
    const store = createStore()
    for (let i = 0; i < EVENTS_PER_PLUGIN_CAP; i++) writeEntry(store, "dir", "chatty", `event-${i}`, {}, 1_000 + i)
    const view = collapseView(sortRows(toRows(store, 1_000 + EVENTS_PER_PLUGIN_CAP)))
    expect(view.kind).toBe("badge")
    if (view.kind === "badge") expect(view.count).toBe(EVENTS_PER_PLUGIN_CAP)
  })
})

// ---------------------------------------------------------------------------
// Task 1 / Group 5 — `_ui` reserved namespace — unaffected by the directory axis (Entry-scoped)
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
// Task 1 / Group 6 — status vocabulary: closed, ordered, total (D17) — unaffected by directory
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
    writeEntry(store, "dir", "a", "unknown-event", {}, 1_000) // no _ui at all -> unknown
    writeEntry(store, "dir", "a", "ok-event", { _ui: { status: "ok" } }, 1_000)
    writeEntry(store, "dir", "a", "info-event", { _ui: { status: "info" } }, 1_000)

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
    writeEntry(store, "dir", "p", "e", { hello: "world" }, arrivalTime)
    expect(store.get("dir")?.get("p")?.get("e")?.receivedAt).toBe(arrivalTime)
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 2 — skew-free snapshot merge — unaffected by the directory axis (pure math)
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
    writeEntry(store, "dir", "p", "e", { _ui: { status: "error", ttlSeconds: 60 } }, receivedAt)

    const farFuture = receivedAt + 10 * 60 * 1_000 // 10 minutes later — well past a 60s TTL
    expect(store.get("dir")?.get("p")?.has("e")).toBe(true) // never removed

    const rows = toRows(store, farFuture)
    expect(rows).toHaveLength(1)
    expect(rows[0].severity).toBe("unknown") // downgraded, not deleted
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 4 — client-side eviction, re-keyed to the composite (directory, pluginID)
// bucket, GLOBAL across the whole store (D23)
// ---------------------------------------------------------------------------
describe("client-side eviction — re-keyed to the composite (directory, pluginID) bucket (D23)", () => {
  test("the 17th distinct eventName in one (directory, pluginID) bucket evicts that bucket's least-recently-updated entry", () => {
    const store = createStore()
    for (let i = 0; i < EVENTS_PER_PLUGIN_CAP; i++) {
      writeEntry(store, "dir", "chatty", `event-${i}`, {}, 1_000 + i) // event-0 oldest (receivedAt 1000)
    }
    expect(store.get("dir")?.get("chatty")?.size).toBe(EVENTS_PER_PLUGIN_CAP)

    writeEntry(store, "dir", "chatty", "event-16", {}, 1_000 + EVENTS_PER_PLUGIN_CAP) // 17th distinct name

    const bucket = store.get("dir")?.get("chatty")
    expect(bucket?.size).toBe(EVENTS_PER_PLUGIN_CAP) // still capped at 16
    expect(bucket?.has("event-0")).toBe(false) // least-recently-updated evicted
    expect(bucket?.has("event-16")).toBe(true) // newest present
    expect(bucket?.has("event-1")).toBe(true) // second-oldest survives (only one evicted)
  })

  test("eviction order is by last-update recency, not insertion order — refreshing an old entry protects it", () => {
    const store = createStore()
    for (let i = 0; i < EVENTS_PER_PLUGIN_CAP; i++) {
      writeEntry(store, "dir", "chatty", `event-${i}`, {}, 1_000 + i)
    }
    // Refresh event-0 (originally oldest) to be the MOST recently updated.
    writeEntry(store, "dir", "chatty", "event-0", { touched: true }, 5_000)

    // Now event-1 (receivedAt 1001) is the true least-recently-updated entry.
    writeEntry(store, "dir", "chatty", "event-16", {}, 5_001) // 17th distinct name

    const bucket = store.get("dir")?.get("chatty")
    expect(bucket?.has("event-0")).toBe(true) // protected by the refresh
    expect(bucket?.has("event-1")).toBe(false) // now the oldest by receivedAt, evicted instead
  })

  test("the same (pluginID, eventName) pair reported from TWO directories occupies TWO independent buckets for eviction purposes", () => {
    const store = createStore()
    for (let i = 0; i < EVENTS_PER_PLUGIN_CAP; i++) {
      writeEntry(store, "/repo/a", "chatty", `event-${i}`, {}, 1_000 + i)
    }
    // A same-named plugin/event bucket in a SECOND directory starts fresh — it is not the same
    // bucket, and filling it does not evict anything from /repo/a's bucket.
    for (let i = 0; i < EVENTS_PER_PLUGIN_CAP; i++) {
      writeEntry(store, "/repo/b", "chatty", `event-${i}`, {}, 1_000 + i)
    }
    expect(store.get("/repo/a")?.get("chatty")?.size).toBe(EVENTS_PER_PLUGIN_CAP)
    expect(store.get("/repo/b")?.get("chatty")?.size).toBe(EVENTS_PER_PLUGIN_CAP)
    expect(store.get("/repo/a")?.get("chatty")?.has("event-0")).toBe(true)
    expect(store.get("/repo/b")?.get("chatty")?.has("event-0")).toBe(true)
  })

  test("the 33rd distinct (directory, pluginID) composite bucket evicts the WHOLE least-recently-updated bucket, GLOBALLY across all directories — not per directory", () => {
    const store = createStore()
    // 16 buckets in directory A, 16 buckets in directory B — 32 distinct composite buckets total.
    for (let i = 0; i < 16; i++) writeEntry(store, "/repo/a", `plugin-${i}`, "status", {}, 1_000 + i)
    for (let i = 0; i < 16; i++) writeEntry(store, "/repo/b", `plugin-${i}`, "status", {}, 1_020 + i)

    const bucketCount = () => [...store.values()].reduce((sum, dirBucket) => sum + dirBucket.size, 0)
    expect(bucketCount()).toBe(PLUGINS_CAP)

    // A 33rd bucket landing in directory B — which, on its OWN, only holds 16 buckets, nowhere
    // near any per-directory ceiling — must still evict the GLOBALLY oldest bucket (directory A's
    // plugin-0, the very first one written), because the cap counts (directory, pluginID) buckets
    // across the whole store, not per directory. This is the behaviour the "32 plugins per
    // directory" alternative was explicitly rejected for (D23).
    writeEntry(store, "/repo/b", "plugin-16", "status", {}, 1_040)

    expect(bucketCount()).toBe(PLUGINS_CAP) // still capped at 32, globally
    expect(store.get("/repo/a")?.has("plugin-0")).toBe(false) // the WHOLE globally-oldest bucket is gone
    expect(store.get("/repo/b")?.has("plugin-16")).toBe(true)
  })

  test("bucket eviction is by the bucket's own most-recently-updated entry, never partial", () => {
    const store = createStore()
    for (let i = 0; i < 16; i++) writeEntry(store, "/repo/a", `plugin-${i}`, "status", {}, 1_000 + i)
    for (let i = 0; i < 16; i++) writeEntry(store, "/repo/b", `plugin-${i}`, "status", {}, 1_020 + i)

    // Refresh /repo/a's plugin-0 bucket so it is no longer the globally least-recently-updated one.
    writeEntry(store, "/repo/a", "plugin-0", "status", { touched: true }, 10_000)

    writeEntry(store, "/repo/b", "plugin-16", "status", {}, 10_001)

    expect(store.get("/repo/a")?.has("plugin-0")).toBe(true) // protected by the refresh
    expect(store.get("/repo/a")?.has("plugin-1")).toBe(false) // now the true globally-oldest bucket
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 5 — snapshot merge does not bypass the caps, and aggregates cross-directory
// entries from one response in one ingestion pass (D20/D21/D23)
// ---------------------------------------------------------------------------
describe("snapshot merge shares the same write path and caps", () => {
  test("applying more snapshot entries than the caps allow does not inflate the store past them", () => {
    const store = createStore()
    const serverTime = 2_000_000
    const clientNow = 2_000_000 // zero skew, for a simple test

    // 40 snapshot entries for one (directory, plugin) bucket — more than the 16-per-bucket cap.
    for (let i = 0; i < 40; i++) {
      const publishedAt = serverTime - (40 - i) * 1_000 // increasing recency
      const receivedAt = snapshotReceivedAt(clientNow, serverTime, publishedAt)
      writeEntry(store, "dir", "one-plugin", `event-${i}`, {}, receivedAt)
    }

    expect(store.get("dir")?.get("one-plugin")?.size).toBe(EVENTS_PER_PLUGIN_CAP)

    // 40 distinct (directory, plugin) buckets, spread across two directories — more than the
    // 32-bucket global cap.
    const secondStore = createStore()
    for (let i = 0; i < 40; i++) {
      const publishedAt = serverTime - (40 - i) * 1_000
      const receivedAt = snapshotReceivedAt(clientNow, serverTime, publishedAt)
      const directory = i % 2 === 0 ? "/repo/a" : "/repo/b"
      writeEntry(secondStore, directory, `plugin-${i}`, "status", {}, receivedAt)
    }

    const secondStoreBucketCount = [...secondStore.values()].reduce((sum, dirBucket) => sum + dirBucket.size, 0)
    expect(secondStoreBucketCount).toBe(PLUGINS_CAP)
  })

  test("a single ingestion pass over entries for directory A AND directory B populates BOTH directory buckets (D20/D21 — genuinely new coverage revision 4's tests never exercised)", () => {
    const store = createStore()
    const serverTime = 3_000_000
    const clientNow = 3_000_000

    // Simulates one GET /plugin-ui/snapshot response whose `entries` array mixes rows from two
    // different directories — exactly the D20 cross-directory aggregate shape. Each entry's own
    // `directory` field (not any ambient caller directory) drives the write.
    const snapshotEntries = [
      { directory: "/repo/project-a", pluginID: "budget", event: "spend", data: { pct: 82 }, publishedAt: serverTime - 1_000 },
      { directory: "/repo/project-b", pluginID: "budget", event: "spend", data: { pct: 40 }, publishedAt: serverTime - 2_000 },
    ]

    for (const entry of snapshotEntries) {
      const receivedAt = snapshotReceivedAt(clientNow, serverTime, entry.publishedAt)
      writeEntry(store, entry.directory, entry.pluginID, entry.event, entry.data, receivedAt)
    }

    expect(store.size).toBe(2) // both directory buckets populated
    expect(store.has("/repo/project-a")).toBe(true)
    expect(store.has("/repo/project-b")).toBe(true)

    const rows = toRows(store, clientNow)
    expect(rows).toHaveLength(2)
    const byDirectory = Object.fromEntries(rows.map((row) => [row.directory, row.entry.data]))
    expect(byDirectory["/repo/project-a"]).toEqual({ pct: 82 })
    expect(byDirectory["/repo/project-b"]).toEqual({ pct: 40 })
  })
})

// ---------------------------------------------------------------------------
// Task 2 / Item 6 — reconnect-driven refetch predicate (D9) — unaffected by the directory axis
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
