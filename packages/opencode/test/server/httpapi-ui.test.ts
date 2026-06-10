import { createHash } from "node:crypto"
import { describe, expect } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigProvider, Effect, Layer } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ServerAuth } from "../../src/server/auth"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { LOCAL_WEB_UI_DIR, serveEmbeddedUIEffect, serveUIEffect } from "../../src/server/shared/ui"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = {
      OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
      OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
      envPassword: process.env.OPENCODE_SERVER_PASSWORD,
      envUsername: process.env.OPENCODE_SERVER_USERNAME,
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
        Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
        restoreEnv("OPENCODE_SERVER_PASSWORD", original.envPassword)
        restoreEnv("OPENCODE_SERVER_USERNAME", original.envUsername)
      }),
    )
  }),
)

const it = testEffect(Layer.mergeAll(testStateLayer, FSUtil.defaultLayer, RuntimeFlags.layer()))

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

function app(input?: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input?.password,
            OPENCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

// Mirrors production `uiRoute` (server.ts): the static-frontend catch-all is
// served PUBLICLY — no `authorizationRouterMiddleware` layer. The frontend is a
// static bundle with no secrets and drives login itself on API 401 (RFC 017 A1).
// A `password`/`username` may still be supplied to prove that the UI is reachable
// *even when* a server password is configured.
function uiApp(input?: {
  password?: string
  username?: string
  client?: Layer.Layer<HttpClient.HttpClient>
  disableEmbeddedWebUi?: boolean
}) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, {
            fs,
            client,
            disableEmbeddedWebUi: flags.disableEmbeddedWebUi,
            localWebUi: flags.localWebUi,
            localWebUiDir: LOCAL_WEB_UI_DIR,
          }),
        )
      }),
    ).pipe(
      // No auth layer on uiRoute — public, matching production server.ts.
      Layer.provide([
        FSUtil.defaultLayer,
        input?.client ?? httpClient(new Response("ui")),
        RuntimeFlags.layer({ disableEmbeddedWebUi: input?.disableEmbeddedWebUi ?? false }),
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
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

// Mirrors production `docRoute` (server.ts): /doc is the only remaining consumer
// of `authorizationRouterMiddleware` and stays PROTECTED — bare 401 without
// credentials, 200 with valid credentials (RFC 017 A2/D2).
function docApp(input?: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      router.add("GET", "/doc", () => Effect.succeed(HttpServerResponse.text("openapi-doc"))),
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
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

function routeOrderingApp() {
  let proxiedUrl: string | undefined
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        yield* router.add("GET", "/session/:sessionID", () =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })),
        )
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, {
            fs,
            client,
            disableEmbeddedWebUi: flags.disableEmbeddedWebUi,
            localWebUi: flags.localWebUi,
            localWebUiDir: LOCAL_WEB_UI_DIR,
          }),
        )
      }),
    ).pipe(
      Layer.provide([
        FSUtil.defaultLayer,
        RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
        httpClient(new Response("ui"), (request) => {
          proxiedUrl = request.url
        }),
        HttpServer.layerServices,
      ]),
    ),
    { disableLogger: true },
  ).handler
  return {
    proxiedUrl: () => proxiedUrl,
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

function httpClient(response: Response, onRequest?: (request: HttpClientRequest.HttpClientRequest) => void) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      onRequest?.(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, response))
    }),
  )
}

function responseText(response: Response) {
  return Effect.promise(() => response.text())
}

