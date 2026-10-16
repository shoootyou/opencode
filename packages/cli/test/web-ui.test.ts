/**
 * @spec-handoff
 * @interface WebUi.handler(options?: { assets?: AssetMap; brotli?: BrotliMap }): RouteTransform
 * @behavior
 *   - Serves SPA destinations and static web assets publicly when the server has a password.
 *   - Sends /api, /api/*, /auth/*, and /openapi.json to the authenticated inner server before SPA fallback.
 *   - Returns a structured browser-fetch 401 without WWW-Authenticate while retaining challenges for non-browser clients.
 *   - Hashes every retained oc-*-preload-script inline body in the HTML CSP.
 *   - With OPENCODE_LOCAL_WEB_UI set and no embedded UI, serves its resolved local build root's SPA shell and assets.
 *   - Serves a local candidate only when its realpath remains within that resolved root.
 * @edge-cases
 *   - Unknown authenticated API routes are 404 responses, never index.html.
 *   - Pairing /auth/connect/:code reaches its handler rather than the SPA shell.
 *   - Missing /_assets/* files are 404 no-store, while SPA HTML remains revalidated and receives preload-script CSP hashes.
 *   - Local escaping symlinks are misses: navigations receive the SPA shell; /_assets/* receives 404 no-store.
 *   - A root symlink and candidates symlinked within its resolved root are served normally.
 */
import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import { connect } from "node:net"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { brotliCompressSync } from "node:zlib"
import { WebUi } from "../src/services/web-ui"
import { it } from "../../core/test/lib/effect"

const root = await mkdtemp(path.join(tmpdir(), "opencode-web-ui-"))
afterAll(() => rm(root, { recursive: true, force: true }))

