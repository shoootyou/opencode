import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Plugin } from "@opencode-ai/schema/plugin"
import { PluginUiEvent } from "@opencode-ai/schema/plugin-ui-event"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Clock, DateTime, Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PublishPayload } from "../groups/plugin-ui"
import { InvalidRequestError } from "../errors"
import {
  directories,
  MAX_DATA_BYTES,
  MAX_PLUGIN_ID_LENGTH,
  UNSCOPED,
  validatePayload,
  write as sharedWrite,
  type ScopeStore,
} from "@/plugin/ui-store"

type PluginID = typeof Plugin.ID.Type
type WorkspaceID = WorkspaceV2.ID
type JsonRecord = Record<string, Schema.Json>

// `UNSCOPED`/`ScopeStore`'s underlying key type are now owned by `@/plugin/ui-store` (D2, E6c) —
// this is the SAME module-level store the plugin runtime's `publishDirect` writes into directly,
// so both the wire path (this handler) and the internal self-flush path agree on the exact same
// sentinel identity and bucket shape. `WorkspaceKey` here is widened to `string | typeof
// UNSCOPED` to match the shared store's own key type; `WorkspaceID` is still what THIS handler
// narrows a caller-supplied `WorkspaceRef` to before writing.
type WorkspaceKey = string | typeof UNSCOPED

interface RetainedEntry {
  readonly data: JsonRecord
  // Server-stamped epoch ms (never plugin-supplied). Kept as a plain number
  // internally for cheap recency comparisons; converted to `DateTime.Utc`
  // only at the wire boundary (`DateTimeUtcFromMillis`'s decoded type).
  readonly publishedAt: number
}

function write(
  directory: string,
  workspaceKey: WorkspaceKey,
  pluginID: PluginID,
  eventName: string,
  data: JsonRecord,
  publishedAt: number,
) {
  sharedWrite(directory, workspaceKey, pluginID, eventName, data, publishedAt)
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
        pluginID: pluginID as PluginID,
        event: eventName,
        data: entry.data,
        publishedAt: entry.publishedAt,
        workspaceScoped: bucketKey !== UNSCOPED,
      })
    }
  }
  return rows
}

// OR-match read, widened to a full union under RFC 050 revision 5 (D22):
// `UNSCOPED ∪ every WorkspaceID bucket this directory's store holds` — not an
// OR-match against one caller-supplied workspaceID. Dedup key is still
// `(pluginID, eventName)`, still per directory; most-recent-`publishedAt`
// wins regardless of origin bucket, with a workspace-specific tie-break on
// exact ties (RFC 050 §1d "Workspace-axis write and read algorithm").
function snapshot(store: ScopeStore): FlatEntry[] {
  const workspaceKeys = [...store.keys()].filter((key): key is WorkspaceID => key !== UNSCOPED)
  const candidates = [...flatten(store, UNSCOPED), ...workspaceKeys.flatMap((key) => flatten(store, key))]
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
  return [...merged.values()]
}

interface DirectoryEntry extends FlatEntry {
  readonly directory: string
}

const RESPONSE_DIRECTORY_PLUGIN_CAP = 32
const RESPONSE_EVENTS_PER_BUCKET_CAP = 16

// D23 response-level cap, applied ACROSS directories over the composite bucket
// `(directory, pluginID)` — the same two magnitudes and the same composite key as the client's
// own cap (`plugin-status-indicator-logic.ts`), so the resident set after a snapshot refetch is
// exactly the resident set the live path would have produced.
function capAcrossDirectories(rows: DirectoryEntry[]): DirectoryEntry[] {
  const buckets = new Map<string, DirectoryEntry[]>()
  for (const row of rows) {
    const key = `${row.directory}\u0000${row.pluginID}`
    const bucket = buckets.get(key) ?? []
    if (!buckets.has(key)) buckets.set(key, bucket)
    bucket.push(row)
  }
  return [...buckets.values()]
    .map((bucket) => ({ bucket, maxPublishedAt: Math.max(...bucket.map((row) => row.publishedAt)) }))
    .sort((a, b) => b.maxPublishedAt - a.maxPublishedAt)
    .slice(0, RESPONSE_DIRECTORY_PLUGIN_CAP)
    .flatMap(({ bucket }) =>
      [...bucket].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, RESPONSE_EVENTS_PER_BUCKET_CAP),
    )
}

// D3 (E6c): translates the shared `validatePayload` gate's `ValidationKind` into this handler's
// own `InvalidRequestError` wire shape. The GATE ITSELF (`validatePayload` in `@/plugin/ui-store`)
// is shared verbatim with the plugin runtime's `publishDirect` — only this message/field mapping
// is HTTP-handler-specific, so the direct path can never diverge from what a caller of this
// endpoint would have been rejected for.
function validate(payload: typeof PublishPayload.Type) {
  const kind = validatePayload(payload)
  if (kind === "payload_too_large")
    return new InvalidRequestError({
      message: `data exceeds ${MAX_DATA_BYTES} bytes of UTF-8`,
      kind,
      field: "data",
    })
  if (kind === "invalid_event_name")
    return new InvalidRequestError({
      message: "event must match /^[A-Za-z0-9._-]{1,128}$/",
      kind,
      field: "event",
    })
  if (kind === "invalid_plugin_id")
    return new InvalidRequestError({
      message: `pluginID must be 1-${MAX_PLUGIN_ID_LENGTH} characters`,
      kind,
      field: "pluginID",
    })
  if (kind === "reserved_key")
    return new InvalidRequestError({
      message: "pluginID, event, and data keys may not be __proto__, constructor, or prototype",
      kind,
    })
  return undefined
}

export const pluginUiHandlers = HttpApiBuilder.group(InstanceHttpApi, "plugin-ui", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const publish = Effect.fn("PluginUiHttpApi.publish")(function* (ctx: { payload: typeof PublishPayload.Type }) {
      const error = validate(ctx.payload)
      if (error) return yield* error

      const directory = yield* InstanceState.directory
      const workspaceKey: WorkspaceKey = (yield* WorkspaceRef) ?? UNSCOPED
      const publishedAt = yield* Clock.currentTimeMillis
      write(directory, workspaceKey, ctx.payload.pluginID, ctx.payload.event, ctx.payload.data, publishedAt)

      yield* events.publish(PluginUiEvent.Custom, ctx.payload)
      return true
    })

    // D20/D21: aggregate across every directory the server currently holds plugin-UI state for
    // — not only the caller's resolved directory. `?directory=`/`?workspace=` still select which
    // instance answers the request (C18) but no longer narrow the result. `directories()` reads
    // the SAME shared module-level store (`@/plugin/ui-store`) the plugin runtime's
    // `publishDirect` writes into directly (D2, E6c) — no `InstanceState` cell is involved.
    const readSnapshot = Effect.fn("PluginUiHttpApi.snapshot")(function* () {
      const stores = directories()
      const serverTimeMillis = yield* Clock.currentTimeMillis

      const rows: DirectoryEntry[] = stores.flatMap(([directory, store]) =>
        snapshot(store).map((entry) => ({ ...entry, directory })),
      )

      return {
        serverTime: DateTime.makeUnsafe(serverTimeMillis),
        entries: capAcrossDirectories(rows).map(({ workspaceScoped: _workspaceScoped, ...row }) => ({
          ...row,
          publishedAt: DateTime.makeUnsafe(row.publishedAt),
        })),
      }
    })

    return handlers.handle("publish", publish).handle("snapshot", readSnapshot)
  }),
)
