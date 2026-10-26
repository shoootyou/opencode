/**
 * @spec-handoff
 * @interface PATCH /api/session/:sessionID { archived?: boolean }: 204
 * @behavior
 *   - Native true archives, false restores, and omitted archived leaves state unchanged.
 *   - The real HTTP decoder rejects legacy archive and unknown root keys before any session mutation.
 *   - Authentication runs before payload decoding; native media and schema failures retain their HTTP contracts.
 * @edge-cases
 *   - Mixed title plus legacy archive fails atomically, while nested metadata.archive remains valid.
 *   - Unsupported media is 415 text/plain; malformed JSON and invalid booleans are 400 JSON Payload errors.
 */
import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const options = {
  app: { version: "test" },
  database: { path: ":memory:" },
  fs: { filewatcher: false },
  models: { fetch: false },
}

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
