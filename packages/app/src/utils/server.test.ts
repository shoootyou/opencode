/**
 * @spec-handoff
 * @interface buildLoginRedirectUrl(pathname: string, search: string): string
 * @interface shouldRedirectToLogin(requestUrl: string, currentOrigin: string, currentPathname: string): boolean
 * @interface redirectToLogin(loc?: { origin: string; pathname: string; search: string; href: string }): void
 * @interface resetRedirectInFlight(): void  // test-only seam to clear the module-level B5 guard between tests
 * @behavior
 *   - buildLoginRedirectUrl: returns "/login?redirect=<encoded pathname+search>"; the
 *     redirect value is encodeURIComponent(pathname + search).
 *   - shouldRedirectToLogin: returns true only when (a) new URL(requestUrl).origin === currentOrigin
 *     (same-origin guard) AND (b) currentPathname !== "/login" (loop guard).
 *   - shouldRedirectToLogin: returns false for a remote-origin request URL (multi-server safety).
 *   - shouldRedirectToLogin: returns false when currentPathname === "/login".
 *   - redirectToLogin: when not on /login and not already in flight, sets loc.href to
 *     buildLoginRedirectUrl(loc.pathname, loc.search) and sets the module-level redirectInFlight guard.
 *   - redirectToLogin: when loc.pathname === "/login", is a no-op (does not assign href).
 *   - redirectToLogin: a second call (after redirectInFlight is set) is a no-op (B5 debounce).
 * @edge-cases
 *   - pathname "/session/123" with search "" → /login?redirect=%2Fsession%2F123
 *   - pathname "/foo" with search "?x=1" → /login?redirect=%2Ffoo%3Fx%3D1 (search preserved + encoded)
 *   - request URL "http://localhost:4096/api/x" with currentOrigin "http://localhost:4096" → true
 *   - request URL "https://remote.example.com/api/x" with currentOrigin "http://localhost:4096" → false
 * @testability
 *   - These functions MUST be importable from "@/utils/server" (or a sibling pure module
 *     re-exported by it) WITHOUT triggering SolidJS/Kobalte UI module load (Chi gotcha:
 *     bun test + importing UI-heavy .tsx explodes at module load).
 *   - happy-dom's global `location` defaults to about:blank with origin=null and is NOT
 *     mutable (assigning location.href is a no-op, history.replaceState does not update it).
 *     Therefore redirectToLogin MUST accept an injectable location-like object so tests can
 *     supply pathname/search/origin and capture the assigned href. The pure decision
 *     functions (buildLoginRedirectUrl, shouldRedirectToLogin) take location data as plain
 *     arguments and touch no globals.
 *   - The 401 response interceptor wiring inside createSdkForServer composes these:
 *     on a 401 response, if shouldRedirectToLogin(request.url, location.origin, location.pathname)
 *     then redirectToLogin(). The interceptor itself is not unit-tested here (it requires the
 *     full SDK client); its decision logic is fully covered by shouldRedirectToLogin.
 * @see ./server.ts
 * @see ../context/server-sdk.tsx (isUnauthorizedSseError shares redirectToLogin)
 * @see ../pages/login-utils.ts (safeRedirect reads the ?redirect= param this produces)
 */

import { beforeEach, describe, expect, test } from "bun:test"
import {
  authFromToken,
  authTokenFromCredentials,
  buildLoginRedirectUrl,
  redirectToLogin,
  resetRedirectInFlight,
  shouldRedirectToLogin,
} from "./server"

// A minimal stand-in for `window.location` that records href assignments.
// happy-dom's real `location` is about:blank, origin=null, and immutable in this
// harness, so redirectToLogin must accept an injectable location-like object.
function fakeLocation(input: { origin: string; pathname: string; search: string }) {
  let assignedHref = ""
  return {
    origin: input.origin,
    pathname: input.pathname,
    search: input.search,
    get href() {
      return assignedHref
    },
    set href(value: string) {
      assignedHref = value
    },
  }
}

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

// ---------------------------------------------------------------------------
// buildLoginRedirectUrl — D5: redirect construction (path + search preserved & encoded)
// ---------------------------------------------------------------------------

describe("buildLoginRedirectUrl", () => {
  test("encodes a normal path with no search", () => {
    expect(buildLoginRedirectUrl("/session/123", "")).toBe("/login?redirect=%2Fsession%2F123")
  })

  test("preserves and encodes the search string", () => {
    expect(buildLoginRedirectUrl("/foo", "?x=1")).toBe("/login?redirect=%2Ffoo%3Fx%3D1")
  })

  test("encodes the root path", () => {
    expect(buildLoginRedirectUrl("/", "")).toBe("/login?redirect=%2F")
  })
})

// ---------------------------------------------------------------------------
// shouldRedirectToLogin — D6: same-origin + loop guard decision
// ---------------------------------------------------------------------------

describe("shouldRedirectToLogin", () => {
  test("true when request origin matches current origin and not on /login", () => {
    expect(shouldRedirectToLogin("http://localhost:4096/api/session", "http://localhost:4096", "/session/1")).toBe(
      true,
    )
  })

  test("false when request origin differs from current origin (remote multi-server)", () => {
    expect(
      shouldRedirectToLogin("https://remote.example.com/api/session", "http://localhost:4096", "/session/1"),
    ).toBe(false)
  })

  test("false when already on /login even if same-origin", () => {
    expect(shouldRedirectToLogin("http://localhost:4096/api/session", "http://localhost:4096", "/login")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// redirectToLogin — D5: navigation + loop prevention + debounce (B3, B5)
// ---------------------------------------------------------------------------

describe("redirectToLogin", () => {
  // The redirectInFlight guard (B5) is module-level. Reset it between tests so
  // each test exercises a clean, independent first-redirect.
  beforeEach(() => {
    resetRedirectInFlight()
  })

  test("navigates to /login with the encoded current path+search", () => {
    const loc = fakeLocation({ origin: "http://localhost:4096", pathname: "/session/123", search: "?x=1" })
    redirectToLogin(loc)
    expect(loc.href).toBe("/login?redirect=%2Fsession%2F123%3Fx%3D1")
  })

  test("is a no-op when already on /login", () => {
    const loc = fakeLocation({ origin: "http://localhost:4096", pathname: "/login", search: "?redirect=%2Ffoo" })
    redirectToLogin(loc)
    expect(loc.href).toBe("")
  })

  test("preserves location.search in the redirect param", () => {
    const loc = fakeLocation({ origin: "http://localhost:4096", pathname: "/a/b", search: "?q=hello%20world&p=2" })
    redirectToLogin(loc)
    expect(loc.href).toBe(`/login?redirect=${encodeURIComponent("/a/b?q=hello%20world&p=2")}`)
  })

  test("second call while a redirect is already in flight is a no-op (debounce)", () => {
    const first = fakeLocation({ origin: "http://localhost:4096", pathname: "/first", search: "" })
    redirectToLogin(first)
    expect(first.href).toBe("/login?redirect=%2Ffirst")

    // redirectInFlight is now set module-wide; a second navigation must not occur.
    const second = fakeLocation({ origin: "http://localhost:4096", pathname: "/second", search: "" })
    redirectToLogin(second)
    expect(second.href).toBe("")
  })
})
