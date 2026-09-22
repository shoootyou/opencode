import { InstanceState } from "@/effect/instance-state"
import { WorkspaceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Plugin } from "@opencode-ai/schema/plugin"
import { PluginUiEvent } from "@opencode-ai/schema/plugin-ui-event"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Clock, DateTime, Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PublishPayload } from "../groups/plugin-ui"
import { InvalidRequestError } from "../errors"

type PluginID = typeof Plugin.ID.Type
type WorkspaceID = WorkspaceV2.ID
type JsonRecord = Record<string, Schema.Json>

// A `symbol`, deliberately — a plugin- or client-supplied `WorkspaceID` is a
// string and therefore can never forge or collide with this sentinel (RFC
// 050 §1d "Store shape").
const UNSCOPED: unique symbol = Symbol("plugin-ui.unscoped")
type WorkspaceKey = WorkspaceID | typeof UNSCOPED

interface RetainedEntry {
  readonly data: JsonRecord
  // Server-stamped epoch ms (never plugin-supplied). Kept as a plain number
  // internally for cheap recency comparisons; converted to `DateTime.Utc`
  // only at the wire boundary (`DateTimeUtcFromMillis`'s decoded type).
  readonly publishedAt: number
}

type EventBucket = Map<string, RetainedEntry>
type PluginBucket = Map<PluginID, EventBucket>
// One of these per directory, via `InstanceState.make` — `Map` at every
// level, never a plain object, since plugin-controlled strings must never
// become plain-object keys (RFC 050 §1d).
type ScopeStore = Map<WorkspaceKey, PluginBucket>

const EVENTS_PER_PLUGIN_CAP = 16
const PLUGINS_PER_BUCKET_CAP = 32
const MAX_DATA_BYTES = 16 * 1024
const EVENT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const MAX_PLUGIN_ID_LENGTH = 256
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"])

function hasReservedKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReservedKey)
  if (value === null || typeof value !== "object") return false
  const record = value as JsonRecord
  return Object.keys(record).some((key) => RESERVED_KEYS.has(key) || hasReservedKey(record[key]))
}

// Moves `eventName` to the end of `bucket` (most-recently-updated), then
// evicts the least-recently-updated entry if the per-plugin cap is exceeded.
// "Oldest" is last-update time, never insertion time (RFC 050 §1d).
function touchEvent(bucket: EventBucket, eventName: string, entry: RetainedEntry) {
  bucket.delete(eventName)
  bucket.set(eventName, entry)
  if (bucket.size <= EVENTS_PER_PLUGIN_CAP) return
  const oldest = bucket.keys().next().value
  if (oldest !== undefined) bucket.delete(oldest)
}

// Moves `pluginID` to the end of `byPlugin` (most-recently-updated), then
// evicts the whole least-recently-updated plugin bucket if the per-bucket
// plugin cap is exceeded.
function touchPlugin(byPlugin: PluginBucket, pluginID: PluginID): EventBucket {
  const bucket = byPlugin.get(pluginID) ?? new Map<string, RetainedEntry>()
  byPlugin.delete(pluginID)
  byPlugin.set(pluginID, bucket)
  if (byPlugin.size > PLUGINS_PER_BUCKET_CAP) {
    const oldest = byPlugin.keys().next().value
    if (oldest !== undefined) byPlugin.delete(oldest)
  }
  return bucket
}

function write(
  store: ScopeStore,
  workspaceKey: WorkspaceKey,
  pluginID: PluginID,
  eventName: string,
  data: JsonRecord,
  publishedAt: number,
) {
  const byPlugin = store.get(workspaceKey) ?? new Map<PluginID, EventBucket>()
  if (!store.has(workspaceKey)) store.set(workspaceKey, byPlugin)
  const bucket = touchPlugin(byPlugin, pluginID)
  touchEvent(bucket, eventName, { data, publishedAt })
}

interface FlatEntry {
  readonly pluginID: PluginID
  readonly event: string
  readonly data: JsonRecord
  readonly publishedAt: number
  readonly workspaceScoped: boolean
}

