/**
 * @spec-handoff
 * @interface PATCH /api/session/:sessionID { archive?: number | null }: 204
 * @behavior
 *   - archive: 0 and finite numbers archive; archive: null restores; omission preserves state.
 *   - GET remains archive-inclusive while list hides archived unless archived=true.
 *   - PATCH retains existing title, metadata, permissions, location middleware, and error mapping.
 * @edge-cases
 *   - Invalid archive values do not mutate state; missing sessions return 404.
 *   - Exhausted archive contention maps to ConflictError/409.
 */
import { expect } from "bun:test"
import path from "node:path"
import {
  node as SessionNode,
  Service as SessionService,
  type Interface as SessionInterface,
} from "../../core/src/session"
import { Session } from "@opencode/schema/session"
import { Effect, Layer, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SessionsResponse = Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.Info)) })
const options = {
  app: { version: "test" },
  database: { path: ":memory:" },
  fs: { filewatcher: false },
  models: { fetch: false },
}

it.live("archives, restores, and lists session archive state through the real server", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const request = (path: string, method = "GET", body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
      )
    const create = (title: string) =>
      request("/api/session", "POST", {
        title,
        metadata: { source: title },
        permissions: [{ action: "read", resource: "*", effect: "deny" }],
      }).pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json())),
        Effect.map((body) => Schema.decodeUnknownSync(SessionResponse)(body).data),
      )
    const get = (sessionID: string) =>
      request(`/api/session/${sessionID}`).pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json())),
        Effect.map((body) => Schema.decodeUnknownSync(SessionResponse)(body).data),
      )
    const list = (query = "") =>
      request(`/api/session${query}`).pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json())),
        Effect.map((body) => Schema.decodeUnknownSync(SessionsResponse)(body).data),
      )

    const archivedAtZero = yield* create("epoch")
    const archivedAtFinite = yield* create("finite")
    const active = yield* create("active")
    const omitted = yield* request(`/api/session/${archivedAtZero.id}`, "PATCH", {})
    expect(omitted.status).toBe(204)
    expect((yield* get(archivedAtZero.id)).time.archived).toBeUndefined()

    const epoch = yield* request(`/api/session/${archivedAtZero.id}`, "PATCH", { archive: 0 })
    const finite = yield* request(`/api/session/${archivedAtFinite.id}`, "PATCH", { archive: 7 })
    expect(epoch.status).toBe(204)
    expect(finite.status).toBe(204)
    expect((yield* get(archivedAtZero.id)).time.archived).toBe(0)
    expect((yield* get(archivedAtFinite.id)).time.archived).toBe(7)
    expect(yield* get(archivedAtZero.id)).toMatchObject({
      title: "epoch",
      metadata: { source: "epoch" },
      permissions: [{ action: "read", resource: "*", effect: "deny" }],
    })

    expect((yield* list()).map((session) => session.id)).toEqual([active.id])
    expect((yield* list("?archived=false")).map((session) => session.id)).toEqual([active.id])
    expect((yield* list("?archived=true")).map((session) => session.id)).toEqual(
      expect.arrayContaining([active.id, archivedAtZero.id, archivedAtFinite.id]),
    )

    const restored = yield* request(`/api/session/${archivedAtFinite.id}`, "PATCH", { archive: null })
    expect(restored.status).toBe(204)
    expect((yield* get(archivedAtFinite.id)).time.archived).toBeUndefined()
  }).pipe(Effect.scoped),
)

it.live("rejects invalid archive values without mutating mutable session fields", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
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
    const createdResponse = yield* request("/api/session", "POST", { title: "original", metadata: { stable: true } })
    const created = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => createdResponse.json())).data
    for (const archive of ["0", false, {}, []]) {
      const response = yield* request(`/api/session/${created.id}`, "PATCH", { archive })
      expect(response.status).toBe(400)
    }
    const response = yield* request(`/api/session/${created.id}`, "GET")
    const unchanged = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => response.json())).data
    expect(unchanged).toMatchObject({ title: "original", metadata: { stable: true } })
    expect(unchanged.time).not.toHaveProperty("archived")
  }).pipe(Effect.scoped),
)

it.live("keeps PATCH location middleware and missing-session mapping for archive", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-archive-location-")))
    const missing = path.join(root.path, "missing")
    const handler = yield* ServerFetch.make({ ...options, config: { project: false, directory: root.path } })
    const created = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ location: { directory: missing } }),
        }),
      ),
    )
    const session = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => created.json())).data
    const unavailable = yield* Effect.promise(() =>
      handler(
        new Request(`http://opencode.local/api/session/${session.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(missing) },
          body: JSON.stringify({ archive: 0 }),
        }),
      ),
    )
    expect(unavailable.status).toBe(404)
    expect(yield* Effect.promise(() => unavailable.json())).toMatchObject({
      _tag: "LocationNotFoundError",
      location: { directory: missing },
    })

    const unknown = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session/ses_missing", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archive: 0 }),
        }),
      ),
    )
    expect(unknown.status).toBe(404)
  }).pipe(Effect.scoped),
)

it.live("maps exhausted archive contention from the core service to ConflictError", () =>
  Effect.gen(function* () {
    const session = new Proxy({} as SessionInterface, {
      get(_, key) {
        if (key === "get") return () => Effect.succeed({ location: { directory: process.cwd() } })
        if (key === "list") return () => Effect.succeed({ data: [], cursor: {} })
        if (key === "setArchive")
          return () =>
            Effect.fail({
              _tag: "Session.ArchiveConflictError",
              sessionID: "ses_archive_conflict",
              message: "Archive contention exhausted",
            })
        return () => Effect.void
      },
    })
    const handler = yield* ServerFetch.make(options, {
      overrides: [SessionNode.replace(Layer.succeed(SessionService, session))],
    })
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session/ses_archive_conflict", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archive: 0 }),
        }),
      ),
    )

    expect(response.status).toBe(409)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      _tag: "ConflictError",
      resource: "ses_archive_conflict",
    })
  }).pipe(Effect.scoped),
)
