/**
 * @spec-handoff
 * @interface POST /plugin-ui/publish — payload `{ pluginID: Plugin.ID, event: string, data:
 *   Record<string, Schema.Json> }`, success `Schema.Boolean`, error `[HttpApiError.BadRequest,
 *   InvalidRequestError]`. Middlewares (exact order, matching groups/tui.ts:198-200):
 *   InstanceContextMiddleware → WorkspaceRoutingMiddleware → Authorization, plus
 *   `query: WorkspaceRoutingQuery`. UNCHANGED by RFC 050 revision 5 — the write path stays
 *   directory-scoped (D20's carve-out is read-only).
 * @interface GET /plugin-ui/snapshot — no payload, `query: WorkspaceRoutingQuery` (still
 *   DECLARED per the group-level middleware contract, but per revision 5's D22/C18 the query
 *   params no longer NARROW the result — see @behavior below), success
 *   `{ serverTime: DateTimeUtcFromMillis, entries: SnapshotEntry[] }` where `SnapshotEntry =
 *   { directory: Schema.String, pluginID, event, data, publishedAt: DateTimeUtcFromMillis }` —
 *   **AMENDED (revision 5, D22): `SnapshotEntry` gains `directory` as its first field.** A FLAT
 *   array, never a nested `Record<pluginID, Record<eventName, …>>`. Empty scope → 200
 *   `{ entries: [] }`, never 404.
 * @interface `groups/plugin-ui.ts` MUST export `PluginUiPaths = { publish: "/plugin-ui/publish",
 *   snapshot: "/plugin-ui/snapshot" } as const`, mirroring `TuiPaths`/`EventPaths`/`WorkspacePaths`.
 * @behavior
 *   - Retained store: `Map<WorkspaceKey, Map<PluginID, Map<EventName, RetainedEntry>>>` per
 *     directory via `InstanceState.make` (`WorkspaceKey = WorkspaceID | typeof UNSCOPED`, a
 *     `unique symbol` — never a plain string key, anywhere, at any level). UNCHANGED by revision
 *     5 — this describes the STORE and the WRITE path, which D20 does not touch.
 *   - **AMENDED (revision 5, D20): the READ is now cross-directory.** `GET /plugin-ui/snapshot`
 *     aggregates over `InstanceState.entries(state)` — EVERY directory the server currently holds
 *     plugin-UI state for — not only the caller's resolved directory. Each returned row carries
 *     its OWN `directory` (D22), sourced from the `ScopedCache` key that directory's bucket lives
 *     under, never from the caller's own directory context. A response-level cap (D23) then keeps
 *     at most the 32 most-recently-updated `(directory, pluginID)` buckets, each truncated to its
 *     16 most-recently-updated rows — the SAME two magnitudes as the client's own cap, over the
 *     SAME composite key.
 *   - **AMENDED (revision 5, D22): the workspace axis now COLLAPSES on read, per directory.**
 *     Within one directory's aggregate, the snapshot unions `UNSCOPED` with EVERY `WorkspaceID`
 *     bucket that directory's store holds — not an OR-match against the caller's own
 *     `?workspace=` query param. Dedup key is still `(pluginID, eventName)`, still per directory;
 *     the entry with the greater `publishedAt` wins regardless of which workspace bucket it came
 *     from (recency beats specificity — unchanged from revision 3/4's own rule, now evaluated
 *     over a wider per-directory input set). Per C18, the `?directory=`/`?workspace=` query
 *     params are still DECLARED and still select which instance answers the request, but they no
 *     longer NARROW which rows come back — a read with no `?workspace=` param returns the exact
 *     same per-directory union as a read WITH one, for that same directory.
 *   - Validation order, all BEFORE `EventV2Bridge.publish` and before anything is retained, all
 *     reject (never truncate/sanitize) with `InvalidRequestError` (400):
 *     `payload_too_large` (`data` > 16 KiB of UTF-8 bytes, `TextEncoder`-measured, never
 *     `.length`), `invalid_event_name` (`event` not matching `/^[A-Za-z0-9._-]{1,128}$/`),
 *     `invalid_plugin_id` (`pluginID` empty or > 256 chars), `reserved_key` (`pluginID`, `event`,
 *     or any `data` key at any depth is `__proto__`/`constructor`/`prototype`). UNCHANGED by
 *     revision 5.
 *   - Eviction per `(directory, workspaceKey)` bucket, by least-recently-**updated** (never
 *     least-recently-inserted): 17th distinct `eventName` for one plugin evicts that plugin's
 *     oldest entry (cap 16); 33rd distinct `pluginID` evicts the whole oldest plugin bucket
 *     (cap 32). UNCHANGED by revision 5 — this is the RETENTION cap (write-side, per-bucket), a
 *     different thing from the new response-level cap named above (read-side, per-response).
 *   - `publishedAt` is server-stamped inside the handler — never taken from a plugin-supplied
 *     `data` field. `serverTime` in the snapshot response is always >= every `publishedAt` in
 *     that response. UNCHANGED by revision 5.
 * @edge-cases
 *   - **Cross-directory aggregation (D20), amending the former D13 isolation edge-case:** a
 *     snapshot read from ANY directory now includes every OTHER directory's retained entries too,
 *     each correctly attributed with its own `directory`. D13's write-side attribution is NOT
 *     withdrawn — a directory's entries are still written only by that directory's own publishes
 *     — only who may READ the aggregate is widened.
 *   - **Workspace-axis full union (D22), amending the former per-request OR-match edge-case:** an
 *     entry published under one `WorkspaceID` bucket in a directory is visible from EVERY read of
 *     that directory's snapshot, regardless of the read's own `?workspace=` query param (including
 *     no param at all) — never scoped down to just the UNSCOPED bucket or just the caller's own
 *     workspace bucket.
 *   - A rejected (oversized) publish must not reach `EventV2Bridge.publish` — no SSE broadcast,
 *     not even a truncated one. UNCHANGED by revision 5.
 * @see .yui-soul/rfcs/approved/050-opencode-plugin-ui-event-channel/README.md §1c/§1d, D20, D21,
 *      D22, D23, C18
 * @see ../../src/server/routes/instance/httpapi/groups/tui.ts (the endpoint this mirrors 1:1)
 * @see ../../src/server/routes/instance/httpapi/handlers/event.ts (InstanceState.workspaceID / WorkspaceRef read pattern)
 * @see ../../src/effect/instance-state.ts (`InstanceState.entries`, the new one-line accessor D21
 *      adds over the plugin-UI cell's own `ScopedCache`, enabling the cross-directory aggregate)
 */

