/**
 * @spec-handoff
 * @interface resolveLocalUIFile(requestPath: string, distDir: string): string | null
 * @interface serveLocalUIEffect(requestPath: string, fs: FSUtil.Interface, distDir: string): Effect<HttpServerResponse>
 * @interface serveUIEffect(request, services): adds new field `localWebUi: boolean` and `localWebUiDir: string` to services
 *
 * @behavior
 *   New env flag OPENCODE_LOCAL_WEB_UI (RuntimeFlags.localWebUi: boolean) makes the
 *   server serve the local `packages/app/dist` build instead of proxying to production.
 *   This is for development so the custom /login page (which only exists in the local
 *   build) can be tested end-to-end.
 *
 *   resolveLocalUIFile(requestPath, distDir) — pure, synchronous path resolver:
 *     - "/"                  → join(distDir, "index.html")
 *     - "/index.html"        → join(distDir, "index.html")
 *     - "/assets/foo.js"     → join(distDir, "assets/foo.js")   (real file kept as-is)
 *     - "/site.webmanifest"  → join(distDir, "site.webmanifest")(real file kept as-is)
 *     - "/login"             → join(distDir, "index.html")      (SPA fallback: no dot-extension)
 *     - "/some/spa/route"    → join(distDir, "index.html")      (SPA fallback)
 *     - The SPA-fallback rule: a request path is treated as a static file ONLY when its
 *       last segment contains a "." (has a file extension). Otherwise it falls back to
 *       index.html so the in-page SPA router can handle the route.
 *     - Path-traversal protection: any resolved path that escapes distDir MUST be
 *       rejected by returning `null` (caller serves index.html or 404). The resolved
 *       absolute path must remain within distDir.
 *
 *   serveLocalUIEffect(requestPath, fs, distDir) — reads the resolved file and returns
 *   an HttpServerResponse:
 *     - Known static file → 200 with that file's body and correct MIME content-type
 *     - SPA route (unknown, no extension) → 200 with index.html body, content-type text/html
 *     - Resolved file does not exist on disk → serve index.html (SPA fallback at runtime)
 *     - text/html responses carry a content-security-policy header (same as embedded path)
 *
 *   serveUIEffect serving order (embed > localWebUi > proxy):
 *     1. If embedded UI exists                → serve embedded   (UNCHANGED — embed wins, prod)
 *     2. NEW: else if services.localWebUi     → serveLocalUIEffect from services.localWebUiDir
 *     3. else                                 → proxy to production (UNCHANGED)
 *
 * @edge-cases
 *   - "/../../../etc/passwd"     → resolveLocalUIFile returns null (traversal rejected)
 *   - "/assets/../../secret.txt" → resolveLocalUIFile returns null (traversal rejected)
 *   - "/login" (no extension)    → index.html (SPA fallback), NOT a 404
 *   - "/" (root)                 → index.html
 *
 * @see ./ui.ts (serveEmbeddedUIEffect is the structural sibling for the embedded path)
 * @see ../../effect/runtime-flags.ts (add OPENCODE_LOCAL_WEB_UI -> localWebUi flag)
 */

import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
// RED PHASE: these named exports do not exist yet in ./ui.ts.
import { resolveLocalUIFile, serveLocalUIEffect, serveEmbeddedUIEffect } from "./ui"
import { tmpdir } from "../../../test/fixture/fixture"

// Run an Effect that only needs the real FSUtil service against the node filesystem.
function runWithFs<A, E>(effect: Effect.Effect<A, E, FSUtil.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(FSUtil.defaultLayer)) as Effect.Effect<A, E, never>)
}

// Build a fake dist dir with the shape packages/app/dist has.
async function makeDist(dir: string) {
  await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><html><body>SPA</body></html>", "utf-8")
  await fs.mkdir(path.join(dir, "assets"), { recursive: true })
  await fs.writeFile(path.join(dir, "assets", "test.js"), "export const x = 1\n", "utf-8")
  await fs.writeFile(path.join(dir, "site.webmanifest"), '{"name":"opencode"}', "utf-8")
}

// ---------------------------------------------------------------------------
// resolveLocalUIFile — pure path resolution (Option A)
// ---------------------------------------------------------------------------

