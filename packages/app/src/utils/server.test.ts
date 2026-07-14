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
 *
 * ---------------------------------------------------------------------------
 * @spec-handoff (r1 audit remediation — strengthened Cloudflare recovery contract)
 *   These additive assertions encode the POST-FIX contract from the round-1
 *   security + test-quality audit. They are RED against the pre-remediation code
 *   where behavior must change; Kou implements the code to turn them green.
 *
 * @change recoverFromCloudflareAccessSessionExpiry(deps?)
 *   1. CROSS-DOCUMENT LOOP CAP: if the current URL already carries the
 *      `__cf_access_recover` query param, recovery is a NO-OP — it MUST NOT
 *      unregister the service worker and MUST NOT call location.replace. This
 *      stops an infinite reload loop when the edge keeps re-challenging.
 *   2. CACHE-BUST VIA URLSearchParams.set (no accumulation): the target sets
 *      `__cf_access_recover` exactly once. Param goes BEFORE the hash, `&`
 *      separator when a search already exists, `?` when it does not. If the param
 *      is somehow already present it is REPLACED, not appended (covered by the cap).
 *      Exact targets asserted for fixtures:
 *        `/session/abc?x=1#frag` → `/session/abc?x=1&__cf_access_recover=<bust>#frag`
 *        `/session/abc#frag`     → `/session/abc?__cf_access_recover=<bust>#frag`
 *   3. OPEN-REDIRECT SAFETY: when the current pathname begins with `//`
 *      (protocol-relative), the replace target MUST stay same-origin — it must
 *      resolve to loc.origin and MUST NOT start with `//` (no off-origin nav).
 *   4. TRUE IN-FLIGHT IDEMPOTENCY: the guard is set SYNCHRONOUSLY before the first
 *      await. With an unresolved getRegistrations() promise, a second concurrent
 *      call is a no-op → exactly ONE unregister sequence and ONE location.replace.
 *   5. SW UNREGISTER RESILIENCE (allSettled): if unregister() or
 *      getRegistrations() REJECTS, recovery STILL calls location.replace
 *      (navigation is not blocked) and the in-flight guard is not permanently
 *      stuck (a reset seam lets a fresh recovery proceed).
 *   6. REAL-DEFAULT-PATH: omitting cacheBust yields a non-empty
 *      `__cf_access_recover` value; and createGuardedFetch exercises the DEFAULT
 *      recover wiring (no injected recover) so the real code path runs.
 *
 * @change isCloudflareAccessSessionExpiredResponse(response, currentOrigin)
 *   7. Distinct cloudflareaccess.com host branch is independent of the generic
 *      cross-origin clause: a SAME-origin redirect to a `*.cloudflareaccess.com`
 *      host → true (mutation-resistant; must hold even if the cross-origin clause
 *      were removed).
 *   8. 403 body-marker is now GATED ON content-type: only `text/html` 403 bodies
 *      are inspected. A 403 with `content-type: application/json` whose body text
 *      contains a CF marker → false (no false positives on JSON/API 403s). The
 *      positive body-marker cases now set `content-type: text/html`.
 *
 * @change createGuardedFetch(baseFetch, deps?)
 *   9. The wrapper forwards its location seam: the object passed to `recover`
 *      has `.location === loc`.
 *  10. Request-object input: a same-origin 401 for `new Request(url)` still takes
 *      the `/login?redirect=...` path (covers the `input instanceof Request` branch).
 */

