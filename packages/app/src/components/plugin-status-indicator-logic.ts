// Pure logic for `PluginStatusIndicator` (RFC 050 §2d, §2e, D6, D9, D16, D17, D19).
// ZERO UI IMPORTS — no solid-js, no @opencode-ai/ui, no @kobalte/core. See the
// `@spec-handoff` block in `./plugin-status-indicator-logic.test.ts` for the full contract.

export type PluginID = string
export type EventName = string
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
export const EVENTS_PER_PLUGIN_CAP = 16
export const PLUGINS_CAP = 32

export interface Entry {
  data: Record<string, unknown>
  receivedAt: number
}

export type PluginBucket = Map<EventName, Entry>
export type Store = Map<PluginID, PluginBucket>

export function createStore(): Store {
  return new Map()
}

export function writeEntry(
  store: Store,
  pluginID: PluginID,
  eventName: EventName,
  data: Record<string, unknown>,
  receivedAt: number,
): void {
  const bucket = store.get(pluginID) ?? new Map<EventName, Entry>()
  const isNewPlugin = !store.has(pluginID)

  // Deleting-then-setting moves the key to the end of Map iteration order, which is
  // what "most-recently-updated" eviction below relies on.
  bucket.delete(eventName)
  bucket.set(eventName, { data, receivedAt })
  evictEventNames(bucket)

  store.delete(pluginID)
  store.set(pluginID, bucket)
  if (isNewPlugin) evictPlugins(store)
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

// Evicts the whole least-recently-updated plugin bucket once the store exceeds the cap.
// A bucket's own recency is its most-recently-updated entry's `receivedAt`.
function evictPlugins(store: Store) {
  if (store.size <= PLUGINS_CAP) return
  const bucketRecency = (bucket: PluginBucket) =>
    Math.max(...[...bucket.values()].map((entry) => entry.receivedAt))
  const oldest = [...store.entries()].reduce((min, current) =>
    bucketRecency(current[1]) < bucketRecency(min[1]) ? current : min,
  )
  store.delete(oldest[0])
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
  pluginID: PluginID
  eventName: EventName
  severity: Severity
  entry: Entry
}

export function toRows(store: Store, nowMillis: number): Row[] {
  const rows: Row[] = []
  for (const [pluginID, bucket] of store) {
    for (const [eventName, entry] of bucket) {
      rows.push({ pluginID, eventName, severity: effectiveSeverity(entry, nowMillis), entry })
    }
  }
  return rows
}

export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (bySeverity !== 0) return bySeverity
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
