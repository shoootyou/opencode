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
 *
 * ---------------------------------------------------------------------------
 * @spec-handoff (E2 additive — Cloudflare Access session-expiry recovery)
 *   Additive to the RFC 017 401→/login contract above. MUST NOT change it:
 *   same-origin 401 still redirects to /login; remote-origin 401 still does not;
 *   /login still does not redirect to itself; the CF branch returns false for 401.
 *
 * @interface isCloudflareAccessSessionExpiredResponse(response: Response, currentOrigin: string): Promise<boolean>
 *   Pure classifier (no browser globals). Async only because the 403 body-marker
 *   check must read response.clone().text(). Returns true when:
 *     1. response.type === "opaqueredirect".
 *     2. response.redirected === true AND response.url is parseable AND
 *        (new URL(response.url).origin !== currentOrigin
 *         OR hostname === "cloudflareaccess.com" / ends with ".cloudflareaccess.com").
 *     3. response.status === 403 AND response.headers.has("cf-mitigated").
 *     4. response.status === 403 AND response.clone().text() matches a CF marker:
 *        /cloudflareaccess\.com/i, /cloudflare access/i, /cf-mitigated/i,
 *        /__cf_chl/i, or /cdn-cgi\/access/i.
 *     5. otherwise false.
 *   MUST use response.clone() for the body check so the original body stays
 *   consumable by the caller.
 * @behavior (negatives → false)
 *   - ordinary same-origin 403 (no cf-mitigated header, no body marker);
 *   - same-origin redirect (redirected true, same origin, no CF host);
 *   - HTTP 401 (owned by the existing 401 branch); remote-origin 401;
 *   - any 2xx.
 *
 * @interface recoverFromCloudflareAccessSessionExpiry(deps?: {
 *     location?: { origin; pathname; search; hash; href; replace(url); reload() }
 *     serviceWorker?: { getRegistrations(): Promise<Array<{ unregister(): Promise<boolean> }>> }
 *     cacheBust?: () => string
 *   }): Promise<void>
 *   Full-document recovery that bypasses the PWA service worker:
 *     1. if cloudflareRecoveryInFlight → return (idempotent).
 *     2. set the guard synchronously before any await.
 *     3. if serviceWorker dep present → unregister all registrations.
 *     4. location.replace(cache-busted current path+search+hash) — NOT assign/href,
 *        so no history entry is added.
 * @interface resetCloudflareRecoveryInFlight(): void  // test-only guard reset
 *
 * @interface createGuardedFetch(baseFetch: typeof fetch, deps?: {
 *     location?: {...}; recover?: typeof recoverFromCloudflareAccessSessionExpiry
 *   }): typeof fetch
 *   Extracts the inline guardedFetch. Order: await baseFetch → CF check (void
 *   recover) → existing 401 shouldRedirectToLogin/redirectToLogin → return
 *   response. The CF check runs first but returns false for 401 so the 401 branch
 *   is preserved. Retains { preconnect: fetch.preconnect }.
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

// E2 red phase: these helpers do not exist yet in ./server. A static named
// import of a missing export throws at module link time and would break the
// existing (green) tests in this file. A dynamic import binds each missing
// export to `undefined`, so ONLY the new Cloudflare tests fail — and they fail
// for the right reason ("not a function") until E3 implements the helpers.
const {
  createGuardedFetch,
  isCloudflareAccessSessionExpiredResponse,
  recoverFromCloudflareAccessSessionExpiry,
  resetCloudflareRecoveryInFlight,
} = (await import("./server")) as typeof import("./server") & {
  createGuardedFetch: (
    baseFetch: typeof fetch,
    deps?: {
      location?: ReturnType<typeof fakeRecoveryLocation>
      recover?: (deps?: { location?: ReturnType<typeof fakeRecoveryLocation> }) => Promise<void>
    },
  ) => typeof fetch
  isCloudflareAccessSessionExpiredResponse: (response: Response, currentOrigin: string) => Promise<boolean>
  recoverFromCloudflareAccessSessionExpiry: (deps?: {
    location?: ReturnType<typeof fakeRecoveryLocation>
    serviceWorker?: { getRegistrations(): Promise<Array<{ unregister(): Promise<boolean> }>> }
    cacheBust?: () => string
  }) => Promise<void>
  resetCloudflareRecoveryInFlight: () => void
}

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

