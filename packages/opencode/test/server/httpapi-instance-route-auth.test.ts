/**
 * @spec-handoff
 * @interface uiRoute — the catch-all `GET /*` static-frontend fallback in
 *   packages/opencode/src/server/routes/instance/httpapi/server.ts (~line 193).
 * @behavior
 *   - uiRoute MUST be PUBLIC: remove the `.pipe(Layer.provide(authOnlyRouterLayer))`
 *     wrapper from the uiRoute layer so no auth router middleware gates the static
 *     bundle. (authOnlyRouterLayer stays only on docRoute.)
 *   - With OPENCODE_SERVER_PASSWORD set and NO credentials, GET /login returns
 *     status 200 with Content-Type including text/html (the SPA shell served by
 *     serveUIEffect) — NOT a bare 401.
 *   - Authenticated API routes are UNAFFECTED by the public-UI change: with a
 *     password set and no credentials they still return 401. This is already
 *     covered by the EventPaths.event assertion in the "HttpApi instance route
 *     authorization" describe below (referenced, not duplicated).
 * @edge-cases
 *   - PUBLIC_UI_PATHS (server/shared/public-ui.ts) is intentionally empty — the
 *     whole bundle is public via route wiring, not a per-path bypass.
 *   - GREEN-state determinism: the test sets OPENCODE_LOCAL_WEB_UI=true and
 *     OPENCODE_DISABLE_EMBEDDED_WEB_UI=true so the real uiRoute serves
 *     packages/app/dist/index.html offline (no network proxy to app.opencode.ai).
 *     The local web UI build must exist for the GREEN assertion. The RED state
 *     needs no UI artifact: the buggy auth layer short-circuits with 401 before
 *     serveUIEffect ever runs.
 * @see ../../src/server/routes/instance/httpapi/server.ts
 * @see ../../src/server/shared/public-ui.ts
 * @see ../../src/server/routes/instance/httpapi/middleware/authorization.ts
 */

import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

function app(input: {
  password?: string
  username?: string
  // Drive the real uiRoute toward the offline local-dist branch (app/dist) so
  // GET /* serves deterministically without a network proxy to app.opencode.ai.
  localWebUi?: boolean
  disableEmbeddedWebUi?: boolean
}) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input.password,
            OPENCODE_SERVER_USERNAME: input.username,
            OPENCODE_LOCAL_WEB_UI: input.localWebUi ? "true" : undefined,
            OPENCODE_DISABLE_EMBEDDED_WEB_UI: input.disableEmbeddedWebUi ? "true" : undefined,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler

  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function basic(username: string, password: string) {
  return ServerAuth.header({ username, password }) ?? ""
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi instance route authorization", () => {
  test("requires configured auth before opening the instance event stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const headers = { "x-opencode-directory": tmp.path }

    const missing = await server.request(EventPaths.event, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(EventPaths.event, {
      headers: { ...headers, authorization: basic("opencode", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(200)
  })

  test("requires configured auth before resolving the PTY websocket route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const route = PtyPaths.connect.replace(":ptyID", PtyID.ascending())
    const headers = { "x-opencode-directory": tmp.path }

    const missing = await server.request(route, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(route, {
      headers: { ...headers, authorization: basic("opencode", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(404)
  })
})

describe("HttpApi public UI route", () => {
  // RFC 017 A1/D1 + plan 85 E3 repair: the static-frontend catch-all (uiRoute)
  // is PUBLIC. With a server password set and NO credentials, GET /login must
  // serve the SPA shell (200, text/html), NOT a bare 401 — the bundle has no
  // secrets and the frontend drives login itself on API 401.
  //
  // This binds to the REAL production route tree (HttpApiApp.routes / server.ts).
  // The uiApp() helper in httpapi-ui.test.ts only mirrors the intended wiring and
  // therefore cannot catch a regression in server.ts's actual uiRoute layer.
  //
  // RED against current code: uiRoute is wrapped with authOnlyRouterLayer, so the
  // auth router middleware short-circuits GET /login with status 401 before
  // serveUIEffect runs. GREEN once that wrapper is removed (uiRoute made public).
  test("serves GET /login publicly (200 text/html) when a password is set and no credentials are provided", async () => {
    const server = app({ password: "secret", localWebUi: true, disableEmbeddedWebUi: true })

    const response = await server.request("/login")
    await cancelBody(response)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type") ?? "").toContain("text/html")
  })

  // Guard the other direction: the public-UI change must NOT make authenticated
  // API routes public. With a password set and no credentials, an API route still
  // returns 401 — already asserted by the "requires configured auth before opening
  // the instance event stream" test above (EventPaths.event → 401). Referenced
  // here rather than duplicated.
})
