/**
 * @spec-handoff
 * @interface serviceWorker(directory: string): VitePlugin[]
 * @behavior
 *   - Allows fallback only for public SPA navigation routes, including login,
 *     settings, new-session, and server session routes.
 *   - Bypasses fallback for server or edge namespaces `/api`, `/auth`,
 *     `/cdn-cgi`, `/doc`, and `/openapi.json`.
 *   - Retains prompt registration and non-eager service-worker activation settings.
 * @edge-cases
 *   - Denylist patterns win over allowlist patterns and receive pathname plus search.
 *   - Lookalikes `/cdn-cgi-console`, `/document`, `/apix`, and `/authors` stay eligible.
 * @see ./vite.pwa.ts
 */

import { describe, expect, mock, test } from "bun:test"

mock.module("vite-plugin-pwa", () => ({
  VitePWA: (options: unknown) => options,
}))

const { serviceWorker } = await import("./vite.pwa")

const plugin = serviceWorker("/tmp/opencode-pwa-test") as {
  registerType: string
  injectRegister: boolean
  workbox: {
    clientsClaim: boolean
    skipWaiting: boolean
    navigateFallbackAllowlist?: RegExp[]
    navigateFallbackDenylist: RegExp[]
  }
}

const fallbackEligible = (pathnameAndSearch: string) => {
  const allowed = plugin.workbox.navigateFallbackAllowlist?.some((pattern) => pattern.test(pathnameAndSearch)) ?? true
  const denied = plugin.workbox.navigateFallbackDenylist.some((pattern) => pattern.test(pathnameAndSearch))
  return allowed && !denied
}

describe("serviceWorker Workbox navigation fallback", () => {
  test("keeps public SPA navigation routes fallback-eligible", () => {
    for (const pathname of ["/", "/login", "/settings", "/new-session", "/server/local/session/session-123"]) {
      expect(fallbackEligible(pathname)).toBe(true)
    }
  })

  test("bypasses fallback for protected server and edge navigation routes", () => {
    for (const pathname of [
      "/api",
      "/api/session",
      "/auth",
      "/auth/login",
      "/cdn-cgi",
      "/cdn-cgi/",
      "/cdn-cgi/access/login",
      "/doc",
      "/doc/guide",
      "/doc?x=1",
      "/openapi.json",
    ]) {
      expect(fallbackEligible(pathname)).toBe(false)
    }
  })

  test("keeps protected-namespace lookalikes as ordinary SPA navigation routes", () => {
    for (const pathname of ["/cdn-cgi-console", "/document", "/apix", "/authors"]) {
      expect(fallbackEligible(pathname)).toBe(true)
    }
  })

  test("retains prompt registration and non-eager service-worker activation", () => {
    expect(plugin.registerType).toBe("prompt")
    expect(plugin.injectRegister).toBe(false)
    expect(plugin.workbox.clientsClaim).toBe(false)
    expect(plugin.workbox.skipWaiting).toBe(false)
  })
})