// A richer location stand-in for the Cloudflare recovery path: it records
// replace()/reload() calls and href assignments so tests can assert the helper
// uses replace() (no new history entry) rather than assign/href.
function fakeRecoveryLocation(
  input: { origin: string; pathname: string; search: string; hash: string } = {
    origin: "http://localhost:4096",
    pathname: "/session/abc",
    search: "?x=1",
    hash: "",
  },
) {
  const calls = { replace: [] as string[], reload: 0, href: [] as string[] }
  return {
    calls,
    origin: input.origin,
    pathname: input.pathname,
    search: input.search,
    hash: input.hash,
    get href() {
      return calls.href[calls.href.length - 1] ?? ""
    },
    set href(value: string) {
      calls.href.push(value)
    },
    replace(url: string) {
      calls.replace.push(url)
    },
    reload() {
      calls.reload += 1
    },
  }
}

// Builds a Response with overridable read-only fields (type, redirected, url).
// happy-dom / Bun expose these as read-only getters, so tests define them.
function fakeResponse(input: {
  status?: number
  headers?: Record<string, string>
  body?: string
  type?: string
  redirected?: boolean
  url?: string
}) {
  const response = new Response(input.body ?? "", {
    status: input.status ?? 200,
    headers: input.headers ?? {},
  })
  if (input.type !== undefined) Object.defineProperty(response, "type", { value: input.type })
  if (input.redirected !== undefined) Object.defineProperty(response, "redirected", { value: input.redirected })
  if (input.url !== undefined) Object.defineProperty(response, "url", { value: input.url })
  return response
}

function fakeBaseFetch(response: Response) {
  const baseFetch = (async () => response) as unknown as typeof fetch
  baseFetch.preconnect = fetch.preconnect
  return baseFetch
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

// ---------------------------------------------------------------------------
// isCloudflareAccessSessionExpiredResponse — E2 red: Cloudflare Access expiry
// detection on fetch responses. Additive; MUST return false for the 401 branch.
// ---------------------------------------------------------------------------

describe("isCloudflareAccessSessionExpiredResponse", () => {
  const origin = "http://localhost:4096"

  // --- positive signals ---
  test("true for an opaqueredirect response", async () => {
    const response = fakeResponse({ status: 0, type: "opaqueredirect" })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(true)
  })

  test("true for a redirect to a different origin", async () => {
    const response = fakeResponse({ status: 200, redirected: true, url: "https://remote.example.com/landing" })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(true)
  })

  test("true for a redirect to a cloudflareaccess.com host", async () => {
    const response = fakeResponse({ status: 200, redirected: true, url: "https://team.cloudflareaccess.com/cdn-cgi/access/login" })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(true)
  })

  test("true for a 403 carrying a cf-mitigated header", async () => {
    const response = fakeResponse({ status: 403, headers: { "cf-mitigated": "challenge" } })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(true)
  })

  test("true for a 403 whose body contains a Cloudflare Access marker", async () => {
    const response = fakeResponse({ status: 403, body: "<html>Redirecting to cloudflareaccess.com …</html>" })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(true)
  })

  test("true for a 403 whose body contains a __cf_chl challenge marker", async () => {
    const response = fakeResponse({ status: 403, body: "window.__cf_chl_opt = {}" })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(true)
  })

  // --- negative signals ---
  test("false for an ordinary same-origin 403 with no cf marker", async () => {
    const response = fakeResponse({ status: 403, body: "Forbidden: you lack permission" })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(false)
  })

  test("false for a same-origin redirect with no cloudflareaccess host", async () => {
    const response = fakeResponse({ status: 200, redirected: true, url: `${origin}/session/abc` })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(false)
  })

  test("false for a same-origin HTTP 401 (owned by the existing 401 branch)", async () => {
    const response = fakeResponse({ status: 401, url: `${origin}/api/session` })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(false)
  })

  test("false for a remote-origin HTTP 401", async () => {
    const response = fakeResponse({ status: 401, url: "https://remote.example.com/api/session" })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(false)
  })

  test("false for a normal 2xx response", async () => {
    const response = fakeResponse({ status: 200, url: `${origin}/api/session`, body: "ok" })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(false)
  })

  // --- body preservation: the detector must clone, never consume ---
  test("leaves the original 403 body readable for the caller (uses response.clone())", async () => {
    const response = fakeResponse({ status: 403, body: "contains cloudflareaccess.com marker" })
    await isCloudflareAccessSessionExpiredResponse(response, origin)
    expect(response.bodyUsed).toBe(false)
    expect(await response.text()).toBe("contains cloudflareaccess.com marker")
  })
})

// ---------------------------------------------------------------------------
// recoverFromCloudflareAccessSessionExpiry — E2 red: full-document recovery
// that bypasses the service worker with an injectable location/serviceWorker.
// ---------------------------------------------------------------------------

describe("recoverFromCloudflareAccessSessionExpiry", () => {
  beforeEach(() => {
    resetCloudflareRecoveryInFlight()
  })

  test("navigates with location.replace (not assign) using a cache-bust param on the current path", async () => {
    const loc = fakeRecoveryLocation()
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, cacheBust: () => "seed" })
    expect(loc.calls.replace).toHaveLength(1)
    expect(loc.calls.href).toHaveLength(0)
    const target = loc.calls.replace[0] ?? ""
    expect(target).toContain("/session/abc")
    expect(target).toContain("seed")
  })

  test("is idempotent: a second in-flight call does not navigate again", async () => {
    const loc = fakeRecoveryLocation()
    // Do not await the first call: its guard must be set synchronously before any await.
    const first = recoverFromCloudflareAccessSessionExpiry({ location: loc, cacheBust: () => "seed" })
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, cacheBust: () => "seed" })
    await first
    expect(loc.calls.replace).toHaveLength(1)
  })

  test("unregisters service worker registrations when a serviceWorker dep is provided", async () => {
    const loc = fakeRecoveryLocation()
    let unregistered = 0
    const serviceWorker = {
      getRegistrations: async () => [
        { unregister: async () => (unregistered++, true) },
        { unregister: async () => (unregistered++, true) },
      ],
    }
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, serviceWorker, cacheBust: () => "seed" })
    expect(unregistered).toBe(2)
    expect(loc.calls.replace).toHaveLength(1)
  })

  test("resetCloudflareRecoveryInFlight clears the guard so a later call navigates again", async () => {
    const loc = fakeRecoveryLocation()
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, cacheBust: () => "seed" })
    expect(loc.calls.replace).toHaveLength(1)
    resetCloudflareRecoveryInFlight()
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, cacheBust: () => "seed" })
    expect(loc.calls.replace).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// createGuardedFetch — E2 red: guarded fetch factory wiring. CF expiry triggers