describe("HttpApi UI fallback", () => {
  it.live("serves the web UI through the HTTP API app", () =>
    Effect.gen(function* () {
      let proxiedUrl: string | undefined

      const response = yield* uiApp({
        disableEmbeddedWebUi: true,
        client: httpClient(
          new Response("<html>opencode</html>", { headers: { "content-type": "text/html" } }),
          (request) => {
            proxiedUrl = request.url
          },
        ),
      }).request("/")

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(yield* responseText(response)).toBe("<html>opencode</html>")
      expect(proxiedUrl).toBe("https://app.opencode.ai/")
    }),
  )

  it.live("strips upstream transfer encoding headers from proxied assets", () =>
    Effect.gen(function* () {
      let proxiedUrl: string | undefined

      const response = yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        return yield* serveUIEffect(HttpServerRequest.fromWeb(new Request("http://localhost/assets/app.js")), {
          fs,
          client,
          disableEmbeddedWebUi: flags.disableEmbeddedWebUi,
          localWebUi: flags.localWebUi,
          localWebUiDir: LOCAL_WEB_UI_DIR,
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                proxiedUrl = request.url
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("console.log('ok')", {
                      headers: {
                        "content-encoding": "br",
                        "content-length": "999",
                        "content-type": "text/javascript",
                      },
                    }),
                  ),
                )
              }),
            ),
          ),
        ),
        Effect.map(HttpServerResponse.toWeb),
      )

      expect(response.status).toBe(200)
      expect(proxiedUrl).toBe("https://app.opencode.ai/assets/app.js")
      expect(response.headers.get("content-encoding")).toBeNull()
      expect(response.headers.get("content-length")).not.toBe("999")
      expect(response.headers.get("content-type")).toContain("text/javascript")
      expect(yield* responseText(response)).toBe("console.log('ok')")
    }),
  )

  // Regression for #25698 (Ope): upstream `transfer-encoding: chunked` was
  // forwarded through the proxy while the proxy itself re-frames the body,
  // causing browsers to fail with `ERR_INVALID_CHUNKED_ENCODING`.
  it.live("strips upstream transfer-encoding header from proxied assets", () =>
    Effect.gen(function* () {
      const response = yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        return yield* serveUIEffect(HttpServerRequest.fromWeb(new Request("http://localhost/")), {
          fs,
          client,
          disableEmbeddedWebUi: flags.disableEmbeddedWebUi,
          localWebUi: flags.localWebUi,
          localWebUiDir: LOCAL_WEB_UI_DIR,
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("<html>opencode</html>", {
                      headers: {
                        "transfer-encoding": "chunked",
                        "content-type": "text/html",
                      },
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
        Effect.map(HttpServerResponse.toWeb),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get("transfer-encoding")).toBeNull()
      expect(yield* responseText(response)).toBe("<html>opencode</html>")
    }),
  )

  it.live("serves embedded UI assets when Bun can read them but access reports missing", () =>
    Effect.gen(function* () {
      let readPath: string | undefined

      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedUIEffect(
        "/assets/app.js",
        {
          ...fs,
          existsSafe: () => Effect.die("embedded UI should not rely on filesystem access checks"),
          readFile: (path) => {
            readPath = path
            return path === "/$bunfs/root/assets/app.js"
              ? Effect.succeed(new TextEncoder().encode("console.log('embedded')"))
              : Effect.die(`unexpected embedded UI path: ${path}`)
          },
        },
        { "assets/app.js": "/$bunfs/root/assets/app.js" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(200)
      expect(readPath).toBe("/$bunfs/root/assets/app.js")
      expect(response.headers.get("content-type")).toContain("text/javascript")
      expect(yield* responseText(response)).toBe("console.log('embedded')")
    }),
  )

  it.live("allows embedded UI terminal wasm and theme preload CSP", () =>
    Effect.gen(function* () {
      const script = 'document.documentElement.dataset.theme = "dark"'

      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedUIEffect(
        "/",
        {
          ...fs,
          readFile: (path) => {
            return path === "/$bunfs/root/index.html"
              ? Effect.succeed(
                  new TextEncoder().encode(
                    `<html><head><script id="oc-theme-preload-script">${script}</script></head></html>`,
                  ),
                )
              : Effect.die(`unexpected embedded UI path: ${path}`)
          },
        },
        { "index.html": "/$bunfs/root/index.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      const csp = response.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
      expect(csp).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`)
      expect(csp).toContain("connect-src * data:")
    }),
  )

  it.live("keeps matched API routes ahead of the UI fallback", () =>
    Effect.gen(function* () {
      const server = routeOrderingApp()
      const response = yield* server.request("/session/ses_nope")

      expect(response.status).toBe(404)
      expect(server.proxiedUrl()).toBeUndefined()
    }),
  )

  // RFC 017 A1/D1: uiRoute is now PUBLIC. GET / with a server password set must
  // serve the UI shell (200), not 401 — the static bundle has no secrets and the
  // frontend drives login on API 401.
  it.live("serves the web UI publicly even when a server password is set", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({
        password: "secret",
        username: "opencode",
        disableEmbeddedWebUi: true,
      }).request("/")

      expect(response.status).toBe(200)
      // No native-dialog trigger: the public UI never emits www-authenticate.
      expect(response.headers.get("www-authenticate")).toBeNull()
    }),
  )

  // RFC 017 A1/D1: static assets are served by the public uiRoute and must not
  // 401 even with a password configured (the /login page can load its own JS).
  it.live("serves static UI assets publicly even when a server password is set", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({
        password: "secret",
        username: "opencode",
        disableEmbeddedWebUi: true,
        client: httpClient(new Response("console.log('ok')", { headers: { "content-type": "text/javascript" } })),
      }).request("/assets/app.js")

      expect(response.status).not.toBe(401)
      expect(response.headers.get("www-authenticate")).toBeNull()
    }),
  )

  // The public uiRoute ignores credentials entirely: an `auth_token` query param
  // (or a Basic header) neither grants nor gates access — the UI is served
  // regardless. This guards against a regression that re-introduces credential
  // gating on the static frontend.
  it.live("serves the web UI regardless of supplied credentials", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({
        password: "secret",
        username: "opencode",
        disableEmbeddedWebUi: true,
        client: httpClient(new Response("<html>opencode</html>", { headers: { "content-type": "text/html" } })),
      }).request(`/?auth_token=${btoa("opencode:secret")}`)

      expect(response.status).toBe(200)
      expect(yield* responseText(response)).toBe("<html>opencode</html>")
    }),
  )

  // Regression for #25698 (Ope): the browser fetches the PWA manifest and its
  // icons via flows that don't carry app-managed credentials. Under the new
  // public-frontend model (RFC 017 A1) these assets are served by the public
  // uiRoute, so they are reachable even when a server password is set.
  it.live("serves the PWA manifest publicly even when a server password is set", () =>
    Effect.gen(function* () {
      for (const path of ["/site.webmanifest", "/web-app-manifest-192x192.png", "/web-app-manifest-512x512.png"]) {
        const response = yield* uiApp({
          password: "secret",
          username: "opencode",
          disableEmbeddedWebUi: true,
          client: httpClient(new Response("ok")),
        }).request(path)
        expect(response.status).not.toBe(401)
        expect(response.headers.get("www-authenticate")).toBeNull()
      }
    }),
  )

  it.live("allows web UI preflight without auth", () =>
    Effect.gen(function* () {
      const response = yield* app({ password: "secret", username: "opencode" }).request("/", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
        },
      })

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    }),
  )
})

// RFC 017 A2/D2: /doc remains the only consumer of authorizationRouterMiddleware
// and stays protected. The OpenAPI doc exposes the attack-surface map, so it must
// not be public like the static frontend.
describe("HttpApi /doc protection", () => {
  it.live("returns 401 for /doc with no credentials when a password is set", () =>
    Effect.gen(function* () {
      const response = yield* docApp({ password: "secret", username: "opencode" }).request("/doc")

      expect(response.status).toBe(401)
      // Bare 401 — the reduced middleware no longer emits www-authenticate.
      expect(response.headers.get("www-authenticate")).toBeNull()
    }),
  )

  it.live("serves /doc with valid credentials", () =>
    Effect.gen(function* () {
      const response = yield* docApp({ password: "secret", username: "opencode" }).request("/doc", {
        headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      })

      expect(response.status).toBe(200)
      expect(yield* responseText(response)).toBe("openapi-doc")
    }),
  )

  it.live("serves /doc without credentials when no password is configured", () =>
    Effect.gen(function* () {
      const response = yield* docApp().request("/doc")

      expect(response.status).toBe(200)
    }),
  )
})
