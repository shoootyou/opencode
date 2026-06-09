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

  // 401 guard (RFC 017 section B): the returned OpencodeClient hides the raw
  // client's response interceptors (`client` is protected), so we wrap fetch
  // instead. On a same-origin 401 we navigate to /login, replacing the
  // server-side 302 that used to do this. The decision is delegated to the
  // unit-tested shouldRedirectToLogin so this wiring stays trivial.
  const baseFetch = config.fetch ?? fetch
  const guardedFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await baseFetch(input, init)
      const requestUrl = input instanceof Request ? input.url : input.toString()
      if (response.status === 401 && shouldRedirectToLogin(requestUrl, location.origin, location.pathname))
        redirectToLogin()
      return response
    },
    { preconnect: fetch.preconnect },
  )

  return createOpencodeClient({
    ...config,
    fetch: guardedFetch,
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