// recovery; same-origin 401 keeps the existing /login path; 2xx passes through.
// ---------------------------------------------------------------------------

describe("createGuardedFetch", () => {
  const origin = "http://localhost:4096"

  beforeEach(() => {
    resetRedirectInFlight()
    resetCloudflareRecoveryInFlight()
  })

  test("a Cloudflare-expiry response triggers recovery and still returns the response", async () => {
    const loc = fakeRecoveryLocation({ origin, pathname: "/session/abc", search: "", hash: "" })
    let recovered = 0
    const cfResponse = fakeResponse({ status: 403, headers: { "cf-mitigated": "challenge" } })
    const guarded = createGuardedFetch(fakeBaseFetch(cfResponse), {
      location: loc,
      recover: async () => {
        recovered += 1
      },
    })
    const result = await guarded("http://localhost:4096/api/session")
    expect(recovered).toBe(1)
    expect(result).toBe(cfResponse)
  })

  test("a same-origin 401 still triggers the existing redirectToLogin path, not CF recovery", async () => {
    const loc = fakeRecoveryLocation({ origin, pathname: "/session/abc", search: "", hash: "" })
    let recovered = 0
    const unauthorized = fakeResponse({ status: 401, url: `${origin}/api/session` })
    const guarded = createGuardedFetch(fakeBaseFetch(unauthorized), {
      location: loc,
      recover: async () => {
        recovered += 1
      },
    })
    const result = await guarded("http://localhost:4096/api/session")
    expect(recovered).toBe(0)
    expect(loc.calls.href).toHaveLength(1)
    expect(loc.calls.href[0]).toBe("/login?redirect=%2Fsession%2Fabc")
    expect(result).toBe(unauthorized)
  })

  test("a normal 2xx response passes through untouched", async () => {
    const loc = fakeRecoveryLocation({ origin, pathname: "/session/abc", search: "", hash: "" })
    let recovered = 0
    const ok = fakeResponse({ status: 200, url: `${origin}/api/session`, body: "ok" })
    const guarded = createGuardedFetch(fakeBaseFetch(ok), {
      location: loc,
      recover: async () => {
        recovered += 1
      },
    })
    const result = await guarded("http://localhost:4096/api/session")
    expect(recovered).toBe(0)
    expect(loc.calls.href).toHaveLength(0)
    expect(loc.calls.replace).toHaveLength(0)
    expect(result).toBe(ok)
  })

  test("preserves the Bun fetch preconnect property", () => {
    const guarded = createGuardedFetch(fakeBaseFetch(fakeResponse({ status: 200 })), { location: fakeRecoveryLocation() })
    expect(guarded.preconnect).toBe(fetch.preconnect)
  })
})
