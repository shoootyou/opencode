/**
 * @spec-handoff
 * @interface session.update({ sessionID: string, archived?: boolean }): Promise<void> | Effect<void, E>
 * @behavior
 *   - Promise and Effect clients encode archived:true and archived:false without client timestamps.
 *   - Promise and Effect list clients encode archived:true, archived:false, or omit archived for both.
 * @edge-cases
 *   - Omitted archived is absent from the query and request body.
 *   - Generated OpenAPI exposes archived as a boolean field and has no archive field.
 */
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { OpenCode as EffectOpenCode, Session } from "../src/effect/index"
import { OpenCode as PromiseOpenCode } from "../src/promise/index"

test("Promise generated session methods encode native archived fields and omit the both-state filter", async () => {
  const requests: Request[] = []
  const client = PromiseOpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return request.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json({ data: [], cursor: {} })
    },
  })

  await client.session.update({ sessionID: "ses_archive", archived: true })
  await client.session.update({ sessionID: "ses_archive", archived: false })
  await client.session.list()
  await client.session.list({ archived: true })
  await client.session.list({ archived: false })

  const archive = await requests[0]?.json()
  const restore = await requests[1]?.json()
  expect(archive).toEqual({ archived: true })
  expect(restore).toEqual({ archived: false })
  expect(archive).not.toHaveProperty("archive")
  expect(restore).not.toHaveProperty("archive")
  expect(new URL(requests[2]!.url).searchParams.has("archived")).toBe(false)
  expect(new URL(requests[3]!.url).searchParams.get("archived")).toBe("true")
  expect(new URL(requests[4]!.url).searchParams.get("archived")).toBe("false")
  expect(new URL(requests[3]!.url).searchParams.get("archived")).not.toBe("only")
  expect(new URL(requests[4]!.url).searchParams.get("archived")).not.toBe("only")
})

test("Effect generated session methods encode native archived fields and omit the both-state filter", async () => {
  const requests: Array<{ method: string; url: string; body?: unknown; urlParams: Record<string, string> }> = []
  const httpClient = HttpClient.make((request) => {
    const body =
      request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
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
    yield* client.session.update({ sessionID: Session.ID.make("ses_archive"), archived: true })
    yield* client.session.update({ sessionID: Session.ID.make("ses_archive"), archived: false })
    yield* client.session.list()
    yield* client.session.list({ archived: true })
    yield* client.session.list({ archived: false })
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

  expect(requests).toEqual([
    { method: "PATCH", url: "http://localhost:3000/api/session/ses_archive", urlParams: {}, body: { archived: true } },
    { method: "PATCH", url: "http://localhost:3000/api/session/ses_archive", urlParams: {}, body: { archived: false } },
    { method: "GET", url: "http://localhost:3000/api/session", urlParams: {} },
    { method: "GET", url: "http://localhost:3000/api/session", urlParams: { archived: "true" } },
    { method: "GET", url: "http://localhost:3000/api/session", urlParams: { archived: "false" } },
  ])
  expect(requests[0]?.body).not.toHaveProperty("archive")
  expect(requests[1]?.body).not.toHaveProperty("archive")
})

test("OpenAPI describes archived as boolean and excludes retired archive", async () => {
  const openapi = await Bun.file(new URL("../../protocol/openapi.json", import.meta.url)).json()
  const schema = openapi.paths["/api/session/{sessionID}"].patch.requestBody.content["application/json"].schema
  expect(schema.properties.archived).toEqual(
    expect.objectContaining({ anyOf: expect.arrayContaining([{ type: "boolean" }]) }),
  )
  expect(schema.properties).not.toHaveProperty("archive")
})