// Flattens one bucket into candidate rows. An absent bucket is the common
// case (nothing was ever published into it) and contributes no candidates —
// never an error (RFC 050 §1d).
function flatten(store: ScopeStore, bucketKey: WorkspaceKey): FlatEntry[] {
  const byPlugin = store.get(bucketKey)
  if (!byPlugin) return []
  const rows: FlatEntry[] = []
  for (const [pluginID, bucket] of byPlugin) {
    for (const [eventName, entry] of bucket) {
      rows.push({
        pluginID,
        event: eventName,
        data: entry.data,
        publishedAt: entry.publishedAt,
        workspaceScoped: bucketKey !== UNSCOPED,
      })
    }
  }
  return rows
}

// OR-match read: `UNSCOPED ∪ (workspaceID ?? nothing)`. Dedup key is
// `(pluginID, eventName)`; most-recent-`publishedAt` wins regardless of
// origin bucket, with a workspace-specific tie-break on exact ties (RFC 050
// §1d "Workspace-axis write and read algorithm").
function snapshot(store: ScopeStore, workspaceID: WorkspaceID | undefined) {
  const candidates = [...flatten(store, UNSCOPED), ...(workspaceID === undefined ? [] : flatten(store, workspaceID))]
  const merged = new Map<string, FlatEntry>()
  for (const entry of candidates) {
    const key = `${entry.pluginID}\u0000${entry.event}`
    const existing = merged.get(key)
    if (existing === undefined) {
      merged.set(key, entry)
      continue
    }
    if (entry.publishedAt > existing.publishedAt) {
      merged.set(key, entry)
      continue
    }
    if (entry.publishedAt === existing.publishedAt && entry.workspaceScoped) merged.set(key, entry)
  }
  // `workspaceScoped` is a merge-local tag, dropped here — never a wire field.
  return Array.from(merged.values(), ({ workspaceScoped: _workspaceScoped, ...row }) => ({
    ...row,
    publishedAt: DateTime.makeUnsafe(row.publishedAt),
  }))
}

function validate(payload: typeof PublishPayload.Type) {
  const byteLength = new TextEncoder().encode(JSON.stringify(payload.data)).length
  if (byteLength > MAX_DATA_BYTES)
    return new InvalidRequestError({
      message: `data exceeds ${MAX_DATA_BYTES} bytes of UTF-8`,
      kind: "payload_too_large",
      field: "data",
    })
  if (!EVENT_NAME_PATTERN.test(payload.event))
    return new InvalidRequestError({
      message: "event must match /^[A-Za-z0-9._-]{1,128}$/",
      kind: "invalid_event_name",
      field: "event",
    })
  if (payload.pluginID.length === 0 || payload.pluginID.length > MAX_PLUGIN_ID_LENGTH)
    return new InvalidRequestError({
      message: `pluginID must be 1-${MAX_PLUGIN_ID_LENGTH} characters`,
      kind: "invalid_plugin_id",
      field: "pluginID",
    })
  if (RESERVED_KEYS.has(payload.pluginID) || RESERVED_KEYS.has(payload.event) || hasReservedKey(payload.data))
    return new InvalidRequestError({
      message: "pluginID, event, and data keys may not be __proto__, constructor, or prototype",
      kind: "reserved_key",
    })
  return undefined
}

export const pluginUiHandlers = HttpApiBuilder.group(InstanceHttpApi, "plugin-ui", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<ScopeStore>(() => Effect.succeed(new Map()))

    const publish = Effect.fn("PluginUiHttpApi.publish")(function* (ctx: { payload: typeof PublishPayload.Type }) {
      const error = validate(ctx.payload)
      if (error) return yield* error

      const store = yield* InstanceState.get(state)
      const workspaceKey: WorkspaceKey = (yield* WorkspaceRef) ?? UNSCOPED
      const publishedAt = yield* Clock.currentTimeMillis
      write(store, workspaceKey, ctx.payload.pluginID, ctx.payload.event, ctx.payload.data, publishedAt)

      yield* events.publish(PluginUiEvent.Custom, ctx.payload)
      return true
    })

    const readSnapshot = Effect.fn("PluginUiHttpApi.snapshot")(function* () {
      const store = yield* InstanceState.get(state)
      const workspaceID = yield* WorkspaceRef
      const serverTimeMillis = yield* Clock.currentTimeMillis
      return {
        serverTime: DateTime.makeUnsafe(serverTimeMillis),
        entries: snapshot(store, workspaceID),
      }
    })

    return handlers.handle("publish", publish).handle("snapshot", readSnapshot)
  }),
)
