/**
 * @spec-handoff
 * @interface navigateFallbackAllowlist (RegExp[])
 *   File: packages/app/src/pwa.ts
 *   The Workbox `navigateFallbackAllowlist` used by the PWA service worker.
 *   It is the single source of truth: `vite.config.ts` imports it into
 *   `VitePWA({ workbox: { navigateFallbackAllowlist } })`. The drift guard test
 *   below asserts that import stays wired (must_have #6 regression class).
 *
 * @behavior
 *   The allowlist controls which navigation paths receive the SPA
 *   `/index.html` fallback when an active service worker controls the client.
 *   It MUST contain RegExps that match ALL client-rendered SPA routes declared
 *   in app.tsx, and MUST NOT shadow server-owned routes reachable by top-level
 *   navigation.
 *
 *   SPA routes (app.tsx Route definitions + entry.tsx):
 *     - `/`                       → /^\/$/                              (already present)
 *     - `/:dir/session/:id?`      → /^\/[^/]+\/session(\/[^/]+)?$/      (already present)
 *     - `/login`                  → /^\/login$/                        (already present)
 *     - `/new-session`            → NEW — currently UNMATCHED
 *     - `/:dir`  (bare directory) → NEW — currently UNMATCHED
 *
 * @route-shape decision for the bare `/:dir` route
 *   `:dir` is a URL-safe base64 slug (see packages/core/src/util/encode.ts:
 *   btoa → `+`→`-`, `/`→`_`, strip `=`), so a real directory segment is exactly
 *   `[A-Za-z0-9_-]+` — never contains `/`, `.`, `%`, `+`, or `=`. A bare dir is
 *   therefore a SINGLE path segment. The naive `/^\/[^/]+$/` is too broad: it
 *   would shadow `/doc` (the auth-protected OpenAPI page served by the server's
 *   docRoute — server.ts: `router.add("GET", "/doc", ...)`), which is the one
 *   single-segment SERVER route a browser can navigate to directly. Serving the
 *   SPA shell for `/doc` under an active SW would break it. All other API
 *   single-segment paths (`/event`, `/config`, `/api`, `/vcs`, …) are SSE / fetch
 *   / WebSocket requests, never `mode: "navigate"`, so `navigateFallback` never
 *   fires for them and they need no exclusion. Anchor to the base64 alphabet and
 *   exclude `/doc`.
 *
 * @kou-patch — exact patterns to ADD to `navigateFallbackAllowlist` in src/pwa.ts
 *   1. /^\/new-session$/                 — the `/new-session` draft route
 *   2. /^\/(?!doc$)[A-Za-z0-9_-]+$/      — the bare `/:dir` base64 route, anchored
 *                                          to a single segment and excluding the
 *                                          navigable server route `/doc`
 *   Resulting array (additive — do NOT rewrite the existing three entries):
 *     [/^\/$/, /^\/[^/]+\/session(\/[^/]+)?$/, /^\/login$/,
 *      /^\/new-session$/, /^\/(?!doc$)[A-Za-z0-9_-]+$/]
 *   NOTE: the bare-dir pattern also matches `/login` and `/new-session`; the
 *   explicit literals are kept as self-documenting first-class app routes. That
 *   redundancy is intentional, not a bug.
 *
 * @edge-cases (asserted below)
 *   - `/new-session` and a bare dir (`/my-project`) MUST match.
 *   - `/doc` MUST NOT match (server-owned, navigable).
 *   - `/login/extra` and `/foo/bar/baz` MUST NOT match (multi-segment; guards
 *     against a `/^\/login/` prefix bug and an over-broad catch-all).
 *   - Existing `/`, `/login`, and `/foo/session/bar` matches MUST be preserved.
 *
 * @see packages/app/src/app.tsx (Route definitions, ~lines 412-417)
 * @see packages/app/vite.config.ts (VitePWA workbox options — drift guard below)
 * @see packages/core/src/util/encode.ts (base64Encode — URL-safe alphabet)
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { navigateFallbackAllowlist } from "./pwa"

const viteConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vite.config.ts")

const matches = (p: string) => navigateFallbackAllowlist.some((re) => re.test(p))

describe("PWA navigateFallbackAllowlist", () => {
  // --- existing SPA routes (already GREEN — must stay matched) ---
  test("matches the root route '/'", () => {
    expect(matches("/")).toBe(true)
  })

  test("matches the /login route", () => {
    expect(matches("/login")).toBe(true)
  })

  test("matches a session route '/foo/session/bar'", () => {
    expect(matches("/foo/session/bar")).toBe(true)
  })

  // --- finding #2: /new-session and bare /:dir (RED until Kou patches pwa.ts) ---
  test("matches the /new-session draft route", () => {
    expect(matches("/new-session")).toBe(true)
  })

  test("matches a bare directory route '/my-project'", () => {
    expect(matches("/my-project")).toBe(true)
  })

  test("matches a realistic base64 directory slug", () => {
    // base64Encode("/Users/foo") → URL-safe base64, a single [A-Za-z0-9_-] segment.
    expect(matches("/L1VzZXJzL2Zvbw")).toBe(true)
  })

  // --- over-match guards (server routes + multi-segment paths must NOT match) ---
  test("does not over-match the server-owned '/doc' route", () => {
    // /doc is the auth-protected OpenAPI page served by docRoute. A bare-dir
    // pattern must exclude it so an active SW never shadows it with the SPA shell.
    expect(matches("/doc")).toBe(false)
  })

  test("does not over-match '/login/extra' (multi-segment)", () => {
    // Guards the /login pattern's end anchor and the bare-dir single-segment anchor.
    expect(matches("/login/extra")).toBe(false)
  })

  test("does not over-match a deep path '/foo/bar/baz'", () => {
    // Guards against an over-broad catch-all that would swallow every navigation.
    expect(matches("/foo/bar/baz")).toBe(false)
  })
})

describe("PWA allowlist drift guard (vite.config.ts ↔ src/pwa.ts)", () => {
  // Finding #3: nothing else asserts that vite.config.ts still CONSUMES the shared
  // allowlist. A future re-inline of the array into the workbox option would leave
  // pwa.test.ts green while the real SW config silently drifts (must_have #6). Read
  // the vite.config.ts source and assert the shared import is wired, and that the
  // allowlist is NOT re-inlined as a literal array.
  test("vite.config.ts imports navigateFallbackAllowlist from ./src/pwa", async () => {
    const source = await readFile(viteConfigPath, "utf8")
    expect(source).toMatch(
      /import\s*\{[^}]*\bnavigateFallbackAllowlist\b[^}]*\}\s*from\s*["']\.\/src\/pwa["']/,
    )
  })

  test("vite.config.ts consumes the shared allowlist without re-inlining a literal array", async () => {
    const source = await readFile(viteConfigPath, "utf8")
    // The workbox option references the imported constant (shorthand or explicit)…
    expect(source).toMatch(/navigateFallbackAllowlist\s*[},:]/)
    // …and must NOT assign an inline array literal (the re-inline regression).
    expect(source).not.toMatch(/navigateFallbackAllowlist\s*:\s*\[/)
  })
})