import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { ServerAuth } from "../../src/server/auth"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { WorkspacePaths } from "../../src/server/routes/instance/httpapi/groups/workspace"
// Not yet implemented (Kou, plan 293 E4) — this import failing to resolve IS the RED signal
// for this file. `PluginUiPaths` mirrors the `TuiPaths`/`EventPaths`/`WorkspacePaths` convention.
import { PluginUiPaths } from "../../src/server/routes/instance/httpapi/groups/plugin-ui"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir, tmpdirScoped, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Mirrors test/server/httpapi-instance-route-auth.test.ts's `app(...)` helper: binds directly to
// the REAL production route tree (HttpApiApp.routes) with a ConfigProvider-injected password, so
// this exercises the actual `.middleware(Authorization)` wiring on the real PluginUiApi group
// once it exists — not a re-declared probe.
function pluginUiApp(input: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input.password,
            OPENCODE_SERVER_USERNAME: input.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(path: string, init?: RequestInit) {
      return handler(new Request(new URL(path, "http://localhost"), init), HttpApiApp.context)
    },
  }
}

function basic(username: string, password: string) {
  return ServerAuth.header({ username, password }) ?? ""
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

const text = (response: HttpClientResponse.HttpClientResponse) => response.text
const json = (response: HttpClientResponse.HttpClientResponse) => response.json

const jsonHeaders = { "content-type": "application/json" }

function publishBody(input: { pluginID: string; event: string; data: unknown }) {
  return JSON.stringify(input)
}

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

// Mirrors test/server/httpapi-event.test.ts's SSE-reading idiom exactly: a bounded queue of raw
// chunks fed from the live stream, read with a timeout so "no event arrived" is a first-class,
// non-flaky assertion rather than a fixed sleep.
const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("plugin-ui HttpApi authorization (existing middleware reuse, groups/tui.ts:198-200)", () => {
  test("rejects an unauthenticated publish request when a password is configured", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = pluginUiApp({ password: "secret", username: "opencode" })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const body = publishBody({ pluginID: "auth-plugin", event: "status", data: {} })

    const missing = await server.request(PluginUiPaths.publish, { method: "POST", headers, body })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(PluginUiPaths.publish, {
      method: "POST",
      headers: { ...headers, authorization: basic("opencode", "secret") },
      body,
    })
    await cancelBody(authed)
    expect(authed.status).not.toBe(401)
  })

  test("rejects an unauthenticated snapshot read when a password is configured", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = pluginUiApp({ password: "secret", username: "opencode" })
    const headers = { "x-opencode-directory": tmp.path }

    const missing = await server.request(PluginUiPaths.snapshot, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(PluginUiPaths.snapshot, {
      headers: { ...headers, authorization: basic("opencode", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).not.toBe(401)
  })
})

describe("plugin-ui HttpApi validation", () => {
  it.instance(
    "rejects data over 16 KiB of UTF-8 bytes before publish (payload_too_large)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // All-ASCII so JS string .length and UTF-8 byte length coincide at 1 byte/char — the
        // oversize itself doesn't depend on the byte-vs-code-unit distinction the RFC calls out;
        // that distinction is covered by the codepoint-count assertion below.
        const data = { blob: "x".repeat(17 * 1024) }
        const res = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "size-plugin", event: "status", data }),
        })
        expect(res.status).toBe(400)
        const parsed = JSON.parse(yield* text(res))
        expect(parsed).toMatchObject({ _tag: "InvalidRequestError", kind: "payload_too_large" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "measures the 16 KiB bound in UTF-8 bytes, not JS string .length",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // 6000 3-byte-UTF-8 CJK codepoints = 6000 JS string .length (well under any naive
        // 16*1024 .length-based check) but 18000 UTF-8 bytes (over the real byte bound). A
        // .length-based implementation would wrongly accept this; a byte-measured one rejects it.
        const data = { blob: "\u6f22".repeat(6000) }
        expect(data.blob.length).toBeLessThan(16 * 1024)
        expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeGreaterThan(16 * 1024)
        const res = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "size-plugin-cjk", event: "status", data }),
        })
        expect(res.status).toBe(400)
        const parsed = JSON.parse(yield* text(res))
        expect(parsed).toMatchObject({ _tag: "InvalidRequestError", kind: "payload_too_large" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not broadcast the rejected oversized payload over SSE (D14 — publish-time, not retention-only)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { reader } = yield* openEventStream(test.directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const data = { blob: "x".repeat(17 * 1024) }
        const res = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "size-plugin", event: "status", data }),
        })
        expect(res.status).toBe(400)

        // If no event arrives within 250ms, nothing was broadcast for the rejected publish.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects __proto__ as pluginID (reserved_key)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const res = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "__proto__", event: "status", data: {} }),
        })
        expect(res.status).toBe(400)
        const parsed = JSON.parse(yield* text(res))
        expect(parsed).toMatchObject({ _tag: "InvalidRequestError", kind: "reserved_key" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects constructor as the event name (reserved_key)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const res = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "reserved-plugin", event: "constructor", data: {} }),
        })
        expect(res.status).toBe(400)
        const parsed = JSON.parse(yield* text(res))
        expect(parsed).toMatchObject({ _tag: "InvalidRequestError", kind: "reserved_key" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects prototype as a top-level data key (reserved_key)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // Raw JSON text, not a JS object literal: `{ prototype: "x" }` as a literal is an
        // ordinary own key too, but the sibling __proto__ cases below MUST be raw text (a JS
        // object literal's `__proto__` key sets the prototype rather than creating an own
        // property), so every case in this group uses the same raw-text construction for
        // consistency and to make the parallel with the real wire attack explicit.
        const res = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
          method: "POST",
          headers: jsonHeaders,
          body: '{"pluginID":"reserved-plugin","event":"status","data":{"prototype":"danger"}}',
        })
        expect(res.status).toBe(400)
        const parsed = JSON.parse(yield* text(res))
        expect(parsed).toMatchObject({ _tag: "InvalidRequestError", kind: "reserved_key" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects __proto__ as a nested data key at any depth (reserved_key)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // JSON.parse gives `__proto__` here as a genuine own enumerable key (JSON.parse uses
        // [[DefineOwnProperty]] semantics, unlike a JS object literal or `obj.__proto__ =`
        // assignment) — this is the actual wire-level attack shape the RFC's reserved_key rule
        // defends against, at nesting depth 2.
        const res = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
          method: "POST",
          headers: jsonHeaders,
          body: '{"pluginID":"nested-plugin","event":"status","data":{"safe":{"__proto__":"danger"}}}',
        })
        expect(res.status).toBe(400)
        const parsed = JSON.parse(yield* text(res))
        expect(parsed).toMatchObject({ _tag: "InvalidRequestError", kind: "reserved_key" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

describe("plugin-ui HttpApi retained snapshot", () => {
  // REPLACES the former D13 isolation test ("publish under directory A is not visible in a
  // snapshot read at directory B"), which asserted the OPPOSITE of what D20 now specifies. Kept
  // in the same spot, same dirA/dirB fixture setup, same publish — only the assertion DIRECTION
  // and the test name change, per RFC 050 revision 5 D20 ("a deliberate, explicit widening of
  // D13's isolation property — on the read path only"; D13's WRITE-side attribution is unchanged
  // and re-asserted below via each entry's own `directory` field).
  it.live(
    "a snapshot read from any directory includes every directory's retained entries, each attributed with its own directory (D20)",
    () =>
      Effect.gen(function* () {
        const dirA = yield* tmpdirScoped({ git: true })
        const dirB = yield* tmpdirScoped({ git: true })

        const published = yield* requestInDirectory(PluginUiPaths.publish, dirA, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "isolation-plugin", event: "status", data: { scope: "A" } }),
        })
        expect(published.status).toBe(200)

        const snapshotA = yield* requestInDirectory(PluginUiPaths.snapshot, dirA)
        const bodyA = (yield* json(snapshotA)) as {
          entries: Array<{ pluginID: string; event: string; directory: string }>
        }
        expect(bodyA.entries).toContainEqual(
          expect.objectContaining({ pluginID: "isolation-plugin", event: "status", directory: dirA }),
        )

        // D20's carve-out, proven directly: a snapshot READ from directory B now DOES include
        // directory A's own retained entry — not proving isolation (the former D13 assertion),
        // but proving the cross-directory aggregate is real, bounded to what the server actually
        // retains, and correctly attributed. `directory: dirA` is the load-bearing part of this
        // assertion: the row must be labelled with the DIRECTORY IT WAS PUBLISHED UNDER, not the
        // reading caller's own directory (dirB) — proving D13's write-side attribution still
        // holds even though the read-side isolation it used to imply no longer does.
        const snapshotB = yield* requestInDirectory(PluginUiPaths.snapshot, dirB)
        const bodyB = (yield* json(snapshotB)) as { entries: Array<{ pluginID: string; directory: string }> }
        expect(bodyB.entries).toContainEqual(
          expect.objectContaining({ pluginID: "isolation-plugin", directory: dirA }),
        )
      }),
  )

  it.instance(
    "publishedAt is server-stamped (never plugin-supplied) and serverTime >= every publishedAt",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const published = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
          method: "POST",
          headers: jsonHeaders,
          // A client-supplied `data.publishedAt` must never leak into the wire-level
          // `publishedAt` — it is server-stamped, per §1d "Timestamps".
          body: publishBody({ pluginID: "clock-plugin", event: "status", data: { publishedAt: 1 } }),
        })
        expect(published.status).toBe(200)

        const snapshot = yield* requestInDirectory(PluginUiPaths.snapshot, test.directory)
        const body = (yield* json(snapshot)) as {
          serverTime: number
          entries: Array<{ pluginID: string; publishedAt: number }>
        }
        expect(typeof body.serverTime).toBe("number")
        const entry = body.entries.find((candidate) => candidate.pluginID === "clock-plugin")
        expect(entry).toBeDefined()
        expect(typeof entry?.publishedAt).toBe("number")
        expect(entry?.publishedAt).not.toBe(1)
        body.entries.forEach((candidate) => {
          expect(body.serverTime).toBeGreaterThanOrEqual(candidate.publishedAt)
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "evicts the least-recently-updated eventName on the 17th distinct eventName for one plugin",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        for (let index = 0; index < 17; index++) {
          const res = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
            method: "POST",
            headers: jsonHeaders,
            body: publishBody({ pluginID: "evict-event-plugin", event: `event-${index}`, data: { index } }),
          })
          expect(res.status).toBe(200)
        }
        const snapshot = yield* requestInDirectory(PluginUiPaths.snapshot, test.directory)
        const body = (yield* json(snapshot)) as { entries: Array<{ pluginID: string; event: string }> }
        const events = body.entries.filter((entry) => entry.pluginID === "evict-event-plugin").map((entry) => entry.event)
        expect(events).toHaveLength(16)
        expect(events).not.toContain("event-0")
        expect(events).toContain("event-16")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "evicts the whole least-recently-updated plugin bucket on the 33rd distinct pluginID",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        for (let index = 0; index < 33; index++) {
          const res = yield* requestInDirectory(PluginUiPaths.publish, test.directory, {
            method: "POST",
            headers: jsonHeaders,
            body: publishBody({ pluginID: `evict-bucket-plugin-${index}`, event: "status", data: { index } }),
          })
          expect(res.status).toBe(200)
        }
        const snapshot = yield* requestInDirectory(PluginUiPaths.snapshot, test.directory)
        const body = (yield* json(snapshot)) as { entries: Array<{ pluginID: string }> }
        const pluginIDs = new Set(body.entries.map((entry) => entry.pluginID))
        expect(pluginIDs.size).toBe(32)
        expect(pluginIDs.has("evict-bucket-plugin-0")).toBe(false)
        expect(pluginIDs.has("evict-bucket-plugin-32")).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

