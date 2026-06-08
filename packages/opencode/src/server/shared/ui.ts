import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Stream } from "effect"
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { createHash } from "node:crypto"
import path from "path"
import { ProxyUtil } from "../proxy-util"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

// Anchored to ui.ts's own location: from packages/opencode/src/server/shared/
// up four levels reaches packages/, then app/dist. Computed here (not at the
// call site) so import.meta.dirname always resolves relative to this file.
export const LOCAL_WEB_UI_DIR = path.resolve(import.meta.dirname, "../../../../app/dist")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: {
    fs: FSUtil.Interface
    client: HttpClient.HttpClient
    disableEmbeddedWebUi: boolean
    localWebUi: boolean
    localWebUiDir: string
  },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const requestPath = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(requestPath, services.fs, embeddedWebUI)

    // Serving order: embed > localWebUi > proxy. Production binaries embed the
    // UI and never reach here; the local-dist branch is dev-only opt-in. The
    // local response is an HttpClientResponse (same shape as the proxy
    // response below), so it flows through the same conversion to an
    // HttpServerResponse.
    const response = services.localWebUi
      ? yield* serveLocalUIEffect(requestPath, services.fs, services.localWebUiDir)
      : yield* services.client.execute(
          HttpClientRequest.make(request.method)(upstreamURL(requestPath), {
            headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
            body: requestBody(request),
          }),
        )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}

// Pure resolver: maps a request path to an absolute file inside distDir, with
// SPA fallback and traversal protection. Returns null only when the resolved
// path escapes distDir (e.g. via "..") so the caller can reject it.
export function resolveLocalUIFile(requestPath: string, distDir: string): string | null {
  const stripped = requestPath.replace(/^\//, "")
  // Traversal guard runs first so escaping paths are rejected even when they
  // have no extension (e.g. "/../../../etc/passwd"): resolve against distDir
  // and require the result to stay inside it.
  const resolved = path.resolve(distDir, stripped)
  const relative = path.relative(distDir, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null

  // SPA fallback: a path is a static file only when its last segment has an
  // extension (a dot). Root and extension-less routes serve index.html so the
  // in-page router can handle them.
  const lastSegment = stripped.split("/").pop() ?? ""
  if (!lastSegment.includes(".")) return path.join(distDir, "index.html")
  return resolved
}

// Serves a file from the local app/dist build as an HttpClientResponse (the
// same shape the proxy branch yields), so serveUIEffect can treat both
// uniformly. Traversal attempts and missing files fall back to index.html so
// the SPA router can take over.
export function serveLocalUIEffect(requestPath: string, fs: FSUtil.Interface, distDir: string) {
  const indexHtml = path.join(distDir, "index.html")
  const resolved = resolveLocalUIFile(requestPath, distDir) ?? indexHtml

  return fs.readFile(resolved).pipe(
    Effect.map((body) => localUIResponse(resolved, body)),
    Effect.catchReason("PlatformError", "NotFound", () =>
      fs.readFile(indexHtml).pipe(Effect.map((body) => localUIResponse(indexHtml, body))),
    ),
  )
}

function localUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  // fromWeb adapts a web Response into an HttpClientResponse, exposing the
  // record-style `headers` and the `text`/`status` body readers the route and
  // tests consume. The request argument is only metadata for the adapter.
  return HttpClientResponse.fromWeb(
    HttpClientRequest.make("GET")(file),
    new Response(body as BodyInit, { status: 200, headers }),
  )
}