describe("web UI", () => {
  it.live("keeps v2 web destinations public while routing protected namespaces to the inner server", () =>
    Effect.gen(function* () {
      const { ServerProcess } = yield* Effect.promise(() => import("@opencode/server/process"))
      const transform = yield* WebUi.handler({
        assets: {
          "index.html": "<html><body>connect</body></html>",
          "_assets/app.js": "console.log('connect')",
          "_assets/app.css": "body { color: black; }",
          "manifest.webmanifest": "{}",
          "icons/icon.svg": "<svg></svg>",
          "font.woff2": new Uint8Array([0, 1, 2, 255]),
          "sw.js": "service worker",
          "registerSW.js": "register service worker",
        },
      })
      const server = yield* ServerProcess.start<never, never>(
        { hostname: "127.0.0.1", port: 0, password: "secret", database: { path: ":memory:" } },
        undefined,
        transform,
      )
      const origin = HttpServer.formatAddress(server.address)
      yield* Effect.forEach(
        [
          "/",
          "/login",
          "/settings",
          "/workspace/example",
          "/_assets/app.js",
          "/_assets/app.css",
          "/icons/icon.svg",
          "/manifest.webmanifest",
          "/font.woff2",
          "/sw.js",
          "/registerSW.js",
        ],
        (pathname) =>
          Effect.gen(function* () {
            yield* Effect.forEach(["GET", "HEAD"], (method) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() => fetch(new URL(pathname, origin), { method }))
                expect(response.status).toBe(200)
                expect(response.headers.get("www-authenticate")).toBeNull()
                yield* Effect.promise(() => response.arrayBuffer())
              }),
            )
          }),
      )
      const login = yield* Effect.promise(() => fetch(new URL("/login", origin)))
      expect(yield* Effect.promise(() => login.text())).toContain("connect")
      yield* Effect.forEach(
        ["/api", "/api/info", "/api/event", "/api/missing", "/auth/missing", "/openapi.json"],
        (pathname) =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              fetch(new URL(pathname, origin), { headers: { "sec-fetch-mode": "cors" } }),
            )
            expect(response.status).toBe(401)
            expect(response.headers.get("www-authenticate")).toBeNull()
            expect(yield* Effect.promise(() => response.json())).toEqual({
              _tag: "UnauthorizedError",
              message: "Authentication required",
            })
          }),
      )
      const challenged = yield* Effect.promise(() => fetch(new URL("/api/info", origin)))
      expect(challenged.status).toBe(401)
      expect(challenged.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
      yield* Effect.promise(() => challenged.arrayBuffer())
      const response = yield* Effect.promise(() =>
        fetch(new URL("/api/info", origin), { headers: { authorization: `Basic ${btoa("opencode:secret")}` } }),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toHaveProperty("pid")

      const missingApi = yield* Effect.promise(() =>
        fetch(new URL("/api/missing", origin), { headers: { authorization: `Basic ${btoa("opencode:secret")}` } }),
      )
      expect(missingApi.status).toBe(404)
      expect(yield* Effect.promise(() => missingApi.text())).not.toContain("connect")

      const pairing = yield* Effect.promise(() =>
        fetch(new URL("/api/pair", origin), {
          method: "POST",
          headers: { authorization: `Basic ${btoa("opencode:secret")}` },
        }).then((response) => response.json() as Promise<{ code: string }>),
      )
      const redirect = yield* Effect.promise(() =>
        fetch(new URL(`/auth/connect/${pairing.code}`, origin), {
          redirect: "manual",
          headers: { accept: "text/html" },
        }),
      )
      expect(redirect.status).toBe(302)
      expect(yield* Effect.promise(() => redirect.text())).not.toContain("connect")
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(FetchHttpClient.layer)),
  )

  test("sends embedded brotli bytes as they are to browsers that accept them", async () => {
    const script = "console.log('compressed')".repeat(50)
    const html = "<html><body>compressed</body></html>"
    const brotli = { "_assets/app.js": brotliCompressSync(script), "index.html": brotliCompressSync(html) }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets: { "_assets/app.js": script, "index.html": html }, brotli })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
          const origin = HttpServer.formatAddress(http.address)
          const get = (pathname: string, encoding: string) =>
            Effect.promise(async () => {
              const response = await fetch(`${origin}${pathname}`, {
                headers: { "accept-encoding": encoding },
                decompress: false,
              })
              return { headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) }
            })

          const encoded = yield* get("/_assets/app.js", "gzip, deflate, br")
          expect(encoded.headers.get("content-encoding")).toBe("br")
          expect(encoded.headers.get("vary")).toBe("accept-encoding")
          expect(encoded.headers.get("content-type")).toContain("javascript")
          expect(encoded.body).toEqual(new Uint8Array(brotli["_assets/app.js"]))

          yield* Effect.forEach(["gzip", "br;q=0"], (encoding) =>
            Effect.gen(function* () {
              const plain = yield* get("/_assets/app.js", encoding)
              expect(plain.headers.get("content-encoding")).toBeNull()
              expect(plain.headers.get("vary")).toBe("accept-encoding")
              expect(new TextDecoder().decode(plain.body)).toBe(script)
            }),
          )

          const page = yield* get("/", "br")
          expect(page.headers.get("content-encoding")).toBeNull()
          expect(new TextDecoder().decode(page.body)).toBe(html)
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("allows every retained v2 preload script through the HTML CSP", async () => {
    const theme = "document.documentElement.dataset.theme = 'dark'"
    const viewport = "document.documentElement.style.setProperty('--viewport-height', '100px')"
    const html = `<html><head><script id="oc-theme-preload-script">${theme}</script><script id="oc-viewport-preload-script">${viewport}</script></head></html>`

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets: { "index.html": html } })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
          const response = yield* Effect.promise(() => fetch(HttpServer.formatAddress(http.address)))
          const csp = response.headers.get("content-security-policy") ?? ""
          expect(csp).toContain(`'sha256-${createHash("sha256").update(theme).digest("base64")}'`)
          expect(csp).toContain(`'sha256-${createHash("sha256").update(viewport).digest("base64")}'`)
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("falls back from API routes to assets and the SPA index", async () => {
    const index = path.join(root, "index.html")
    const asset = path.join(root, "app.js")
    await writeFile(index, "<html><body>embedded</body></html>")
    await writeFile(asset, "console.log('embedded')")
    const assets = {
      "index.html": await Bun.file(index).text(),
      "_assets/app.js": await Bun.file(asset).text(),
      "sw.js": "service worker",
      "registerSW.js": "registration",
      "font.woff2": new Uint8Array([0, 1, 2, 255]),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(
            transform(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                const pathname = new URL(request.url, "http://localhost").pathname
                if (pathname === "/api/info")
                  return HttpServerResponse.jsonUnsafe({
                    version: "test",
                    pid: 1,
                    urls: [origin],
                    paths: { tmp: "/tmp/opencode" },
                  })
                return yield* Effect.fail(
                  new HttpServerError.HttpServerError({
                    reason: new HttpServerError.RouteNotFound({ request }),
                  }),
                )
              }),
            ),
          )
          const origin = HttpServer.formatAddress(http.address)

          const status = yield* Effect.promise(() => fetch(`${origin}/api/info`))
          expect(yield* Effect.promise(() => status.json())).toEqual({
            version: "test",
            pid: 1,
            urls: [origin],
            paths: { tmp: "/tmp/opencode" },
          })

          const missing = yield* Effect.promise(() => fetch(`${origin}/api/missing`))
          expect(missing.status).toBe(404)
          expect(yield* Effect.promise(() => missing.text())).toBe("")

          yield* Effect.forEach(["/_assets/old.js", "/_assets/old.css", "/_assets/missing"], (pathname) =>
            Effect.gen(function* () {
              const missing = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
              expect(missing.status).toBe(404)
              expect(missing.headers.get("cache-control")).toBe("no-store")
              expect(yield* Effect.promise(() => missing.text())).toBe("")
            }),
          )

          const script = yield* Effect.promise(() => fetch(`${origin}/_assets/app.js`))
          expect(yield* Effect.promise(() => script.text())).toBe("console.log('embedded')")
          expect(script.headers.get("content-type")).toContain("javascript")
          expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

          const worker = yield* Effect.promise(() => fetch(`${origin}/sw.js`))
          expect(worker.headers.get("cache-control")).toBe("no-cache")

          const registration = yield* Effect.promise(() => fetch(`${origin}/registerSW.js`))
          expect(registration.headers.get("cache-control")).toBe("no-cache")

          const font = yield* Effect.promise(() => fetch(`${origin}/font.woff2`))
          expect(font.headers.get("content-type")).toBe("font/woff2")
          expect(new Uint8Array(yield* Effect.promise(() => font.arrayBuffer()))).toEqual(
            new Uint8Array([0, 1, 2, 255]),
          )

          const fallback = yield* Effect.promise(() => fetch(`${origin}/workspace/example`))
          expect(yield* Effect.promise(() => fallback.text())).toContain("embedded")
          expect(fallback.headers.get("content-security-policy")).toContain("default-src 'self'")
          expect(fallback.headers.get("content-security-policy")).toContain("connect-src * data: blob:")
          expect(fallback.headers.get("content-security-policy")).toContain("worker-src 'self' blob:")

          const dotted = yield* Effect.promise(() => fetch(`${origin}/workspace/example.js`))
          expect(dotted.status).toBe(200)
          expect(yield* Effect.promise(() => dotted.text())).toContain("embedded")

          const legacy = yield* Effect.promise(() => fetch(`${origin}/assets/missing.js`))
          expect(legacy.status).toBe(200)
          expect(yield* Effect.promise(() => legacy.text())).toContain("embedded")
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("serves a local web UI directory without exposing its protected routes or missing assets", async () => {
    const local = await mkdtemp(path.join(tmpdir(), "opencode-local-web-ui-"))
    const previous = process.env.OPENCODE_LOCAL_WEB_UI
    process.env.OPENCODE_LOCAL_WEB_UI = local
    try {
      const preload = "document.documentElement.dataset.theme = 'local'"
      await mkdir(path.join(local, "_assets"), { recursive: true })
      await writeFile(
        path.join(local, "index.html"),
        `<html><head><script id="oc-theme-preload-script">${preload}</script></head><body>local shell</body></html>`,
      )
      await writeFile(path.join(local, "_assets", "app.js"), "console.log('local asset')")
      await writeFile(path.join(local, "_assets", "%2e%2e%2fsecret.js"), "console.log('encoded traversal name')")

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transform = yield* WebUi.handler()
            const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
            yield* http.serve(
              transform(
                Effect.gen(function* () {
                  const request = yield* HttpServerRequest.HttpServerRequest
                  return yield* Effect.fail(
                    new HttpServerError.HttpServerError({ reason: new HttpServerError.RouteNotFound({ request }) }),
                  )
                }),
              ),
            )
            const origin = HttpServer.formatAddress(http.address)
            const rawGet = (pathname: string) =>
              Effect.promise(
                () =>
                  new Promise<{ status: number; body: string }>((resolve, reject) => {
                    const address = new URL(origin)
                    const socket = connect({ host: address.hostname, port: Number(address.port) })
                    const chunks: Buffer[] = []
                    socket.on("connect", () =>
                      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${address.host}\r\nConnection: close\r\n\r\n`),
                    )
                    socket.on("data", (chunk) => chunks.push(chunk))
                    socket.on("error", reject)
                    socket.on("close", () => {
                      const response = Buffer.concat(chunks).toString()
                      const [head, body = ""] = response.split("\r\n\r\n", 2)
                      resolve({ status: Number(head.match(/^HTTP\/1\.1 (\d+)/)?.[1]), body })
                    })
                  }),
              )

            const shell = yield* Effect.promise(() => fetch(`${origin}/workspace/local`))
            expect(shell.status).toBe(200)
            expect(shell.headers.get("cache-control")).toBe("no-cache")
            expect(yield* Effect.promise(() => shell.text())).toContain("local shell")
            expect(shell.headers.get("content-security-policy")).toContain(
              `'sha256-${createHash("sha256").update(preload).digest("base64")}'`,
            )

            const asset = yield* Effect.promise(() => fetch(`${origin}/_assets/app.js`))
            expect(asset.status).toBe(200)
            expect(asset.headers.get("content-type")).toContain("javascript")
            expect(yield* Effect.promise(() => asset.text())).toBe("console.log('local asset')")

            const missingAsset = yield* Effect.promise(() => fetch(`${origin}/_assets/missing.js`))
            expect(missingAsset.status).toBe(404)
            expect(missingAsset.headers.get("cache-control")).toBe("no-store")

            yield* Effect.forEach(["/_assets/../secret.js", "/_assets/%2e%2e/secret.js"], (pathname) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
                expect(response.status).toBe(404)
                expect(yield* Effect.promise(() => response.text())).not.toContain("local shell")
              }),
            )

            yield* Effect.forEach(["/_assets/%2e%2e%2fsecret.js", "/_assets/%2e%2e%5csecret.js"], (pathname) =>
              Effect.gen(function* () {
                const response = yield* rawGet(pathname)
                expect(response.status).toBe(404)
                expect(response.body).not.toContain("local shell")
              }),
            )

            yield* Effect.forEach(["/api", "/api/missing", "/auth/missing", "/openapi.json"], (pathname) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
                expect(response.status).toBe(404)
                expect(yield* Effect.promise(() => response.text())).not.toContain("local shell")
              }),
            )
          }),
        ).pipe(Effect.provide(NodeFileSystem.layer)),
      )
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_LOCAL_WEB_UI
      else process.env.OPENCODE_LOCAL_WEB_UI = previous
      await rm(local, { recursive: true, force: true })
    }
  })

  test("contains local web UI symlinks within its resolved root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "opencode-local-web-ui-"))
    const local = path.join(parent, "ui")
    const outside = path.join(parent, "ui-evil")
    const links = await mkdtemp(path.join(tmpdir(), "opencode-local-web-ui-links-"))
    const rootLink = path.join(links, "web-ui")
    const previous = process.env.OPENCODE_LOCAL_WEB_UI
    process.env.OPENCODE_LOCAL_WEB_UI = rootLink
    try {
      await mkdir(path.join(local, "_assets"), { recursive: true })
      await mkdir(path.join(outside, "directory"), { recursive: true })
      await writeFile(path.join(local, "index.html"), "<html><body>local shell</body></html>")
      await writeFile(path.join(local, "_assets", "inside.js"), "console.log('inside root')")
      await writeFile(path.join(outside, "secret.js"), "console.log('outside file secret')")
      await writeFile(path.join(outside, "directory", "secret.js"), "console.log('outside directory secret')")
      await symlink(local, rootLink)
      await symlink(path.join(local, "_assets", "inside.js"), path.join(local, "_assets", "inside-link.js"))
      await symlink(path.join(outside, "secret.js"), path.join(local, "escape-file.js"))
      await symlink(path.join(outside, "secret.js"), path.join(local, "_assets", "escape-file.js"))
      await symlink(path.join(outside, "directory"), path.join(local, "escape-directory"))
      await symlink(path.join(outside, "directory"), path.join(local, "_assets", "escape-directory"))
      // coverage backfill: a string-prefix containment check must not allow a sibling whose name shares the root prefix.
      await symlink(outside, path.join(local, "_assets", "near-miss"))

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transform = yield* WebUi.handler()
            const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
            yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
            const origin = HttpServer.formatAddress(http.address)

            const root = yield* Effect.promise(() => fetch(`${origin}/workspace/local`))
            expect(root.status).toBe(200)
            expect(yield* Effect.promise(() => root.text())).toContain("local shell")

            const inside = yield* Effect.promise(() => fetch(`${origin}/_assets/inside-link.js`))
            expect(inside.status).toBe(200)
            expect(yield* Effect.promise(() => inside.text())).toBe("console.log('inside root')")

            yield* Effect.forEach(["/escape-file.js", "/escape-directory/secret.js"], (pathname) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
                expect(response.status).toBe(200)
                expect(yield* Effect.promise(() => response.text())).toContain("local shell")
              }),
            )

            yield* Effect.forEach(
              ["/_assets/escape-file.js", "/_assets/escape-directory/secret.js", "/_assets/near-miss/secret.js"],
              (pathname) =>
                Effect.gen(function* () {
                  const response = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
                  expect(response.status).toBe(404)
                  expect(response.headers.get("cache-control")).toBe("no-store")
                  expect(yield* Effect.promise(() => response.text())).toBe("")
                }),
            )
          }),
        ).pipe(Effect.provide(NodeFileSystem.layer)),
      )
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_LOCAL_WEB_UI
      else process.env.OPENCODE_LOCAL_WEB_UI = previous
      await Promise.all([rm(parent, { recursive: true, force: true }), rm(links, { recursive: true, force: true })])
    }
  })

  test("keeps explicitly supplied embedded assets ahead of OPENCODE_LOCAL_WEB_UI", async () => {
    const local = await mkdtemp(path.join(tmpdir(), "opencode-local-web-ui-"))
    const previous = process.env.OPENCODE_LOCAL_WEB_UI
    process.env.OPENCODE_LOCAL_WEB_UI = local
    try {
      await writeFile(path.join(local, "index.html"), "<html><body>local shell</body></html>")
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transform = yield* WebUi.handler({
              assets: { "index.html": "<html><body>embedded shell</body></html>" },
            })
            const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
            yield* http.serve(transform(Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
            const response = yield* Effect.promise(() => fetch(HttpServer.formatAddress(http.address)))
            expect(response.status).toBe(200)
            expect(yield* Effect.promise(() => response.text())).toContain("embedded shell")
          }),
        ).pipe(Effect.provide(NodeFileSystem.layer)),
      )
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_LOCAL_WEB_UI
      else process.env.OPENCODE_LOCAL_WEB_UI = previous
      await rm(local, { recursive: true, force: true })
    }
  })
})
