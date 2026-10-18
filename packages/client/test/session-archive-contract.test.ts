/**
 * @spec-handoff
 * @interface session.update({ sessionID: string, archive?: number | null }): Promise<void> | Effect<void, E>
 * @behavior
 *   - Promise and Effect clients encode archive: 0 and archive: null exactly.
 *   - Promise and Effect list clients encode archived: true, false, and "only", omitting undefined.
 * @edge-cases
 *   - archive: null is accepted by generated TypeScript inputs without a cast.
 *   - Generated OpenAPI declares archive nullable after S4 generation.
 */
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { OpenCode as EffectOpenCode, Session } from "../src/effect/index"
import { OpenCode as PromiseOpenCode } from "../src/promise/index"

test("Promise generated session methods encode archive and archived fields", async () => {
  const requests: Request[] = []
  const client = PromiseOpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return request.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json({ data: [], cursor: {} })
    },
  })

  await client.session.update({ sessionID: "ses_archive", archive: 0 })
  await client.session.update({ sessionID: "ses_archive", archive: null })
  await client.session.list({ archived: true })
  await client.session.list({ archived: false })
  await client.session.list({ archived: "only" })

  expect(await requests[0]?.json()).toEqual({ archive: 0 })
  expect(await requests[1]?.json()).toEqual({ archive: null })
  expect(new URL(requests[2]!.url).searchParams.get("archived")).toBe("true")
  expect(new URL(requests[3]!.url).searchParams.get("archived")).toBe("false")
  expect(new URL(requests[4]!.url).searchParams.get("archived")).toBe("only")
})

test("Effect generated session methods encode archive and archived fields", async () => {
  const requests: Array<{ method: string; url: string; body?: unknown; urlParams: Record<string, string> }> = []
  const httpClient = HttpClient.make((request) => {
    const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
    const urlParams = Object.fromEntries(request.urlParams.params)
    requests.push({
      method: request.method,
      url: request.url,
      urlParams,
      ...(body === undefined ? {} : { body }),
    })
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json({ data: [], cursor: {} }),
      ),
    )
  })

  await Effect.gen(function* () {
    const client = yield* EffectOpenCode.make({ baseUrl: "http://localhost:3000" })
    yield* client.session.update({ sessionID: Session.ID.make("ses_archive"), archive: 0 })
    yield* client.session.update({ sessionID: Session.ID.make("ses_archive"), archive: null })
    yield* client.session.list()
    yield* client.session.list({ archived: true })
    yield* client.session.list({ archived: false })
    yield* client.session.list({ archived: "only" })
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(requests).toEqual([
    { method: "PATCH", url: "http://localhost:3000/api/session/ses_archive", urlParams: {}, body: { archive: 0 } },
    { method: "PATCH", url: "http://localhost:3000/api/session/ses_archive", urlParams: {}, body: { archive: null } },
    { method: "GET", url: "http://localhost:3000/api/session", urlParams: {} },
    { method: "GET", url: "http://localhost:3000/api/session", urlParams: { archived: "true" } },
    { method: "GET", url: "http://localhost:3000/api/session", urlParams: { archived: "false" } },
    { method: "GET", url: "http://localhost:3000/api/session", urlParams: { archived: "only" } },
  ])
})

test("OpenAPI describes archive as number or null", async () => {
  const openapi = await Bun.file(new URL("../../protocol/openapi.json", import.meta.url)).json()
  const schema = openapi.paths["/api/session/{sessionID}"].patch.requestBody.content["application/json"].schema
  expect(schema.properties.archive).toEqual(
    expect.objectContaining({
      anyOf: expect.arrayContaining([expect.objectContaining({ anyOf: [{ type: "number" }, { type: "null" }] }), { type: "null" }]),
    }),
  )
})
