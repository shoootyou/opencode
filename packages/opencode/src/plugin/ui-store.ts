// Shared, process-level plugin-UI retained store + validation.
//
// D2 (Taku, E6c design): `InstanceState` cannot span the HTTP handler's own layer graph and the
// plugin layer graph — under a real `Server.listen()`, `HttpRouter.toWebHandler` builds each
// listener's routes through its own independently-compiled Effect tree (its own memoMap), which
// is a genuinely different object graph from whichever tree resolved `Plugin.Service` for a
// directory's bootstrap. A service resolved through `InstanceState.make` on one graph is not
// reachable from the other. A module-level `Map` keyed by directory string IS reachable from
// both, because both graphs run in the same JS module registry — this file's module-level state
// is the single shared owner.
//
// D3: `validatePayload` below is the ONE validation implementation for BOTH the external
// `/plugin-ui/publish` HTTP handler and the plugin's own internal `publishDirect()` self-flush.
// The direct (internal) path must never be a weaker security gate than the wire path — sharing
// this function is how that invariant is enforced structurally rather than by convention.
//
// D1: the actual reentrancy fix is that `publishDirect` performs NO HTTP round-trip and does not
// touch `InstanceContextMiddleware` / `InstanceStore.load()` at all. It writes straight into this
// module's store using a directory string the caller (`plugin/index.ts`) already has in hand from
// its own `InstanceContext` — there is no self-referential call to break in the first place.
import { registerDisposer } from "@/effect/instance-registry"
import type { Schema } from "effect"

type JsonRecord = Record<string, Schema.Json>

export interface RetainedEntry {
  readonly data: JsonRecord
  readonly publishedAt: number
}

export type EventBucket = Map<string, RetainedEntry>
export type PluginBucket = Map<string, EventBucket>

// A `symbol`, deliberately — a plugin- or client-supplied `WorkspaceID` is a string and can
// never forge or collide with this sentinel (RFC 050 §1d "Store shape"). Owned here so both the
// HTTP handler and the plugin's direct-write path agree on the exact same sentinel identity —
// two independently-declared `Symbol("plugin-ui.unscoped")` values would never be `===`.
export const UNSCOPED: unique symbol = Symbol("plugin-ui.unscoped")
export type WorkspaceKey = string | typeof UNSCOPED
export type ScopeStore = Map<WorkspaceKey, PluginBucket>

const EVENTS_PER_PLUGIN_CAP = 16
const PLUGINS_PER_BUCKET_CAP = 32

// directory -> ScopeStore. The single shared owner (D2) — reachable from both the HTTP handler's
// layer graph and the plugin layer graph, since both are plain JS running against the same
// module instance regardless of which Effect tree resolved them.
const byDirectory = new Map<string, ScopeStore>()

// Mirrors `InstanceState.make`'s own disposal wiring (`registerDisposer` in
// `instance-registry.ts`) so a directory's retained plugin-UI state is evicted on instance
// disposal exactly like every other per-directory cache, even though this store itself is not an
// `InstanceState` cell.
registerDisposer(async (directory) => {
  byDirectory.delete(directory)
})

export function storeFor(directory: string): ScopeStore {
  const existing = byDirectory.get(directory)
  if (existing) return existing
  const created: ScopeStore = new Map()
  byDirectory.set(directory, created)
  return created
}

export function directories(): Array<[string, ScopeStore]> {
  return [...byDirectory.entries()]
}

// Moves `eventName` to the end of `bucket` (most-recently-updated), then evicts the
// least-recently-updated entry if the per-plugin cap is exceeded. "Oldest" is last-update time,
// never insertion time (RFC 050 §1d).
function touchEvent(bucket: EventBucket, eventName: string, entry: RetainedEntry) {
  bucket.delete(eventName)
  bucket.set(eventName, entry)
  if (bucket.size <= EVENTS_PER_PLUGIN_CAP) return
  const oldest = bucket.keys().next().value
  if (oldest !== undefined) bucket.delete(oldest)
}