import { beforeEach, describe, expect, test } from "bun:test"
import {
  authFromToken,
  authTokenFromCredentials,
  buildLoginRedirectUrl,
  createSdkForServer,
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

  test("true for a 403 whose text/html body contains a Cloudflare Access marker", async () => {
    const response = fakeResponse({
      status: 403,
      headers: { "content-type": "text/html" },
      body: "<html>Redirecting to cloudflareaccess.com …</html>",
    })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(true)
  })

  test("true for a 403 whose text/html body contains a __cf_chl challenge marker", async () => {
    const response = fakeResponse({
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "window.__cf_chl_opt = {}",
    })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(true)
  })

  // --- item 7: distinct cloudflareaccess.com host branch (mutation-resistant) ---
  test("true for a SAME-origin redirect to a cloudflareaccess.com host (host branch is independent)", async () => {
    // currentOrigin is itself the Access host, so the generic cross-origin clause
    // cannot fire — only the dedicated host branch can classify this as expiry.
    const cfOrigin = "https://team.cloudflareaccess.com"
    const response = fakeResponse({
      status: 200,
      redirected: true,
      url: "https://team.cloudflareaccess.com/cdn-cgi/access/login",
    })
    expect(await isCloudflareAccessSessionExpiredResponse(response, cfOrigin)).toBe(true)
  })

  // --- item 8: 403 body-marker gated on content-type (no false positives on JSON) ---
  test("false for a 403 application/json body even when it contains a CF marker string", async () => {
    const response = fakeResponse({
      status: 403,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "denied", detail: "cloudflareaccess.com" }),
    })
    expect(await isCloudflareAccessSessionExpiredResponse(response, origin)).toBe(false)
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
    const response = fakeResponse({
      status: 403,
      headers: { "content-type": "text/html" },
      body: "contains cloudflareaccess.com marker",
    })
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

  // --- item 1: cross-document loop cap ---
  test("is a NO-OP when the current URL already carries __cf_access_recover (loop cap)", async () => {
    const loc = fakeRecoveryLocation({
      origin: "http://localhost:4096",
      pathname: "/session/abc",
      search: "?__cf_access_recover=old",
      hash: "",
    })
    let unregistered = 0
    const serviceWorker = {
      getRegistrations: async () => [{ unregister: async () => (unregistered++, true) }],
    }
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, serviceWorker, cacheBust: () => "seed" })
    expect(loc.calls.replace).toHaveLength(0)
    expect(unregistered).toBe(0)
  })

  test("loop cap also applies when __cf_access_recover is one of several params", async () => {
    const loc = fakeRecoveryLocation({
      origin: "http://localhost:4096",
      pathname: "/session/abc",
      search: "?x=1&__cf_access_recover=old&y=2",
      hash: "",
    })
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, cacheBust: () => "seed" })
    expect(loc.calls.replace).toHaveLength(0)
  })

  // --- item 2: exact cache-bust target, set-semantics (no accumulation) ---
  test("builds the EXACT replace target with & separator and param before the hash", async () => {
    const loc = fakeRecoveryLocation({
      origin: "http://localhost:4096",
      pathname: "/session/abc",
      search: "?x=1",
      hash: "#frag",
    })
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, cacheBust: () => "bust" })
    expect(loc.calls.replace).toEqual(["/session/abc?x=1&__cf_access_recover=bust#frag"])
  })

  test("builds the EXACT replace target with ? separator when there is no search", async () => {
    const loc = fakeRecoveryLocation({
      origin: "http://localhost:4096",
      pathname: "/session/abc",
      search: "",
      hash: "#frag",
    })
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, cacheBust: () => "bust" })
    expect(loc.calls.replace).toEqual(["/session/abc?__cf_access_recover=bust#frag"])
  })

  // --- item 3: open-redirect safety (protocol-relative pathname) ---
  test("stays same-origin when the pathname is protocol-relative (//evil.example)", async () => {
    const loc = fakeRecoveryLocation({
      origin: "http://localhost:4096",
      pathname: "//evil.example/path",
      search: "",
      hash: "",
    })
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, cacheBust: () => "bust" })
    expect(loc.calls.replace).toHaveLength(1)
    const target = loc.calls.replace[0] ?? ""
    // The target must resolve back to the injected origin and MUST NOT be a
    // protocol-relative URL that a browser would treat as off-origin.
    expect(target.startsWith("//")).toBe(false)
    expect(new URL(target, loc.origin).origin).toBe(loc.origin)
  })

  // --- item 4: true in-flight idempotency with a suspended getRegistrations ---
  test("guard is set synchronously: a second call while the first is suspended is a no-op", async () => {
    const loc = fakeRecoveryLocation({
      origin: "http://localhost:4096",
      pathname: "/session/abc",
      search: "?x=1",
      hash: "",
    })
    let unregistered = 0
    let releaseRegistrations: (r: Array<{ unregister(): Promise<boolean> }>) => void = () => {}
    const pending = new Promise<Array<{ unregister(): Promise<boolean> }>>((resolve) => {
      releaseRegistrations = resolve
    })
    const serviceWorker = { getRegistrations: () => pending }

    // Start the first recovery but keep it suspended on the unresolved promise.
    const first = recoverFromCloudflareAccessSessionExpiry({ location: loc, serviceWorker, cacheBust: () => "seed" })
    // Second concurrent call must observe the synchronously-set guard → no-op.
    const second = recoverFromCloudflareAccessSessionExpiry({ location: loc, serviceWorker, cacheBust: () => "seed" })
    await second
    releaseRegistrations([
      { unregister: async () => (unregistered++, true) },
      { unregister: async () => (unregistered++, true) },
    ])
    await first
    expect(unregistered).toBe(2)
    expect(loc.calls.replace).toHaveLength(1)
  })

  // --- item 5: SW unregister resilience (allSettled — navigation not blocked) ---
  test("still navigates when a registration.unregister() rejects", async () => {
    const loc = fakeRecoveryLocation()
    const serviceWorker = {
      getRegistrations: async () => [
        { unregister: async () => (await Promise.reject(new Error("unregister failed")), true) },
        { unregister: async () => true },
      ],
    }
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, serviceWorker, cacheBust: () => "seed" })
    expect(loc.calls.replace).toHaveLength(1)
  })

  test("still navigates when getRegistrations() itself rejects", async () => {
    const loc = fakeRecoveryLocation()
    const serviceWorker = {
      getRegistrations: async () => {
        throw new Error("getRegistrations failed")
      },
    }
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, serviceWorker, cacheBust: () => "seed" })
    expect(loc.calls.replace).toHaveLength(1)
  })

  test("the in-flight guard is not permanently stuck after a rejecting unregister", async () => {
    const loc = fakeRecoveryLocation()
    const serviceWorker = {
      getRegistrations: async () => [{ unregister: async () => (await Promise.reject(new Error("boom")), true) }],
    }
    await recoverFromCloudflareAccessSessionExpiry({ location: loc, serviceWorker, cacheBust: () => "seed" })
    expect(loc.calls.replace).toHaveLength(1)
    // After a reset (navigation semantics seam), a fresh recovery must proceed.
    resetCloudflareRecoveryInFlight()
    const loc2 = fakeRecoveryLocation()
    await recoverFromCloudflareAccessSessionExpiry({ location: loc2, serviceWorker, cacheBust: () => "seed" })
    expect(loc2.calls.replace).toHaveLength(1)
  })

  // --- item 6: real-default-path (no injected cacheBust) ---
  test("default cacheBust produces a non-empty __cf_access_recover value", async () => {
    const loc = fakeRecoveryLocation({
      origin: "http://localhost:4096",
      pathname: "/session/abc",
      search: "",
      hash: "",
    })
    await recoverFromCloudflareAccessSessionExpiry({ location: loc })
    expect(loc.calls.replace).toHaveLength(1)
    const target = loc.calls.replace[0] ?? ""
    const value = new URL(target, loc.origin).searchParams.get("__cf_access_recover")
    expect(value).toBeTruthy()
    expect(value?.length ?? 0).toBeGreaterThan(0)
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

  // --- item 9: the wrapper forwards its injected location seam to recover ---
  test("forwards the injected location to recover (received.location === loc)", async () => {
    const loc = fakeRecoveryLocation({ origin, pathname: "/session/abc", search: "", hash: "" })
    let received: { location?: unknown } | undefined
    const cfResponse = fakeResponse({ status: 403, headers: { "cf-mitigated": "challenge" } })
    const guarded = createGuardedFetch(fakeBaseFetch(cfResponse), {
      location: loc,
      recover: async (deps) => {
        received = deps
      },
    })
    await guarded("http://localhost:4096/api/session")
    expect(received?.location).toBe(loc)
  })

  // --- item 10: Request-object input still takes the 401 → /login path ---
  test("a same-origin 401 for a Request-object input still redirects to /login", async () => {
    const loc = fakeRecoveryLocation({ origin, pathname: "/session/abc", search: "", hash: "" })
    let recovered = 0
    const unauthorized = fakeResponse({ status: 401, url: `${origin}/api/session` })
    const guarded = createGuardedFetch(fakeBaseFetch(unauthorized), {
      location: loc,
      recover: async () => {
        recovered += 1
      },
    })
    const result = await guarded(new Request("http://localhost:4096/api/session"))
    expect(recovered).toBe(0)
    expect(loc.calls.href).toHaveLength(1)
    expect(loc.calls.href[0]).toBe("/login?redirect=%2Fsession%2Fabc")
    expect(result).toBe(unauthorized)
  })

  // --- item 6 (default wiring): exercise the DEFAULT recover path (no injected recover) ---
  test("uses the default recover wiring when none is injected (CF response, no crash)", async () => {
    // No `recover` dep → the real recoverFromCloudflareAccessSessionExpiry runs.
    // happy-dom exposes no navigator.serviceWorker, so recovery skips SW and calls
    // loc.replace synchronously via the injected location seam.
    const loc = fakeRecoveryLocation({ origin, pathname: "/session/abc", search: "", hash: "" })
    const cfResponse = fakeResponse({ status: 403, headers: { "cf-mitigated": "challenge" } })
    const guarded = createGuardedFetch(fakeBaseFetch(cfResponse), { location: loc })
    const result = await guarded("http://localhost:4096/api/session")
    expect(result).toBe(cfResponse)
    // Give the fire-and-forget recover microtask a tick to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(loc.calls.replace).toHaveLength(1)
    const value = new URL(loc.calls.replace[0] ?? "", loc.origin).searchParams.get("__cf_access_recover")
    expect(value).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Plan 136 E2 RED — redirect: "manual" wiring on the regular SDK call path.
//
// These tests capture the actual Request object that reaches baseFetch and
// assert its .redirect property is "manual". This is distinct from the plan-132
// tests above, which supply an already-opaque mock Response and test the
// classifier. The tests below prove the WIRING gap: current code never sets
// redirect in createSdkForServer's config, so the Request defaults to
// redirect="follow". E3 will add `redirect: "manual"` to the config, turning
// these RED tests GREEN.
// ---------------------------------------------------------------------------

describe("createSdkForServer — redirect mode on Request reaching baseFetch (Plan 136 E2)", () => {
  test("regular SDK call: Request reaching baseFetch has redirect === 'manual'", async () => {
    // Spy sits at baseFetch level — NOT inside createGuardedFetch — so it captures
    // the Request exactly as the SDK constructed it, with .redirect already baked in.
    let capturedRequest: Request | undefined
    const spyFetch = async (input: Parameters<typeof fetch>[0]) => {
      capturedRequest = input instanceof Request ? input : new Request(input)
      // Return a minimal valid JSON response so the SDK parser does not throw.
      return new Response("{}", { status: 200 })
    }
    const sdk = createSdkForServer({
      server: { url: "http://localhost:4096" },
      fetch: spyFetch as typeof fetch,
    })
    // global.health() is a GET — the lowest-friction regular (non-SSE) call.
    await sdk.global.health()
    // MUST FAIL on current code: redirect defaults to "follow" because
    // createSdkForServer does not yet pass redirect:"manual" in the config.
    // MUST PASS after E3 adds redirect:"manual" to createSdkForServer's config.
    expect(capturedRequest?.redirect).toBe("manual")
  })
})