describe("resolveLocalUIFile", () => {
  const dist = "/srv/app/dist"

  test('"/" resolves to index.html', () => {
    expect(resolveLocalUIFile("/", dist)).toBe(path.join(dist, "index.html"))
  })

  test('"/index.html" resolves to index.html', () => {
    expect(resolveLocalUIFile("/index.html", dist)).toBe(path.join(dist, "index.html"))
  })

  test('"/assets/foo.js" resolves to the real asset file', () => {
    expect(resolveLocalUIFile("/assets/foo.js", dist)).toBe(path.join(dist, "assets", "foo.js"))
  })

  test('"/site.webmanifest" resolves to the real manifest file', () => {
    expect(resolveLocalUIFile("/site.webmanifest", dist)).toBe(path.join(dist, "site.webmanifest"))
  })

  test('"/login" falls back to index.html (SPA route, no extension)', () => {
    expect(resolveLocalUIFile("/login", dist)).toBe(path.join(dist, "index.html"))
  })

  test('"/some/spa/route" falls back to index.html (SPA route, no extension)', () => {
    expect(resolveLocalUIFile("/some/spa/route", dist)).toBe(path.join(dist, "index.html"))
  })

  test("rejects path traversal with ../../../etc/passwd (returns null)", () => {
    expect(resolveLocalUIFile("/../../../etc/passwd", dist)).toBeNull()
  })

  test("rejects nested path traversal that escapes distDir (returns null)", () => {
    expect(resolveLocalUIFile("/assets/../../secret.txt", dist)).toBeNull()
  })

  test("never returns a path outside distDir for any input", () => {
    for (const input of ["/", "/login", "/assets/test.js", "/a/b/c", "/site.webmanifest"]) {
      const resolved = resolveLocalUIFile(input, dist)
      if (resolved === null) continue
      // Resolved path must be inside distDir.
      const rel = path.relative(dist, resolved)
      expect(rel.startsWith("..")).toBe(false)
      expect(path.isAbsolute(rel)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// serveLocalUIEffect — integration against a real temp dist dir (Option B)
// ---------------------------------------------------------------------------

describe("serveLocalUIEffect", () => {
  test('serves index.html content for "/"', async () => {
    await using tmp = await tmpdir()
    await makeDist(tmp.path)

    const body = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveLocalUIEffect("/", fsutil, tmp.path)
        expect(response.status).toBe(200)
        return yield* response.text
      }),
    )

    expect(body).toContain("SPA")
  })

  test('serves index.html content for unknown SPA route "/login"', async () => {
    await using tmp = await tmpdir()
    await makeDist(tmp.path)

    const result = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveLocalUIEffect("/login", fsutil, tmp.path)
        const text = yield* response.text
        return { status: response.status, contentType: response.headers["content-type"], text }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.contentType).toContain("text/html")
    expect(result.text).toContain("SPA")
  })

  test('serves the real asset file for "/assets/test.js" with JS mime', async () => {
    await using tmp = await tmpdir()
    await makeDist(tmp.path)

    const result = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveLocalUIEffect("/assets/test.js", fsutil, tmp.path)
        const text = yield* response.text
        return { status: response.status, contentType: response.headers["content-type"], text }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.text).toContain("export const x = 1")
    // mime-types maps .js → text/javascript (or application/javascript)
    expect(result.contentType).toMatch(/javascript/)
  })

  test('serves the manifest file for "/site.webmanifest"', async () => {
    await using tmp = await tmpdir()
    await makeDist(tmp.path)

    const text = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveLocalUIEffect("/site.webmanifest", fsutil, tmp.path)
        expect(response.status).toBe(200)
        return yield* response.text
      }),
    )

    expect(text).toContain("opencode")
  })

  test("sets content-security-policy header for text/html responses", async () => {
    await using tmp = await tmpdir()
    await makeDist(tmp.path)

    const csp = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveLocalUIEffect("/", fsutil, tmp.path)
        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/html")
        return response.headers["content-security-policy"]
      }),
    )

    expect(csp).toBeDefined()
    expect(csp).toMatch(/^default-src/)
  })

  test("does not leak files outside distDir for a traversal path", async () => {
    await using tmp = await tmpdir()
    await makeDist(tmp.path)
    // Write a secret OUTSIDE the dist dir (sibling).
    const secret = path.join(path.dirname(tmp.path), "secret-outside.txt")
    await fs.writeFile(secret, "TOP SECRET", "utf-8").catch(() => {})

    const text = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveLocalUIEffect("/../secret-outside.txt", fsutil, tmp.path)
        return yield* response.text
      }),
    )

    // Must NOT contain the secret — traversal is rejected, SPA fallback served instead.
    expect(text).not.toContain("TOP SECRET")
    await fs.rm(secret, { force: true }).catch(() => {})
  })
})