// Moves `pluginID` to the end of `byPlugin` (most-recently-updated), then evicts the whole
// least-recently-updated plugin bucket if the per-bucket plugin cap is exceeded.
function touchPlugin(byPlugin: PluginBucket, pluginID: string): EventBucket {
  const bucket = byPlugin.get(pluginID) ?? new Map<string, RetainedEntry>()
  byPlugin.delete(pluginID)
  byPlugin.set(pluginID, bucket)
  if (byPlugin.size > PLUGINS_PER_BUCKET_CAP) {
    const oldest = byPlugin.keys().next().value
    if (oldest !== undefined) byPlugin.delete(oldest)
  }
  return bucket
}

export function write(
  directory: string,
  workspaceKey: WorkspaceKey,
  pluginID: string,
  eventName: string,
  data: JsonRecord,
  publishedAt: number,
) {
  const store = storeFor(directory)
  const byPlugin = store.get(workspaceKey) ?? new Map<string, EventBucket>()
  if (!store.has(workspaceKey)) store.set(workspaceKey, byPlugin)
  touchEvent(touchPlugin(byPlugin, pluginID), eventName, { data, publishedAt })
}

// ---------------------------------------------------------------------------
// D3: shared validation — ONE implementation, used by BOTH the HTTP handler and the plugin's own
// internal `publishDirect` self-flush, so the direct path can never be a weaker gate than the
// wire path (RFC 050 §1e / §2d).
// ---------------------------------------------------------------------------

export const MAX_DATA_BYTES = 16 * 1024
export const MAX_PLUGIN_ID_LENGTH = 256
const EVENT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"])

export function hasReservedKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReservedKey)
  if (value === null || typeof value !== "object") return false
  const record = value as JsonRecord
  return Object.keys(record).some((key) => RESERVED_KEYS.has(key) || hasReservedKey(record[key]))
}

export type ValidationKind =
  | "payload_too_large"
  | "invalid_event_name"
  | "invalid_plugin_id"
  | "reserved_key"
  | "invalid_data"

export function validatePayload(payload: { pluginID: string; event: string; data: unknown }): ValidationKind | undefined {
  // Must run before the byte-length check below — a non-object `data` can still `JSON.stringify`
  // to something under `MAX_DATA_BYTES` (e.g. `"i-am-a-string"`), which would otherwise slip
  // past the size gate and reach the reserved-key scan / shared store with the wrong shape
  // (r2-sho-e6c-deadlock.md finding #1). Mirrors the wire path's own `PublishPayload` Schema
  // decode (`Schema.Record(Schema.String, Schema.Json)`), which already rejects string, number,
  // boolean, null, and array `data` with a 400 — this closes the same gap for `publishDirect`.
  if (typeof payload.data !== "object" || payload.data === null || Array.isArray(payload.data)) return "invalid_data"
  const byteLength = new TextEncoder().encode(JSON.stringify(payload.data)).length
  if (byteLength > MAX_DATA_BYTES) return "payload_too_large"
  if (!EVENT_NAME_PATTERN.test(payload.event)) return "invalid_event_name"
  if (payload.pluginID.length === 0 || payload.pluginID.length > MAX_PLUGIN_ID_LENGTH) return "invalid_plugin_id"
  if (RESERVED_KEYS.has(payload.pluginID) || RESERVED_KEYS.has(payload.event) || hasReservedKey(payload.data))
    return "reserved_key"
  return undefined
}

// D1: the actual internal-publish call site. Validates with the SAME gate the wire path uses,
// then writes straight into the shared store — no HTTP, no `InstanceContextMiddleware`, no
// `InstanceStore.load()` re-entry. Returns a failure reason for the caller to warn on, or
// `undefined` on success. The caller (`plugin/index.ts`) is responsible for also relaying the
// event over the live SSE path (retention alone does not notify already-connected UI
// subscribers) — see `plugin/index.ts`'s own `sendPublish` for why that step is separate.
export function publishDirect(input: {
  directory: string
  workspaceID: string | undefined
  pluginID: string
  event: string
  data: unknown
}): ValidationKind | undefined {
  const invalid = validatePayload(input)
  if (invalid) return invalid
  write(
    input.directory,
    input.workspaceID ?? UNSCOPED,
    input.pluginID,
    input.event,
    input.data as JsonRecord,
    Date.now(),
  )
  return undefined
}

export * as PluginUiStore from "./ui-store"
