/**
 * @spec-handoff
 * @interface authorizationLayer: Layer.Layer<Authorization, ConfigError, ServerAuth.Config>
 * @behavior
 *   - Accepts valid Basic credentials and same-origin signed session cookies.
 *   - Rejects invalid credentials before protected handlers; browser fetches receive
 *     structured 401 without a challenge or redirect, other clients receive Basic challenge.
 *   - Bypasses only exact pairing, PTY, and persistent-PTY ticket routes.
 * @edge-cases
 *   - Expired, tampered, rotated, and cross-origin session cookies are denied.
 *   - Empty/malformed Basic or auth-token input and bypass-path near-misses are denied.
 * @see ./authorization.ts
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { ServerAuth } from "../auth"
import { Authorization, authorizationLayer } from "./authorization"

// Mirrors the real shape of packages/protocol/src/groups/pty.ts's "pty.connect"
// endpoint, the only production route this layer's PTY-ticket bypass targets.
const GuardedApi = HttpApi.make("test-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", { success: Schema.String }),
      HttpApiEndpoint.get("ptyConnect", "/api/pty/:ptyID/connect", { success: Schema.String }),
      HttpApiEndpoint.get("unprefixedPtyConnect", "/pty/:ptyID/connect", { success: Schema.String }),
      HttpApiEndpoint.get("persistentPtyConnect", "/api/experimental/persistent-pty/:ptyID/connect", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("persistentPtyNearMiss", "/api/experimental/persistent-pty/:ptyID/connect-token", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("pairingConnect", "/auth/connect/:code", { success: Schema.String }),
      HttpApiEndpoint.get("pairingNearMiss", "/auth/connect/:code/extra", { success: Schema.String }),
    )
    .middleware(Authorization),
)

const secretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret") })
const noAuthLayer = ServerAuth.Config.configLayer({ password: Option.none() })

function guardedApp(configLayer: typeof secretLayer) {
  const calls = { probe: 0, pty: 0, persistentPty: 0, pairing: 0 }
  const guardedHandlers = HttpApiBuilder.group(GuardedApi, "test", (handlers) =>
    handlers
      .handle("probe", () => Effect.sync(() => (calls.probe++, "ok")))
      .handle("ptyConnect", () => Effect.sync(() => (calls.pty++, "connected")))
      .handle("unprefixedPtyConnect", () => Effect.sync(() => (calls.pty++, "connected")))
      .handle("persistentPtyConnect", () => Effect.sync(() => (calls.persistentPty++, "connected")))
      .handle("persistentPtyNearMiss", () => Effect.sync(() => (calls.persistentPty++, "connected")))
      .handle("pairingConnect", () => Effect.sync(() => (calls.pairing++, "paired")))
      .handle("pairingNearMiss", () => Effect.sync(() => (calls.pairing++, "paired"))),
  )
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(GuardedApi).pipe(
      Layer.provide(guardedHandlers),
      Layer.provide(authorizationLayer),
      Layer.provide(configLayer),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  ).handler
  return {
    request: (path: string, init?: RequestInit) => handler(new Request(new URL(path, "http://localhost:4096"), init)),
    calls,
  }
}

describe("authorizationLayer (packages/server, base layer)", () => {
  test("browser fetch rejection is structured 401 without Basic challenge, redirect, secret, or handler call", async () => {
    const app = guardedApp(secretLayer)
    const response = await app.request("/probe", { headers: { "sec-fetch-mode": "cors" } })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" })
    expect(response.headers.get("www-authenticate")).toBeNull()
    expect(response.headers.get("location")).toBeNull()
    expect(app.calls.probe).toBe(0)
  })

  test("non-browser and navigation rejections include the Basic challenge without redirect", async () => {
    const app = guardedApp(secretLayer)
    const [nonBrowser, navigation] = await Promise.all([
      app.request("/probe"),
      app.request("/probe", { headers: { "sec-fetch-mode": "navigate" } }),
    ])

    for (const response of [nonBrowser, navigation]) {
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
      expect(response.headers.get("location")).toBeNull()
    }
    expect(app.calls.probe).toBe(0)
  })

  test("no password configured → passthrough without credentials", async () => {
    const app = guardedApp(noAuthLayer)
    const response = await app.request("/probe")

    expect(response.status).toBe(200)
    expect(app.calls.probe).toBe(1)
  })

  test("valid direct password, auth_token, and same-origin signed session → protected handler", async () => {
    const app = guardedApp(secretLayer)
    const token = ServerAuth.issueSession({ password: Option.some("secret"), username: "opencode" })
    if (!token) throw new Error("Expected signed session")
    const [password, authToken, session] = await Promise.all([
      app.request("/probe", {
        headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      }),
      app.request(`/probe?auth_token=${btoa("opencode:secret")}`, {
        headers: { "sec-fetch-mode": "cors" },
      }),
      app.request("/probe", {
        headers: {
          cookie: `opencode_session_4096=${token}`,
          host: "localhost:4096",
          origin: "http://localhost:4096",
        },
      }),
    ])

    expect(password.status).toBe(200)
    expect(authToken.status).toBe(200)
    expect(session.status).toBe(200)
    expect(app.calls.probe).toBe(3)
  })

  test("wrong or malformed Basic/auth-token credentials fail closed before handler without reflecting secrets", async () => {
    const app = guardedApp(secretLayer)
    const secret = "secret"
    const responses = await Promise.all([
      app.request("/probe", { headers: { "sec-fetch-mode": "cors", authorization: `Basic ${btoa("opencode:wrong")}` } }),
      app.request("/probe", { headers: { "sec-fetch-mode": "cors", authorization: `Basic ${btoa("other:secret")}` } }),
      app.request("/probe", { headers: { "sec-fetch-mode": "cors", authorization: "Basic " } }),
      app.request("/probe", { headers: { "sec-fetch-mode": "cors", authorization: "Basic !!!not-base64!!!" } }),
      app.request("/probe?auth_token=", { headers: { "sec-fetch-mode": "cors" } }),
      app.request("/probe?auth_token=not-base64", { headers: { "sec-fetch-mode": "cors" } }),
      app.request("/probe?auth_token=Zm9ybWF0d2l0aG91dGNvbG9u", { headers: { "sec-fetch-mode": "cors" } }),
    ])

    expect(app.calls.probe).toBe(0)
    for (const response of responses) {
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBeNull()
      expect(await response.text()).not.toContain(secret)
    }
  })

  test("expired, tampered, rotated, and cross-origin session cookies fail closed before handler", async () => {
    const app = guardedApp(secretLayer)
    const token = ServerAuth.issueSession({ password: Option.some("secret"), username: "opencode" })
    if (!token) throw new Error("Expected signed session")
    const expired = ServerAuth.issueSession({ password: Option.some("secret"), username: "opencode" }, 0)
    if (!expired) throw new Error("Expected expired signed session")
    const rotated = guardedApp(ServerAuth.Config.configLayer({ password: Option.some("rotated") }))
    const responses = await Promise.all([
      app.request("/probe", { headers: { "sec-fetch-mode": "cors", cookie: `opencode_session=${expired}` } }),
      app.request("/probe", { headers: { "sec-fetch-mode": "cors", cookie: `opencode_session=${token}x` } }),
      app.request("/probe", {
        headers: { "sec-fetch-mode": "cors", cookie: `opencode_session=${token}`, origin: "http://evil.example" },
      }),
      rotated.request("/probe", { headers: { "sec-fetch-mode": "cors", cookie: `opencode_session=${token}` } }),
    ])

    expect(app.calls.probe).toBe(0)
    expect(rotated.calls.probe).toBe(0)
    for (const response of responses) {
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain(token)
    }
  })
})

describe("authorizationLayer — PTY connect ticket bypass (hasPtyConnectTicketURL)", () => {
  test("valid ticket on the real mounted shape (/api/pty/:id/connect) → passthrough, no credentials needed", async () => {
    const app = guardedApp(secretLayer)
    const response = await app.request("/api/pty/abc123/connect?ticket=some-ticket")

    expect(response.status).toBe(200)
    expect(await response.json()).toBe("connected")
    expect(app.calls.pty).toBe(1)
  })

  test("pairing, PTY, and persistent-PTY bypass only exact legitimate paths", async () => {
    const app = guardedApp(secretLayer)
    const [pairing, pty, persistentPty, missingTicket, unprefixed, persistentNearMiss, pairingNearMiss] = await Promise.all([
      app.request("/auth/connect/code"),
      app.request("/api/pty/abc/connect?ticket=ticket"),
      app.request("/api/experimental/persistent-pty/abc/connect?ticket=ticket"),
      app.request("/api/pty/abc/connect", { headers: { "sec-fetch-mode": "cors" } }),
      app.request("/pty/abc/connect?ticket=ticket", { headers: { "sec-fetch-mode": "cors" } }),
      app.request("/api/experimental/persistent-pty/abc/connect-token?ticket=ticket", { headers: { "sec-fetch-mode": "cors" } }),
      app.request("/auth/connect/code/extra", { headers: { "sec-fetch-mode": "cors" } }),
    ])

    for (const response of [pairing, pty, persistentPty]) expect(response.status).toBe(200)
    for (const response of [missingTicket, unprefixed, persistentNearMiss, pairingNearMiss]) expect(response.status).toBe(401)
    expect(app.calls).toEqual({ probe: 0, pty: 1, persistentPty: 1, pairing: 1 })
  })
})
