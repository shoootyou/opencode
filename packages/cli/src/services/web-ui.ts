import { FSUtil } from "@opencode/util/fs-util"
import { Effect, FileSystem, Option } from "effect"
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { load, type AssetMap, type BrotliMap } from "../app-assets"

export const handler = Effect.fn("cli.web-ui.handler")(function* (options?: {
  readonly assets?: AssetMap
  readonly brotli?: BrotliMap
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const assets = options?.assets
    ? Effect.succeed(Option.some({ files: options.assets, brotli: options.brotli }))
    : yield* Effect.cached(load().pipe(Effect.provideService(FileSystem.FileSystem, fileSystem), Effect.option))
  const localRoot = !options?.assets && process.env.OPENCODE_LOCAL_WEB_UI
    ? yield* Effect.promise(() => resolveLocalRoot(process.env.OPENCODE_LOCAL_WEB_UI)).pipe(Effect.option)
    : Option.none()
  return <E, R>(api: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      // Serve the web shell before API authentication so a signed-out browser gets the app's sign-in screen.
      if (
        url.pathname === "/api" ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/auth/") ||
        url.pathname === "/openapi.json"
      )
        return yield* api.pipe(
          Effect.catchIf(isRouteNotFound, () => Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
        )
      if (options?.assets)
        return yield* assets.pipe(
          Effect.flatMap((loaded) => {
            if (Option.isSome(loaded)) return serveUI(request, url, loaded.value.files, loaded.value.brotli)
            return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
          }),
        )
      if (Option.isSome(localRoot)) return yield* serveLocalUI(request, url, localRoot.value)
      return yield* assets.pipe(
        Effect.flatMap((loaded) => {
          if (Option.isSome(loaded)) return serveUI(request, url, loaded.value.files, loaded.value.brotli)
          return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
        }),
      )
    })
})

function serveUI(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  assets: AssetMap,
  brotli: BrotliMap | undefined,
) {
  const key = url.pathname.replace(/^\//, "")
  // A browser that takes brotli gets the embedded bytes as they are, so the server decompresses nothing. The HTML stays
  // decoded, because its CSP hashes the inline theme script.
  const encoded = key !== "index.html" && acceptsBrotli(request.headers["accept-encoding"]) ? brotli?.[key] : undefined
  const requested = encoded ?? assets[key]
  if ((key.startsWith("_assets/") || key.startsWith("icons/")) && requested === undefined)
    return Effect.succeed(HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } }))
  const name = requested !== undefined ? key : "index.html"
  const file = requested ?? assets["index.html"]
  if (file === undefined) return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
  if (request.method !== "GET" && request.method !== "HEAD")
    return Effect.succeed(HttpServerResponse.empty({ status: 405 }))
  const html = name === "index.html"
  const revalidate = html || name === "sw.js" || name === "registerSW.js"
  const headers = {
    "content-type": FSUtil.mimeType(name),
    "cache-control": revalidate ? "no-cache" : "public, max-age=31536000, immutable",
    "content-security-policy": html
      ? cspForHtml(typeof file === "string" ? file : Buffer.from(file).toString())
      : csp(),
    "x-content-type-options": "nosniff",
    ...(!html && brotli?.[name] !== undefined ? { vary: "accept-encoding" } : {}),
    ...(encoded ? { "content-encoding": "br" } : {}),
  }
  return Effect.succeed(
    request.method === "HEAD"
      ? HttpServerResponse.empty({ status: 200, headers })
      : HttpServerResponse.raw(file, { headers, contentType: headers["content-type"] }),
  )
}

async function resolveLocalRoot(root: string | undefined) {
  if (!root) throw new Error("OPENCODE_LOCAL_WEB_UI is unset")
  return realpath(root)
}

function serveLocalUI(request: HttpServerRequest.HttpServerRequest, url: URL, root: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return Effect.succeed(HttpServerResponse.empty({ status: 405 }))
  const rawPath = request.url.split("?", 1)[0] ?? ""
  const assets = url.pathname.startsWith("/_assets/") || url.pathname.startsWith("/icons/")
  if (hasTraversal(rawPath) || (url.pathname.startsWith("/_assets/") && rawPath.includes("..")))
    return assets ? localAssetNotFound() : serveLocalIndex(request, root)
  const candidate = localCandidate(url.pathname, root)
  if (!candidate) return assets ? localAssetNotFound() : serveLocalIndex(request, root)
  return Effect.tryPromise(() => realpath(candidate)).pipe(
    Effect.flatMap((resolved) => {
      if (!isWithinRoot(resolved, root)) return assets ? localAssetNotFound() : serveLocalIndex(request, root)
      return serveLocalFile(request, resolved)
    }),
    Effect.catch(() => (assets || isStaticPath(url.pathname) ? localAssetNotFound() : serveLocalIndex(request, root))),
  )
}

function localCandidate(pathname: string, root: string) {
  const relative = pathname.replace(/^\//, "")
  const candidate = path.resolve(root, relative)
  if (!isWithinRoot(candidate, root)) return
  return isStaticPath(pathname) ? candidate : path.join(root, "index.html")
}

function isStaticPath(pathname: string) {
  return (pathname.split("/").at(-1) ?? "").includes(".")
}

function hasTraversal(pathname: string) {
  return pathname.split("/").some((segment) => segment === ".." || /%2e/i.test(segment))
}

function isWithinRoot(candidate: string, root: string) {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function serveLocalIndex(request: HttpServerRequest.HttpServerRequest, root: string) {
  return Effect.tryPromise(() => realpath(path.join(root, "index.html"))).pipe(
    Effect.flatMap((index) =>
      isWithinRoot(index, root) ? serveLocalFile(request, index) : Effect.succeed(HttpServerResponse.empty({ status: 404 })),
    ),
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
  )
}

function serveLocalFile(request: HttpServerRequest.HttpServerRequest, file: string) {
  return Effect.tryPromise(() => readFile(file)).pipe(
    Effect.map((body) => {
      const html = path.basename(file) === "index.html"
      const headers = {
        "content-type": FSUtil.mimeType(file),
        "cache-control": html || path.basename(file) === "sw.js" || path.basename(file) === "registerSW.js" ? "no-cache" : "public, max-age=31536000, immutable",
        "content-security-policy": html ? cspForHtml(body.toString()) : csp(),
        "x-content-type-options": "nosniff",
      }
      return request.method === "HEAD"
        ? HttpServerResponse.empty({ status: 200, headers })
        : HttpServerResponse.raw(body, { headers, contentType: headers["content-type"] })
    }),
  )
}

function localAssetNotFound() {
  return Effect.succeed(HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } }))
}

function acceptsBrotli(header: string | undefined) {
  return (header ?? "").split(",").some((entry) => {
    const parts = entry.split(";").map((part) => part.trim().toLowerCase())
    return parts[0] === "br" && !parts.slice(1).some((part) => /^q=0(?:\.0*)?$/.test(part))
  })
}

function isRouteNotFound(error: unknown) {
  return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
}

// qr-scanner decodes in a worker it creates from a blob: URL whenever the browser has no BarcodeDetector (Safari, desktop
// Chrome on Windows and Linux). Without worker-src that worker falls under script-src 'self' and never starts.
function csp(hashes: string[] = []) {
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hashes.map((hash) => ` 'sha256-${hash}'`).join("")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:; worker-src 'self' blob:`
}

function cspForHtml(body: string) {
  const hashes = [...body.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(["'])oc-[^"']*-preload-script\1[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) => createHash("sha256").update(match[2]).digest("base64"),
  )
  return csp(hashes)
}

export * as WebUi from "./web-ui"
