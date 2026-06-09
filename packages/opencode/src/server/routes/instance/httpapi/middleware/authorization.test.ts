/**
 * @spec-handoff
 * @behavior
 *   - authorizationRouterMiddleware (guards /doc only): authorized passthrough →
 *     bare 401 (no 302 redirect, no www-authenticate header).
 *   - The 302 browser-redirect model and the isBrowserRequest / safeRedirectPath
 *     helpers were removed in RFC 017 (E7/E8); no server path issues a 302.
 * @note These tests drive the middleware through a tiny in-memory
 *   `HttpRouter.toWebHandler` harness (no NodeHttpServer needed). The full route
 *   tree — uiRoute public, /doc protected end-to-end — is additionally exercised
 *   in test/server/httpapi-ui.test.ts and test/server/httpapi-authorization.test.ts.
 * @see ./authorization.ts
 */

import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { ServerAuth } from "@/server/auth"
import { authorizationRouterMiddleware } from "./authorization"

// Tiny harness: a single protected route guarded by authorizationRouterMiddleware,
// mirroring how production wires it onto docRoute. No www-authenticate, no 302 —
// the reduced middleware only does authorized-passthrough → bare 401.
function guardedApp(input?: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      router.add("GET", "/guarded", () => Effect.succeed(HttpServerResponse.text("ok"))),
    ).pipe(
      Layer.provide(authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))),
      Layer.provide([
        HttpServer.layerServices,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input?.password,
            OPENCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ]),
    ),
    { disableLogger: true },
  ).handler
  return (path: string, init?: RequestInit) =>
    handler(new Request(new URL(path, "http://localhost"), init))
}

describe("authorizationRouterMiddleware", () => {
  test("unauthorized request → bare 401, no www-authenticate header", async () => {
    const response = await guardedApp({ password: "secret", username: "opencode" })("/guarded")

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBeNull()
  })

  test("never issues a 302 redirect to /login", async () => {
    const response = await guardedApp({ password: "secret", username: "opencode" })("/guarded")

    expect(response.status).not.toBe(302)
    expect(response.headers.get("location")).toBeNull()
  })

  test("authorized request → passthrough (200)", async () => {
    const response = await guardedApp({ password: "secret", username: "opencode" })("/guarded", {
      headers: { authorization: `Basic ${btoa("opencode:secret")}` },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })

  test("no password configured → passthrough without credentials (200)", async () => {
    const response = await guardedApp()("/guarded")

    expect(response.status).toBe(200)
  })

  test("auth_token query credentials are accepted", async () => {
    const response = await guardedApp({ password: "secret", username: "opencode" })(
      `/guarded?auth_token=${btoa("opencode:secret")}`,
    )

    expect(response.status).toBe(200)
  })
})
