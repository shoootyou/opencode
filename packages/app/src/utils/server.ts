import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

// ---------------------------------------------------------------------------
// 401 → /login redirect (RFC 017 section B). Pure decision helpers below take
// location data as plain arguments so they can be imported and unit-tested
// without touching globals or loading any SolidJS/Kobalte UI module.
// ---------------------------------------------------------------------------

// Builds the full-document redirect target, preserving the current path and
// search so the login page can return the user where they were (D5).
export function buildLoginRedirectUrl(pathname: string, search: string): string {
  return `/login?redirect=${encodeURIComponent(pathname + search)}`
}

// Decides whether a 401 should trigger a navigation to /login (D6).
// Only redirects for same-origin requests (multi-server safety) and never when
// already on /login (loop guard).
export function shouldRedirectToLogin(requestUrl: string, currentOrigin: string, currentPathname: string): boolean {
  if (currentPathname === "/login") return false
  return new URL(requestUrl).origin === currentOrigin
}

// Module-level debounce guard (B5): once a redirect is in flight, suppress any
// further redirects until the document actually navigates away.
let redirectInFlight = false

// Navigates the document to /login. Accepts an injectable location-like object
// because happy-dom's real `location` is immutable in the test harness; defaults
// to window.location in the browser.
export function redirectToLogin(loc: { origin: string; pathname: string; search: string; href: string } = location): void {
  if (redirectInFlight) return
  if (loc.pathname === "/login") return
  redirectInFlight = true
  loc.href = buildLoginRedirectUrl(loc.pathname, loc.search)
}

// Test-only seam to clear the module-level redirectInFlight guard between tests.
export function resetRedirectInFlight(): void {
  redirectInFlight = false
}

// ---------------------------------------------------------------------------
// Cloudflare Access session-expiry recovery (E3). Complementary to the 401→
// /login path above: when the Cloudflare Access session behind a self-hosted
// deployment expires, the edge answers app requests with an opaque redirect, a
// cross-origin redirect to the Access login host, or a 403 challenge page rather
// than the app's own 401. Those responses must trigger a full-document reload
// that bypasses the PWA service worker so the browser follows the edge redirect.
// ---------------------------------------------------------------------------

// Markers that identify a Cloudflare Access challenge/redirect in a response
// body or an error message (case-insensitive).
const CLOUDFLARE_ACCESS_MARKER = /cloudflareaccess\.com|cloudflare access|cf-mitigated|__cf_chl|cdn-cgi\/access/i

type RecoveryLocation = {
  origin: string
  pathname: string
  search: string
  hash: string
  href: string
  replace(url: string): void
  reload(): void
}

// Classifies a fetch response as a Cloudflare Access session-expiry signal.
// Async only because the 403 body-marker check reads response.clone().text().
// Never consumes the original body (uses clone) and returns false for HTTP 401,
// which stays owned by the existing 401 → /login branch.
export async function isCloudflareAccessSessionExpiredResponse(
  response: Response,
  currentOrigin: string,
): Promise<boolean> {
  if (response.type === "opaqueredirect") return true
  if (response.status === 401) return false
  if (response.redirected) {
    const url = URL.parse(response.url)
    if (
      url &&
      (url.origin !== currentOrigin ||
        url.hostname === "cloudflareaccess.com" ||
        url.hostname.endsWith(".cloudflareaccess.com"))
    )
      return true
  }
  if (response.status !== 403) return false
  if (response.headers.has("cf-mitigated")) return true
  // Gate body-marker inspection on content-type: only an HTML challenge page is a
  // real Access signal. A JSON/API 403 whose payload merely mentions a CF string
  // must NOT be treated as expiry, so false positives can't trigger a reload loop.
  const contentType = response.headers.get("content-type")
  if (!contentType || !contentType.includes("text/html")) return false
  return CLOUDFLARE_ACCESS_MARKER.test(await response.clone().text())
}

// Module-level guard so a burst of expiry signals across fetch and SSE triggers
// a single recovery navigation (module singletons persist across the app's life).
let cloudflareRecoveryInFlight = false