// Workspace-axis merge (§1d) needs a real registered Workspace so `?workspace=<id>` resolves
// without the routing middleware's own "workspace not found" 500 — mirrors the
// registerAdapter + POST-to-create pattern test/server/httpapi-workspace.test.ts already
// establishes, rather than re-deriving workspace creation from scratch.
function localAdapter(directory: string): WorkspaceAdapter {
  return {
    name: "Local Test",
    description: "Create a local test workspace",
    configure: (info) => ({ ...info, name: "local-test", directory }),
    create: async () => {},
    remove: async () => {},
    target: () => ({ type: "local" as const, directory }),
  }
}

const workspaceAppLayer = AppNodeBuilder.build(
  LayerNode.group([Project.node, Session.node, Workspace.node, InstanceStore.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
)

const originalExperimentalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

afterEach(() => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalExperimentalWorkspaces
})

const withWorkspace = testEffect(Layer.mergeAll(workspaceAppLayer, httpApiLayer))

describe("plugin-ui HttpApi workspace-axis merge (§1d/D22)", () => {
  // REPLACES the former test name "OR-matches UNSCOPED ∪ workspaceID, and the later publishedAt
  // wins on a bucket collision" — that name described the pre-revision-5 per-request OR-match.
  // Under D22 the workspace axis collapses to a FULL union of every workspace bucket a directory
  // holds, on EVERY read of that directory regardless of the read's own `?workspace=` query
  // param (C18: query params route the request but no longer narrow the result). Only assertion
  // #2 below (the former "workspace non-match" check) and its trailing "no workspace param"
  // corollary change direction; assertion #1 (UNSCOPED visible from both A and B reads) and
  // assertion #3 (recency-wins tie-break on a (pluginID, eventName) collision) still hold exactly
  // as written under D22 — the fixture setup and publish sequence are otherwise untouched.
  withWorkspace.live(
    "unions EVERY workspace bucket on every read of a directory (D22), and the later publishedAt still wins on a bucket collision",
    () =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const dir = yield* tmpdirScoped({ git: true })
        const project = yield* Project.use.fromDirectory(dir)

        registerAdapter(project.project.id, "plugin-ui-test-a", localAdapter(dir))
        const createdA = yield* requestInDirectory(WorkspacePaths.list, dir, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ type: "plugin-ui-test-a", branch: null }),
        })
        expect(createdA.status).toBe(200)
        const workspaceA = (yield* json(createdA)) as { id: string }

        registerAdapter(project.project.id, "plugin-ui-test-b", localAdapter(dir))
        const createdB = yield* requestInDirectory(WorkspacePaths.list, dir, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ type: "plugin-ui-test-b", branch: null }),
        })
        expect(createdB.status).toBe(200)
        const workspaceB = (yield* json(createdB)) as { id: string }

        // 1. Published with no workspace context — visible from both a workspace-A-scoped read
        //    and a workspace-B-scoped read (the UNSCOPED left disjunct of the OR-match).
        const unscoped = yield* requestInDirectory(PluginUiPaths.publish, dir, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "ws-plugin", event: "unscoped-event", data: { from: "unscoped" } }),
        })
        expect(unscoped.status).toBe(200)

        const readA = (yield* json(
          yield* requestInDirectory(`${PluginUiPaths.snapshot}?workspace=${workspaceA.id}`, dir),
        )) as { entries: Array<{ pluginID: string; event: string }> }
        expect(readA.entries).toContainEqual(expect.objectContaining({ pluginID: "ws-plugin", event: "unscoped-event" }))

        const readB = (yield* json(
          yield* requestInDirectory(`${PluginUiPaths.snapshot}?workspace=${workspaceB.id}`, dir),
        )) as { entries: Array<{ pluginID: string; event: string }> }
        expect(readB.entries).toContainEqual(expect.objectContaining({ pluginID: "ws-plugin", event: "unscoped-event" }))

        // 2. REPLACES the former "published under workspace B — NOT visible from a
        //    workspace-A-scoped read" assertion (D13-era per-request OR-match), which asserted
        //    the OPPOSITE of what D22 now specifies. Under D22 the workspace axis collapses on
        //    read: a directory's snapshot unions UNSCOPED with EVERY WorkspaceID bucket that
        //    directory holds, not an OR-match against the caller's own `?workspace=` query
        //    param — so an entry published under workspace B's bucket IS now visible from a
        //    workspace-A-scoped read of the SAME directory too.
        const scopedB = yield* requestInDirectory(`${PluginUiPaths.publish}?workspace=${workspaceB.id}`, dir, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "ws-plugin", event: "b-only-event", data: { from: "B" } }),
        })
        expect(scopedB.status).toBe(200)

        const readAAfterB = (yield* json(
          yield* requestInDirectory(`${PluginUiPaths.snapshot}?workspace=${workspaceA.id}`, dir),
        )) as { entries: Array<{ pluginID: string; event: string }> }
        expect(readAAfterB.entries).toContainEqual(expect.objectContaining({ pluginID: "ws-plugin", event: "b-only-event" }))

        // 3. Collision on (pluginID, eventName): publish under workspace A first (older), then
        //    publish UNSCOPED later (newer) for the SAME pair. The later publishedAt wins even
        //    though the workspace-A bucket is the "more specific" one for a workspace-A read —
        //    recency beats specificity (§1d).
        const olderScopedA = yield* requestInDirectory(`${PluginUiPaths.publish}?workspace=${workspaceA.id}`, dir, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "ws-plugin", event: "collide-event", data: { from: "A-older" } }),
        })
        expect(olderScopedA.status).toBe(200)

        const newerUnscoped = yield* requestInDirectory(PluginUiPaths.publish, dir, {
          method: "POST",
          headers: jsonHeaders,
          body: publishBody({ pluginID: "ws-plugin", event: "collide-event", data: { from: "unscoped-newer" } }),
        })
        expect(newerUnscoped.status).toBe(200)

        const collisionRead = (yield* json(
          yield* requestInDirectory(`${PluginUiPaths.snapshot}?workspace=${workspaceA.id}`, dir),
        )) as { entries: Array<{ pluginID: string; event: string; data: { from: string } }> }
        const collided = collisionRead.entries.find(
          (entry) => entry.pluginID === "ws-plugin" && entry.event === "collide-event",
        )
        expect(collided?.data.from).toBe("unscoped-newer")

        // Corollary of the assertion #2 fix above, same D22/C18 rule, not a separately-flagged
        // item in its own right — but leaving this check in its pre-revision-5 direction would
        // make it permanently, unfixably red the moment assertion #2 above is satisfied
        // correctly: under D22/C18 the query params never narrow the result at all, so a read
        // with NO `?workspace=` param returns the EXACT SAME per-directory union as a read WITH
        // one. A read with no workspace param therefore now sees workspace B's "b-only-event"
        // too — not "only the UNSCOPED bucket", as it did pre-revision-5.
        const readNoWorkspaceParam = (yield* json(yield* requestInDirectory(PluginUiPaths.snapshot, dir))) as {
          entries: Array<{ event: string }>
        }
        expect(readNoWorkspaceParam.entries).toContainEqual(expect.objectContaining({ event: "b-only-event" }))
      }),
  )
})