// ---------------------------------------------------------------------------
// serveEmbeddedUIEffect — production embedded UI path (regression lock)
//
// REGRESSION GUARD (not a red test): the production binary embeds the UI as a
// Record<request-path-key -> on-disk file path>. serveEmbeddedUIEffect strips
// the leading "/" from the request path, looks the key up, and falls back to
// the "index.html" entry when the key is absent. The MIME is derived from the
// resolved on-disk file's extension. This block locks the proven behavior that
// "/login" (and any extension-less SPA route) serves index.html as text/html,
// so a future change to the embedded fallback can't silently break the login
// page. These tests MUST pass against current, unmodified ui.ts.
// ---------------------------------------------------------------------------

// Build a temp "dist" mirroring the real embedded build, plus the embedded map
// the production binary hands to serveEmbeddedUIEffect: keys are built dist
// file paths ("index.html", "assets/app.js"), values are the absolute on-disk
// paths FSUtil reads.
async function makeEmbedded(dir: string) {
  await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><html><body>SPA</body></html>", "utf-8")
  await fs.mkdir(path.join(dir, "assets"), { recursive: true })
  await fs.writeFile(path.join(dir, "assets", "app.js"), "export const x = 1\n", "utf-8")
  return {
    "index.html": path.join(dir, "index.html"),
    "assets/app.js": path.join(dir, "assets", "app.js"),
  } as Record<string, string>
}

describe("serveEmbeddedUIEffect", () => {
  test('"/login" falls back to index.html and is served as text/html (login regression lock)', async () => {
    await using tmp = await tmpdir()
    const map = await makeEmbedded(tmp.path)

    const result = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveEmbeddedUIEffect("/login", fsutil, map)
        return { status: response.status, contentType: response.headers["content-type"] }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.contentType).toContain("text/html")
  })

  test('"/" is served as index.html with text/html', async () => {
    await using tmp = await tmpdir()
    const map = await makeEmbedded(tmp.path)

    const result = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveEmbeddedUIEffect("/", fsutil, map)
        return { status: response.status, contentType: response.headers["content-type"] }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.contentType).toContain("text/html")
  })

  test('"/assets/app.js" serves the real asset directly with a javascript mime (no fallback)', async () => {
    await using tmp = await tmpdir()
    const map = await makeEmbedded(tmp.path)

    const result = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveEmbeddedUIEffect("/assets/app.js", fsutil, map)
        return { status: response.status, contentType: response.headers["content-type"] }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.contentType).toMatch(/javascript/)
    // Asset is served directly, not as the index.html fallback.
    expect(result.contentType).not.toContain("text/html")
  })

  test('unknown extension-less SPA route "/some/spa/route" falls back to index.html (text/html)', async () => {
    await using tmp = await tmpdir()
    const map = await makeEmbedded(tmp.path)

    const result = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveEmbeddedUIEffect("/some/spa/route", fsutil, map)
        return { status: response.status, contentType: response.headers["content-type"] }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.contentType).toContain("text/html")
  })

  test("text/html responses carry a content-security-policy header", async () => {
    await using tmp = await tmpdir()
    const map = await makeEmbedded(tmp.path)

    const csp = await runWithFs(
      Effect.gen(function* () {
        const fsutil = yield* FSUtil.Service
        const response = yield* serveEmbeddedUIEffect("/login", fsutil, map)
        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/html")
        return response.headers["content-security-policy"]
      }),
    )

    expect(csp).toBeDefined()
    expect(csp).toMatch(/^default-src/)
  })
})

// Keep NodeFileSystem import referenced so the layer dependency is explicit in this file.
void NodeFileSystem
