/**
 * @spec-handoff
 * @interface PATCH /api/session/:sessionID { archived?: boolean }: 204
 * @behavior
 *   - Native true archives, false restores, and omitted archived leaves state unchanged.
 *   - A malformed recognized legacy log row becomes one value-free terminal SSE error frame.
 *   - The real HTTP decoder rejects legacy archive and unknown root keys before any session mutation.
 *   - Authentication runs before payload decoding; native media and schema failures retain their HTTP contracts.
 * @edge-cases
 *   - Mixed title plus legacy archive fails atomically, while nested metadata.archive remains valid.
 *   - Unsupported media is 415 text/plain; malformed JSON and invalid booleans are 400 JSON Payload errors.
 */
import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { TestConsole } from "effect/testing"
import path from "path"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionTable } from "@opencode/core/session/sql"
import { Event } from "@opencode/schema/event"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const options = {
  app: { version: "test" },
  database: { path: ":memory:" },
  fs: { filewatcher: false },
  models: { fetch: false },
}

const databaseRuntime = (databasePath: string) =>
  AppNodeBuilder.build(LayerNode.group([Database.node]), [
    Database.node.replace(Database.configured({ path: databasePath })),
  ])

const request = (handler: (request: Request) => Promise<Response>, path: string, init: RequestInit) =>
  Effect.promise(() =>
    handler(
      new Request(`http://opencode.local${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
      }),
    ),
  )

const create = (handler: (request: Request) => Promise<Response>, headers?: HeadersInit) =>
  request(handler, "/api/session", { method: "POST", headers, body: "{}" }).pipe(
    Effect.flatMap((response) => Effect.promise(() => response.json())),
    Effect.map((body) => Schema.decodeUnknownSync(SessionResponse)(body).data),
  )

const update = (
  handler: (request: Request) => Promise<Response>,
  sessionID: string,
  body: string,
  headers?: HeadersInit,
) => request(handler, `/api/session/${sessionID}`, { method: "PATCH", headers, body })

const get = (handler: (request: Request) => Promise<Response>, sessionID: string, headers?: HeadersInit) =>
  request(handler, `/api/session/${sessionID}`, { method: "GET", headers }).pipe(
    Effect.flatMap((response) => Effect.promise(() => response.json())),
    Effect.map((body) => Schema.decodeUnknownSync(SessionResponse)(body).data),
  )

const text = (response: Response) => Effect.promise(() => response.text())

it.live("accepts native archive booleans and preserves an omitted archive state through the real HTTP route", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const session = yield* create(handler)

    const omitted = yield* update(handler, session.id, "{}")
    expect(omitted.status).toBe(204)
    expect(yield* text(omitted)).toBe("")
    expect((yield* get(handler, session.id)).time.archived).toBeUndefined()

    const archived = yield* update(handler, session.id, JSON.stringify({ archived: true }))
    expect(archived.status).toBe(204)
    expect(yield* text(archived)).toBe("")
    expect((yield* get(handler, session.id)).time.archived).toBeNumber()

    const restored = yield* update(handler, session.id, JSON.stringify({ archived: false }))
    expect(restored.status).toBe(204)
    expect(yield* text(restored)).toBe("")
    expect((yield* get(handler, session.id)).time.archived).toBeUndefined()
  }).pipe(Effect.scoped),
)

it.live("maps a real archive rate refusal to the declared 429 response", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const session = yield* create(handler)
    for (const archived of [true, false, true, false, true, false]) {
      const response = yield* update(handler, session.id, JSON.stringify({ archived }))
      expect(response.status).toBe(204)
    }
    const denied = yield* update(handler, session.id, JSON.stringify({ archived: true }))
    expect(denied.status).toBe(429)
    expect(denied.headers.get("content-type")).toContain("application/json")
    expect(yield* Effect.promise(() => denied.json())).toMatchObject({
      _tag: "SessionArchiveLimitError",
      sessionID: session.id,
      kind: "rate",
      retryAfterMillis: expect.any(Number),
      message: "Archive transition rate limit exceeded",
    })
  }).pipe(Effect.scoped),
)

it.live("requires the real decoder to reject legacy and excess root fields before a mixed title update", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const session = yield* create(handler)

    const response = yield* update(handler, session.id, JSON.stringify({ title: "must-not-apply", archive: 0 }))
    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: "InvalidRequestError", kind: "Payload" })
    expect((yield* get(handler, session.id)).title).not.toBe("must-not-apply")
  }).pipe(Effect.scoped),
)

it.live("rejects invalid archived values and non-object roots while preserving the empty-object no-op", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const session = yield* create(handler)
    const before = yield* get(handler, session.id)
    const cases = [
      { body: JSON.stringify({ title: "must-not-apply", metadata: { changed: true }, archived: null }), status: 400 },
      { body: JSON.stringify({ title: "must-not-apply", metadata: { changed: true }, archived: 0 }), status: 400 },
      { body: JSON.stringify({ title: "must-not-apply", metadata: { changed: true }, archived: "true" }), status: 400 },
      { body: JSON.stringify({}), status: 204 },
      { body: JSON.stringify([]), status: 400 },
    ]

    for (const fixture of cases) {
      const response = yield* update(handler, session.id, fixture.body)
      expect(response.status).toBe(fixture.status)
      if (fixture.status === 400) {
        expect(response.headers.get("content-type")).toContain("application/json")
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "Payload",
        })
      }
      if (fixture.status === 204) expect(yield* text(response)).toBe("")
      const after = yield* get(handler, session.id)
      expect(after.title).toBe(before.title)
      expect(after.metadata).toEqual(before.metadata)
      expect(after.time.archived).toEqual(before.time.archived)
      expect(after.time.updated).toEqual(before.time.updated)
    }
  }).pipe(Effect.scoped),
)

it.live("retains native media and malformed-payload HTTP contracts without a raw handler", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const session = yield* create(handler)

    const unsupported = yield* update(handler, session.id, "archived=true", { "content-type": "text/plain" })
    expect(unsupported.status).toBe(415)
    expect(unsupported.headers.get("content-type")).toContain("text/plain")
    expect(yield* text(unsupported)).toBe("Unsupported content-type: text/plain")

    const malformed = yield* update(handler, session.id, "{", { "content-type": "application/json; charset=utf-8" })
    expect(malformed.status).toBe(400)
    expect(malformed.headers.get("content-type")).toContain("application/json")
    expect(yield* Effect.promise(() => malformed.json())).toMatchObject({
      _tag: "InvalidRequestError",
      kind: "Payload",
    })
  }).pipe(Effect.scoped),
)

it.live("authenticates before decoding malformed or legacy request bodies", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({ ...options, password: "synthetic-test-password" })
    const unauthenticated = yield* update(handler, "ses_not_routed", "{")
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get("content-type")).toContain("application/json")
    expect(yield* Effect.promise(() => unauthenticated.json())).toEqual({
      _tag: "UnauthorizedError",
      message: "Authentication required",
    })

    const authorized = { authorization: `Basic ${btoa("opencode:synthetic-test-password")}` }
    const session = yield* create(handler, authorized)
    const legacy = yield* update(handler, session.id, JSON.stringify({ archive: null }), authorized)
    expect(legacy.status).toBe(400)
    expect(legacy.headers.get("content-type")).toContain("application/json")
    expect(yield* Effect.promise(() => legacy.json())).toMatchObject({ _tag: "InvalidRequestError", kind: "Payload" })
    expect((yield* get(handler, session.id, authorized)).time.archived).toBeUndefined()
  }).pipe(Effect.scoped),
)

it.live("accepts declared metadata records containing an archive-named nested key", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)
    const session = yield* create(handler)

    const response = yield* update(handler, session.id, JSON.stringify({ metadata: { archive: { retained: true } } }))
    expect(response.status).toBe(204)
    expect((yield* get(handler, session.id)).metadata).toEqual({ archive: { retained: true } })
  }).pipe(Effect.scoped),
)

it.live(
  "returns one value-free terminal SSE error for malformed legacy logs without starting a missing-session stream",
  () =>
    tmpdirScoped("opencode-server-archive-log-").pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const filename = path.join(tmp.path, "server.sqlite")
          const sessionID = SessionID.make("ses_server_legacy_log")
          const validID = SessionID.make("ses_server_legacy_log_valid")
          const malformedID = Event.ID.make("evt_server_legacy_log_sentinel")
          const db = yield* Database.Service
          yield* db.db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
            .run()
          yield* db.db
            .insert(SessionTable)
            .values(
              [sessionID, validID].map((id) => ({
                id,
                project_id: Project.ID.global,
                directory: "/project",
                slug: String(id),
                version: "test",
                time_created: 1,
                time_updated: 1,
              })),
            )
            .run()
          yield* db.db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 0 }).run()
          yield* db.db
            .insert(EventTable)
            .values({
              id: malformedID,
              aggregate_id: sessionID,
              seq: 0,
              created: 1,
              type: "session.archive.changed.1",
              data: { sessionID: "ses_server_legacy_log_other", archived: "server-log-secret-sentinel" },
            })
            .run()
          yield* db.db.insert(EventSequenceTable).values({ aggregate_id: validID, seq: 0 }).run()
          yield* db.db
            .insert(EventTable)
            .values({
              id: Event.ID.make("evt_server_legacy_log_valid"),
              aggregate_id: validID,
              seq: 0,
              created: 2,
              type: "session.archive.changed.1",
              data: { sessionID: validID, archived: 0 },
            })
            .run()
          const before = yield* Effect.all({
            session: db.db.select().from(SessionTable).all(),
            sequence: db.db.select().from(EventSequenceTable).all(),
            rows: db.db.select().from(EventTable).all(),
          })
          const handler = yield* ServerFetch.make({ ...options, database: { path: filename } })

          const valid = yield* request(handler, `/api/experimental/session/${validID}/log?follow=false`, {
            method: "GET",
          })
          const validBody = yield* text(valid)
          expect(valid.status).toBe(200)
          expect(valid.headers.get("content-type")).toContain("text/event-stream")
          expect(validBody).toContain('"type":"session.archive.changed"')
          expect(validBody).toContain('"type":"log.synced"')

          for (const follow of [false, true]) {
            const response = yield* request(handler, `/api/experimental/session/${sessionID}/log?follow=${follow}`, {
              method: "GET",
            })
            const body = yield* text(response)
            expect(response.status).toBe(200)
            expect(response.headers.get("content-type")).toContain("text/event-stream")
            expect(body).toBe('data: {"type":"log.error","reason":"Session log unavailable"}\n\n')
            expect(body).not.toContain("server-log-secret-sentinel")
            expect(body).not.toContain(String(malformedID))
            expect(body).not.toContain(String(sessionID))
            expect(body).not.toContain("log.synced")
          }

          expect(
            yield* Effect.all({
              session: db.db.select().from(SessionTable).all(),
              sequence: db.db.select().from(EventSequenceTable).all(),
              rows: db.db.select().from(EventTable).all(),
            }),
          ).toEqual(before)
          const output = JSON.stringify([...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)])
          expect(output).not.toContain("server-log-secret-sentinel")
          expect(output).not.toContain(String(malformedID))
          expect(output).not.toContain(String(sessionID))

          const missing = yield* request(handler, "/api/experimental/session/ses_server_log_missing/log", {
            method: "GET",
          })
          expect(missing.status).toBe(404)
        }).pipe(Effect.provide(databaseRuntime(path.join(tmp.path, "server.sqlite")) as never)),
      ),
    ) as never,
)
