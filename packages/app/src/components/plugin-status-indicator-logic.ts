// Pure logic for `PluginStatusIndicator` (RFC 050 §2d, §2e, D6, D9, D16, D17, D19).
// AMENDED for RFC 050 revision 5 (D20-D26), cross-directory scope: the store gains a
// `Directory` axis as its OUTERMOST key.
// ZERO UI IMPORTS — no solid-js, no @opencode-ai/ui, no @kobalte/core. See the
// `@spec-handoff` block in `./plugin-status-indicator-logic.test.ts` for the full contract.

export type PluginID = string
export type EventName = string
export type Directory = string
export type AuthoredStatus = "ok" | "info" | "warn" | "error"
export type Severity = AuthoredStatus | "unknown"

export const SEVERITY_RANK: Record<Severity, number> = {
  ok: 0,
  info: 1,
  unknown: 2,
  warn: 3,
  error: 4,
}

export const DEFAULT_TTL_SECONDS = 300
// AMENDED (D23): bounds event names per (directory, pluginID) COMPOSITE bucket, not per
// pluginID alone. Magnitude unchanged.
export const EVENTS_PER_PLUGIN_CAP = 16
// AMENDED (D23): bounds the count of distinct (directory, pluginID) composite buckets ACROSS
// THE WHOLE STORE — not "plugins per directory". Magnitude unchanged; the key it counts is wider.
export const PLUGINS_CAP = 32

export interface Entry {
  data: Record<string, unknown>
  receivedAt: number
}

export type PluginBucket = Map<EventName, Entry>
export type DirectoryBucket = Map<PluginID, PluginBucket>
// AMENDED (D22): directory is the new OUTERMOST level. `Map` at every level, including this new
// one, for the SAME reason the other two levels are `Map`s: one uniform rule (D16).
export type Store = Map<Directory, DirectoryBucket>

export function createStore(): Store {
  return new Map()
}

// AMENDED (D22): gains a `directory` parameter, second positional argument — mirrors the sort
// key's own placement, directory outranks pluginID in both. Applies the D23 caps on every write,
// now over the composite (directory, pluginID) bucket.
export function writeEntry(
  store: Store,
  directory: Directory,
  pluginID: PluginID,
  eventName: EventName,
  data: Record<string, unknown>,
  receivedAt: number,
): void {
  const byPlugin = store.get(directory) ?? new Map<PluginID, PluginBucket>()
  if (!store.has(directory)) store.set(directory, byPlugin)

  const bucket = byPlugin.get(pluginID) ?? new Map<EventName, Entry>()
  const isNewBucket = !byPlugin.has(pluginID)

  // Deleting-then-setting moves the key to the end of Map iteration order, which is
  // what "most-recently-updated" eviction below relies on.
  bucket.delete(eventName)
  bucket.set(eventName, { data, receivedAt })
  evictEventNames(bucket)

  byPlugin.delete(pluginID)
  byPlugin.set(pluginID, bucket)
  if (isNewBucket) evictBuckets(store)
}

// Evicts the least-recently-updated event name once the bucket exceeds the cap.
// "Least-recently-updated" means smallest `receivedAt`, never insertion order.
function evictEventNames(bucket: PluginBucket) {
  if (bucket.size <= EVENTS_PER_PLUGIN_CAP) return
  const oldest = [...bucket.entries()].reduce((min, current) =>
    current[1].receivedAt < min[1].receivedAt ? current : min,
  )
  bucket.delete(oldest[0])
}

// Evicts the whole least-recently-updated (directory, pluginID) composite bucket once the count
// of distinct composite buckets ACROSS THE WHOLE STORE exceeds the cap (D23) — deliberately
// global rather than per-directory (the "32 plugins per directory" alternative D23 rejects). A
// bucket's own recency is its most-recently-updated entry's `receivedAt`.
function evictBuckets(store: Store) {
  const composite = [...store.entries()].flatMap(([directory, byPlugin]) =>
    [...byPlugin.entries()].map(([pluginID, bucket]) => ({ directory, pluginID, bucket })),
  )
  if (composite.length <= PLUGINS_CAP) return
  const bucketRecency = (bucket: PluginBucket) => Math.max(...[...bucket.values()].map((entry) => entry.receivedAt))
  const oldest = composite.reduce((min, current) =>
    bucketRecency(current.bucket) < bucketRecency(min.bucket) ? current : min,
  )
  store.get(oldest.directory)?.delete(oldest.pluginID)
}

export function snapshotReceivedAt(nowMillis: number, serverTimeMillis: number, publishedAtMillis: number): number {
  return nowMillis - (serverTimeMillis - publishedAtMillis)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAuthoredStatus(value: unknown): value is AuthoredStatus {
  return value === "ok" || value === "info" || value === "warn" || value === "error"
}

function ttlSecondsOf(ui: Record<string, unknown>): number {
  const raw = ui.ttlSeconds
  if (typeof raw === "number" && raw > 0) return raw
  return DEFAULT_TTL_SECONDS
}

export function effectiveSeverity(entry: Entry, nowMillis: number): Severity {
  const ui = entry.data._ui
  if (!isPlainObject(ui)) return "unknown"

  const ttlSeconds = ttlSecondsOf(ui)
  const stale = nowMillis - entry.receivedAt > ttlSeconds * 1_000
  if (stale) return "unknown"

  const status = ui.status
  if (!isAuthoredStatus(status)) return "unknown"
  return status
}

export interface Row {
  directory: Directory // NEW (D22) — sourced from the store's outer key, never re-derived
  pluginID: PluginID
  eventName: EventName
  severity: Severity
  entry: Entry
}

// AMENDED (D22): the render unit widens from (pluginID, eventName) to
// (directory, pluginID, eventName) — the same plugin reporting the same event name from two open
// directories now produces two rows, never one.
export function toRows(store: Store, nowMillis: number): Row[] {
  const rows: Row[] = []
  for (const [directory, byPlugin] of store) {
    for (const [pluginID, bucket] of byPlugin) {
      for (const [eventName, entry] of bucket) {
        rows.push({ directory, pluginID, eventName, severity: effectiveSeverity(entry, nowMillis), entry })
      }
    }
  }
  return rows
}

// AMENDED (D22) total order: severity desc, then `directory` asc (INSERTED as the SECOND key —
// between severity and pluginID, not appended last), then pluginID asc, then eventName asc.
export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (bySeverity !== 0) return bySeverity
    const byDirectory = a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0
    if (byDirectory !== 0) return byDirectory
    const byPlugin = a.pluginID < b.pluginID ? -1 : a.pluginID > b.pluginID ? 1 : 0
    if (byPlugin !== 0) return byPlugin
    return a.eventName < b.eventName ? -1 : a.eventName > b.eventName ? 1 : 0
  })
}

export type CollapseView =
  | { kind: "none" }
  | { kind: "glyphs"; rows: Row[] }
  | { kind: "badge"; severity: Severity; count: number; rows: Row[] }

export function collapseView(rows: Row[]): CollapseView {
  if (rows.length === 0) return { kind: "none" }
  if (rows.length <= 3) return { kind: "glyphs", rows }
  return { kind: "badge", severity: rows[0].severity, count: rows.length, rows }
}

export function dataRows(entry: Entry): Array<[string, unknown]> {
  return Object.keys(entry.data)
    .filter((key) => key !== "_ui")
    .sort()
    .map((key) => [key, entry.data[key]])
}

export function shouldRefetchSnapshot(eventType: string): boolean {
  return eventType === "server.connected"
}
