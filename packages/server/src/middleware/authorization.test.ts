/**
 * @spec-handoff
 * @interface authorizationLayer: Layer.Layer<Authorization, ConfigError, ServerAuth.Config>
 * @behavior
 *   - Unauthenticated/unauthorized request with auth required → bare 401
 *     (UnauthorizedError body), NEVER a `www-authenticate` header.
 *   - authorizationLayer never issues a 302 redirect under any credential
 *     state (missing, wrong, or ticketed).
 *   - `hasPtyConnectTicketURL` (from `@opencode-ai/protocol/groups/pty`, regex
 *     anchored to `/api/pty/:id/connect`) bypasses credential checks when the
 *     ticket query param is present. This layer only ever guards routes
 *     mounted under `@opencode-ai/protocol`'s `Api` (see packages/server/src/api.ts,
 *     packages/protocol/src/groups/pty.ts), which are declared at `/api/pty/...`
 *     — so the `/api` prefix in the regex is the correct assumption for THIS
 *     layer's real mounted paths (contrast with the fork's own unprefixed
 *     `/pty/:id/connect` instance route, guarded by a separate
 *     ptyConnectAuthorizationLayer in packages/opencode, not this file).
 * @edge-cases
 *   - No password configured → passthrough without any credential check.
 *   - Ticket present on the exact `/api/pty/:id/connect` shape → passthrough,
 *     no credential check, regardless of Basic-Auth state.
 *   - Ticket present on a path that does NOT match the fork's real mounted
 *     PTY-connect shape (e.g. missing `/api` prefix) → NOT bypassed, still 401
 *     without credentials. This is the sanity check for the regex-prefix risk
 *     flagged by Taku: a wrong/missing prefix would make this assertion fail
 *     (the request would incorrectly bypass and return 200).
 * @see ./authorization.ts
 * @see ../../protocol/src/groups/pty.ts (hasPtyConnectTicketURL, PTY_CONNECT_TICKET_QUERY)
 * @see ../../../opencode/src/server/routes/instance/httpapi/middleware/authorization.ts (fork's
 *   ptyConnectAuthorizationLayer, a SEPARATE middleware guarding the fork's own unprefixed
 *   `/pty/:id/connect` instance route — NOT exercised by this file's tests, which only cover
 *   this package's own `authorizationLayer`/`hasPtyConnectTicketURL` regex-prefix assumption).
 * @see ../../../opencode/test/server/httpapi-instance-route-auth.test.ts (real ticket-bypass
 *   coverage for ptyConnectAuthorizationLayer against the production `/pty/:id/connect` route —
 *   corrected citation: the `middleware/authorization.test.ts` file in packages/opencode only
 *   covers `authorizationRouterMiddleware` (the `/doc` guard), never ptyConnectAuthorizationLayer;
 *   Sho r1 flagged the prior version of this citation as implying coverage that did not exist)
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../auth"
import { Authorization, authorizationLayer } from "./authorization"

// Mirrors the real shape of packages/protocol/src/groups/pty.ts's "pty.connect"
// endpoint, the only production route this layer's PTY-ticket bypass targets.
const GuardedApi = HttpApi.make("test-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", { success: Schema.String }),
      HttpApiEndpoint.get("ptyConnect", "/api/pty/:ptyID/connect", { success: Schema.String }),
      // Deliberately missing the "/api" prefix — exercises the regex-prefix
      // sanity check. This path is never actually mounted in production; it
      // exists here only to prove the bypass does NOT match on path shape
      // alone (see @edge-cases above).
      HttpApiEndpoint.get("unprefixedPtyConnect", "/pty/:ptyID/connect", { success: Schema.String }),
    )
    .middleware(Authorization),
)

const guardedHandlers = HttpApiBuilder.group(GuardedApi, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("ptyConnect", () => Effect.succeed("connected"))
    .handle("unprefixedPtyConnect", () => Effect.succeed("connected")),
)

const secretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "opencode" })
const noAuthLayer = ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })

function guardedApp(configLayer: typeof secretLayer) {
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(GuardedApi).pipe(
      Layer.provide(guardedHandlers),
      Layer.provide(authorizationLayer),
      Layer.provide(configLayer),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  ).handler
  return (path: string, init?: RequestInit) => handler(new Request(new URL(path, "http://localhost"), init))
}

describe("authorizationLayer (packages/server, base layer)", () => {
  test("unauthorized request → bare 401, no www-authenticate header", async () => {
    const response = await guardedApp(secretLayer)("/probe")

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBeNull()
  })

  test("authorizationLayer never issues a 302 redirect", async () => {
    const app = guardedApp(secretLayer)
    const [missing, badCredentials, ticketedWrongShape] = await Promise.all([
      app("/probe"),
      app("/probe", { headers: { authorization: `Basic ${btoa("opencode:wrong")}` } }),
      app("/pty/abc/connect?ticket=whatever"),
    ])

    for (const response of [missing, badCredentials, ticketedWrongShape]) {
      expect(response.status).not.toBe(302)
      expect(response.headers.get("location")).toBeNull()
    }
  })

  test("no password configured → passthrough without credentials", async () => {
    const response = await guardedApp(noAuthLayer)("/probe")

    expect(response.status).toBe(200)
  })

  test("valid basic auth credentials → passthrough", async () => {
    const response = await guardedApp(secretLayer)("/probe", {
      headers: { authorization: `Basic ${btoa("opencode:secret")}` },
    })

    expect(response.status).toBe(200)
  })
})

describe("authorizationLayer — PTY connect ticket bypass (hasPtyConnectTicketURL)", () => {
  test("valid ticket on the real mounted shape (/api/pty/:id/connect) → passthrough, no credentials needed", async () => {
    const response = await guardedApp(secretLayer)("/api/pty/abc123/connect?ticket=some-ticket")

    expect(response.status).toBe(200)
    expect(await response.json()).toBe("connected")
  })

  test("missing ticket on the real mounted shape → still bare 401", async () => {
    const response = await guardedApp(secretLayer)("/api/pty/abc123/connect")

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBeNull()
  })

  // Sanity check for the regex-prefix risk (Taku, spec-reconciliation.md Point 2):
  // if hasPtyConnectTicketURL's regex ever lost its "/api" prefix — or if this
  // layer were wired to guard a route tree that does NOT mount PTY connect
  // under "/api/pty" — a ticket on the unprefixed shape would ALSO bypass,
  // and this assertion would flip to 200, catching the regression.
  test("ticket present but path does not match the real /api/pty/:id/connect shape → NOT bypassed", async () => {
    const response = await guardedApp(secretLayer)("/pty/abc123/connect?ticket=some-ticket")

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBeNull()
  })
})
