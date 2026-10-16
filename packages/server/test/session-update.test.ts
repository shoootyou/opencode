/**
 * @spec-handoff
 * @interface PATCH /api/session/:sessionID { archive?: number | null }: 204 | SessionNotFoundError
 * @behavior
 *   - An omitted archive property leaves a session unchanged; a timestamp archives it and null restores it.
 *   - Repeating the represented archive state is a durable no-op and does not mutate unrelated session fields.
 *   - Session-location authorization remains required for this protected update endpoint.
 * @edge-cases
 *   - An unknown session returns the existing NotFound response for archive and restore requests.
 * @see ../src/handlers/session.ts
 */
import { expect } from "bun:test"
import path from "node:path"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

it.live("updates session metadata through PATCH", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, method: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        expect(response.status).toBe(method === "PATCH" ? 204 : 200)
        return response.status === 204 ? undefined : response.json()
      })

    const created = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/session", "POST", { metadata: { source: "create", stale: true } }),
    )
    yield* request(`/api/session/${created.data.id}`, "PATCH", { metadata: { source: "patch" } })
    const updated = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${created.data.id}`, "GET"))

    expect(updated.data.metadata).toEqual({ source: "patch" })
  }).pipe(Effect.scoped),
)

it.live("archives and restores through PATCH without changing unrelated session state", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, method: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
      )

    const createResponse = yield* request("/api/session", "POST", { title: "unchanged" })
    const created = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => createResponse.json()))
    const before = created.data

    expect((yield* request(`/api/session/${created.data.id}`, "PATCH", { archive: 123 })).status).toBe(204)
    const archivedResponse = yield* request(`/api/session/${created.data.id}`, "GET")
    const archived = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => archivedResponse.json()))
    expect(archived.data.time.archived).toBe(123)
    expect(archived.data.title).toBe(before.title)
    expect(archived.data.metadata).toEqual(before.metadata)
    expect(archived.data.permissions).toEqual(before.permissions)

    expect((yield* request(`/api/session/${created.data.id}`, "PATCH", { archive: 123 })).status).toBe(204)
    const repeatedResponse = yield* request(`/api/session/${created.data.id}`, "GET")
    const repeated = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => repeatedResponse.json()))
    expect(repeated.data.time).toEqual(archived.data.time)

    expect((yield* request(`/api/session/${created.data.id}`, "PATCH", { archive: null })).status).toBe(204)
    const restoredResponse = yield* request(`/api/session/${created.data.id}`, "GET")
    const restored = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => restoredResponse.json()))
    expect(restored.data.time.archived).toBeUndefined()
    expect(restored.data.title).toBe(before.title)
  }).pipe(Effect.scoped),
)

it.live("returns the existing NotFound response when archiving an unknown session", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session/ses_missing", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archive: 123 }),
        }),
      ),
    )

    expect(response.status).toBe(404)
  }).pipe(Effect.scoped),
)

it.live("keeps session-location middleware on PATCH when the session location is unavailable", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-session-update-location-")))
    const directory = path.join(config.path, "missing")
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      config: { directory: config.path, project: false },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const created = Schema.decodeUnknownSync(SessionResponse)(
      yield* Effect.promise(() =>
        handler(
          new Request("http://opencode.local/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ location: { directory } }),
          }),
        ).then((response) => response.json()),
      ),
    )

    const response = yield* Effect.promise(() =>
      handler(
        new Request(`http://opencode.local/api/session/${created.data.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archive: 123 }),
        }),
      ),
    )
    expect(response.status).toBe(404)
    expect(yield* Effect.promise(() => response.json())).toEqual({
      _tag: "LocationNotFoundError",
      location: { directory },
      message: `Location not found: ${directory}`,
    })
  }),
)