// Full-document recovery that bypasses the PWA service worker: unregister the
// workers so the browser makes a fresh network request, then location.replace()
// the current URL (no history entry) with a cache-bust param so the edge can
// issue its Access redirect. Dependencies are injectable for testing; defaults
// read the real browser globals and guard for non-browser environments.
export async function recoverFromCloudflareAccessSessionExpiry(
  deps: {
    location?: RecoveryLocation
    serviceWorker?: { getRegistrations(): Promise<ReadonlyArray<{ unregister(): Promise<boolean> }>> }
    cacheBust?: () => string
  } = {},
): Promise<void> {
  const loc = deps.location ?? location
  // Cross-document loop cap: if this document already arrived via a recovery
  // reload it carries __cf_access_recover, so a second recovery is a no-op. Without
  // this, an edge that keeps re-challenging would spin an infinite reload loop
  // across document lifecycles. Checked before the guard so it never locks it.
  if (new URLSearchParams(loc.search).has("__cf_access_recover")) return
  if (cloudflareRecoveryInFlight) return
  // Set synchronously before the first await so concurrent callers are debounced.
  cloudflareRecoveryInFlight = true
  const serviceWorker =
    deps.serviceWorker ?? (typeof navigator === "undefined" ? undefined : navigator.serviceWorker)
  const cacheBust = deps.cacheBust ?? (() => Date.now().toString())
  if (serviceWorker) {
    // Resilience: neither a rejecting getRegistrations() nor a rejecting
    // unregister() may block navigation, so swallow both with allSettled and a
    // catch. Recovery MUST still reload even when SW teardown fails.
    const registrations = await serviceWorker.getRegistrations().catch(() => [])
    await Promise.allSettled(registrations.map((registration) => registration.unregister()))
  }
  // Build the target through the URL API so the cache-bust param REPLACES any prior
  // value (no accumulation), the hash is preserved after the search, and a
  // protocol-relative pathname (`//evil`) cannot escape the current origin.
  const target = new URL(loc.pathname + loc.search + loc.hash, loc.origin)
  target.searchParams.set("__cf_access_recover", cacheBust())
  // Defensive same-origin assertion: the origin base should always keep us on
  // origin, but if a parse ever yields a foreign origin, fall back to the root.
  const destination =
    target.origin === loc.origin ? `${target.pathname}${target.search}${target.hash}` : `${loc.origin}/`
  loc.replace(destination)
}

// Test-only seam to clear the module-level cloudflareRecoveryInFlight guard.
export function resetCloudflareRecoveryInFlight(): void {
  cloudflareRecoveryInFlight = false
}

// Wraps a base fetch with the Cloudflare Access recovery check followed by the
// existing 401 → /login guard. The CF check runs first but returns false for a
// plain 401, so the 401 branch is preserved exactly. Retains the Bun-specific
// preconnect property so the result still satisfies `typeof fetch`.
export function createGuardedFetch(
  baseFetch: typeof fetch,
  deps: {
    location?: RecoveryLocation
    recover?: typeof recoverFromCloudflareAccessSessionExpiry
  } = {},
): typeof fetch {
  const loc = deps.location ?? location
  const recover = deps.recover ?? recoverFromCloudflareAccessSessionExpiry
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await baseFetch(input, init)
      const requestUrl = input instanceof Request ? input.url : input.toString()
      if (await isCloudflareAccessSessionExpiredResponse(response, loc.origin)) {
        void recover({ location: loc })
        return response
      }
      if (response.status === 401 && shouldRedirectToLogin(requestUrl, loc.origin, loc.pathname)) redirectToLogin(loc)
      return response
    },
    { preconnect: fetch.preconnect },
  )
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  // 401 + Cloudflare Access guard: the returned OpencodeClient hides the raw
  // client's response interceptors (`client` is protected), so we wrap fetch
  // instead. On a same-origin 401 we navigate to /login (replacing the
  // server-side 302 that used to do this); on a Cloudflare Access expiry signal
  // we recover with a full-document reload. The decisions live in the
  // unit-tested createGuardedFetch so this wiring stays trivial.
  const baseFetch = config.fetch ?? fetch

  return createOpencodeClient({
    ...config,
    // "manual" is required so Cloudflare Access redirects produce an opaqueredirect
    // Response instead of a CORS TypeError, making isCloudflareAccessSessionExpiredResponse's
    // opaqueredirect branch reachable for recovery. Must come after ...config so it
    // deterministically wins over any caller-supplied redirect value.
    redirect: "manual",
    fetch: createGuardedFetch(baseFetch),
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

// Returns the base URL of the opencode server for the current environment.
// - On the opencode.ai hosted domain, the server always runs on localhost:4096.
// - In dev mode, use the Vite env vars (defaulting to localhost:4096).
// - In production (self-hosted), use the page's own origin.
export function getCurrentServerUrl(): string {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}
