/**
 * @spec-handoff
 * @interface navigateFallbackAllowlist (RegExp[])
 *   File: packages/app/src/pwa.ts
 *   The Workbox `navigateFallbackAllowlist` used by the PWA service worker.
 *   This is the testable SEAM: the array is exported from `src/pwa.ts` and
 *   MUST be imported by `vite.config.ts` into
 *   `VitePWA({ workbox: { navigateFallbackAllowlist } })` (currently the array
 *   is duplicated inline at vite.config.ts:40 — Kou must replace the inline
 *   literal with an import from `./src/pwa`).
 *
 * @behavior
 *   The allowlist controls which navigation paths receive the SPA
 *   `/index.html` fallback when an active service worker controls the client.
 *   It MUST contain RegExps that match ALL SPA routes:
 *     - `/`                      → matched by  /^\/$/
 *     - `/:dir/session/:id?`     → matched by  /^\/[^/]+\/session(\/[^/]+)?$/
 *     - `/login`  (NEW)          → currently UNMATCHED — this is the fix.
 *   Kou must add a pattern that matches `/login` (e.g. /^\/login$/) WITHOUT
 *   breaking the two existing matches.
 *
 * @edge-cases
 *   - `/login` must match exactly; `/loginx` or `/login/extra` need not match.
 *   - Existing root (`/`) and session (`/foo/session/bar`) matches must be
 *     preserved — the fix is additive, not a rewrite.
 *
 * @additional-change (NOT covered by this test — flagged for Kou)
 *   In vite.config.ts, change `registerType: "prompt"` →
 *   `registerType: "autoUpdate"` so stale service workers on already-affected
 *   clients are force-evicted without depending on a user accepting an update
 *   prompt. This is a single-value config change with no deterministic unit
 *   surface here; it is part of the same E5 contract.
 *
 * @see packages/app/vite.config.ts (VitePWA workbox options)
 * @see packages/app/src/entry.tsx (renders /login route)
 */

import { describe, expect, test } from "bun:test"
import { navigateFallbackAllowlist } from "./pwa"

describe("PWA navigateFallbackAllowlist", () => {
  test("matches the /login route (SPA fallback must be served when SW controls the client)", () => {
    expect(navigateFallbackAllowlist.some((re) => re.test("/login"))).toBe(true)
  })

  test("still matches the root route '/'", () => {
    expect(navigateFallbackAllowlist.some((re) => re.test("/"))).toBe(true)
  })

  test("still matches a session route '/foo/session/bar'", () => {
    expect(navigateFallbackAllowlist.some((re) => re.test("/foo/session/bar"))).toBe(true)
  })

  test("does not over-match unrelated paths like '/loginx'", () => {
    // Guards against a too-broad fix (e.g. /^\/login/ without the end anchor).
    // The root pattern /^\/$/ and session pattern already exclude this, so the
    // /login pattern Kou adds must be anchored.
    expect(navigateFallbackAllowlist.some((re) => re.test("/loginx"))).toBe(false)
  })
})
