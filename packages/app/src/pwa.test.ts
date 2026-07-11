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
 *     - `/new-session`            → /^\/new-session$/                  (already present)
 *     - `/:dir`  (bare directory) → /^\/(?!doc$)[A-Za-z0-9_-]+$/       (already present)
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
 *
 * ---------------------------------------------------------------------------
 * @spec-handoff (E2 additive — Cloudflare Access navigateFallbackDenylist)
 * @interface navigateFallbackDenylist (RegExp[])
 *   File: packages/app/src/pwa.ts (NEW shared export, mirroring the allowlist as
 *   the single source of truth). Workbox applies the denylist with precedence
 *   over the allowlist, so Cloudflare Access reauth document navigations under
 *   `/cdn-cgi/` bypass the SPA `/index.html` fallback and reach the network/edge.
 * @behavior
 *   - MUST match `/cdn-cgi/access/authorized`, `/cdn-cgi/access/login`, and any
 *     `/cdn-cgi/` prefixed path.
 *   - MUST NOT match ordinary SPA routes (`/`, `/login`, `/foo/session/bar`).
 *   - Denylist precedence is meaningful only if `/cdn-cgi/access/...` is NOT also
 *     matched by the allowlist — asserted below.
 * @kou-patch (E4)
 *   1. Export `navigateFallbackDenylist = [/^\/cdn-cgi\//]` from src/pwa.ts.
 *   2. vite.config.ts imports BOTH navigateFallbackAllowlist AND
 *      navigateFallbackDenylist from ./src/pwa and passes both to
 *      VitePWA({ workbox }) — no re-inlined literal array.
 *   NOTE: the vite.config drift assertion for the denylist import is EXPECTED to
 *   fail until E4 wires it. That is the intended red state, scoped separately.
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { navigateFallbackAllowlist } from "./pwa"

// E2 red phase: navigateFallbackDenylist does not exist yet in ./pwa. A dynamic
// import binds the missing export to `undefined` so ONLY the new denylist tests
// fail (the allowlist tests and drift guard keep passing). E4 adds the export.
const { navigateFallbackDenylist } = (await import("./pwa")) as typeof import("./pwa") & {
  navigateFallbackDenylist: RegExp[]
}

const viteConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vite.config.ts")

const matches = (p: string) => navigateFallbackAllowlist.some((re) => re.test(p))
const denied = (p: string) => navigateFallbackDenylist.some((re: RegExp) => re.test(p))

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

describe("PWA navigateFallbackDenylist (Cloudflare Access /cdn-cgi/ bypass)", () => {
  // --- denylist matches the Cloudflare Access auth-proxy paths ---
  test("matches /cdn-cgi/access/authorized", () => {
    expect(denied("/cdn-cgi/access/authorized")).toBe(true)
  })

  test("matches /cdn-cgi/access/login", () => {
    expect(denied("/cdn-cgi/access/login")).toBe(true)
  })

  test("matches the /cdn-cgi/ prefix generally", () => {
    expect(denied("/cdn-cgi/anything")).toBe(true)
  })

  // --- denylist must NOT swallow ordinary SPA routes ---
  test("does not match ordinary SPA routes", () => {
    expect(denied("/")).toBe(false)
    expect(denied("/login")).toBe(false)
    expect(denied("/foo/session/bar")).toBe(false)
  })

  // --- precedence: /cdn-cgi/access/... must NOT be in the allowlist, so the
  //     denylist has something meaningful to override. And SPA routes still match
  //     the allowlist (unchanged). ---
  test("/cdn-cgi/access/... is not matched by the allowlist (denylist precedence is meaningful)", () => {
    expect(matches("/cdn-cgi/access/login")).toBe(false)
  })

  test("existing SPA routes still match the allowlist", () => {
    expect(matches("/")).toBe(true)
    expect(matches("/login")).toBe(true)
    expect(matches("/foo/session/bar")).toBe(true)
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

  // E4-pending (EXPECTED RED until E4 wires the denylist): vite.config.ts must
  // import the shared navigateFallbackDenylist from ./src/pwa and consume it in
  // the workbox option without re-inlining a literal array. This is the drift
  // guard for the new denylist source of truth; it fails now by design.
  test("[E4-pending] vite.config.ts imports navigateFallbackDenylist from ./src/pwa", async () => {
    const source = await readFile(viteConfigPath, "utf8")
    expect(source).toMatch(/import\s*\{[^}]*\bnavigateFallbackDenylist\b[^}]*\}\s*from\s*["']\.\/src\/pwa["']/)
  })

  test("[E4-pending] vite.config.ts consumes the shared denylist without re-inlining a literal array", async () => {
    const source = await readFile(viteConfigPath, "utf8")
    expect(source).toMatch(/navigateFallbackDenylist\s*[},:]/)
    expect(source).not.toMatch(/navigateFallbackDenylist\s*:\s*\[/)
  })
})
