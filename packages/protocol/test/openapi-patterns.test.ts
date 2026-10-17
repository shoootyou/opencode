/**
 * @spec-handoff
 * @interface GET /api/session/:sessionID/command: { data: Command.Info[] }
 * @behavior
 *   - Publishes a session-scoped command catalogue beside POST /api/session/:sessionID/command.
 *   - Keeps GET /api/command as the explicit, location-scoped command catalogue.
 *   - Documents the routed session identifier and session-location middleware contract in OpenAPI.
 * @edge-cases
 *   - The session-scoped route accepts no client-selected agent or permission fields.
 */
import { expect, test } from "bun:test"
import { OpenApi } from "effect/http-api"
import { ClientApi } from "../src/client.js"

test("the OpenAPI document keeps string pattern constraints from protocol schemas", () => {
  const patterns = new Set<string>()
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect)
    if (typeof value !== "object" || value === null) return
    Object.entries(value).forEach(([key, item]) => {
      if (key === "pattern" && typeof item === "string") patterns.add(item)
      collect(item)
    })
  }
  collect(OpenApi.fromApi(ClientApi))

  expect([...patterns]).toEqual(
    expect.arrayContaining([
      "^[^/#]+\\/[^#]+(?:#[^#]+)?$",
      "^[^/#]+$",
      "^[^#]+$",
      "^#[0-9a-fA-F]{6}$",
      "^[a-z0-9][a-z0-9._-]*$",
      "^[a-z][a-z0-9._-]*$",
      "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
    ]),
  )
})

test("the OpenAPI document exposes the session-aware command catalogue without replacing explicit commands", () => {
  const document = OpenApi.fromApi(ClientApi) as {
    paths?: Record<string, { get?: { operationId?: string }; post?: { operationId?: string } }>
  }

  expect(document.paths?.["/api/session/{sessionID}/command"]?.get).toMatchObject({
    operationId: "session.commands.list",
  })
  expect(document.paths?.["/api/session/{sessionID}/command"]?.post).toMatchObject({
    operationId: "session.command",
  })
  expect(document.paths?.["/api/command"]?.get).toMatchObject({ operationId: "command.list" })
})
