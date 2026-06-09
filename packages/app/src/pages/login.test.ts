/**
 * @spec-handoff
 * @interface safeRedirect(value: string | undefined | null): string
 * @interface probeCredentials(serverUrl: string, token: string): Promise<"ok" | "unauthorized" | "unreachable">
 * @interface buildFastPathRedirect(params: URLSearchParams): string | null
 * @behavior
 *   - safeRedirect: returns "/" for null, undefined, or empty string
 *   - safeRedirect: returns "/" for paths that do not start with "/" or start with "//"
 *   - safeRedirect: returns trimmed path unchanged for valid relative paths
 *   - safeRedirect: decodes URL encoding before checking (%2F%2F bypass blocked)
 *   - probeCredentials: returns "unauthorized" when fetch responds with 401
 *   - probeCredentials: returns "ok" when fetch responds with any 2xx status
 *   - probeCredentials: returns "unreachable" when fetch throws a network error
 *   - probeCredentials: returns "unreachable" for non-401 error status codes
 *   - buildFastPathRedirect: returns null when no auth_token param present
 *   - buildFastPathRedirect: appends auth_token to valid redirect target
 *   - buildFastPathRedirect: falls back to "/" when no redirect param
 *   - buildFastPathRedirect: blocks open-redirect in the redirect param
 * @edge-cases
 *   - "//evil.com" is rejected by safeRedirect (double-slash open-redirect guard)
 *   - "%2F%2Fevil.com" is rejected by safeRedirect (URL-encoded double-slash bypass)
 *   - External URLs ("http://…") are rejected by safeRedirect
 *   - Query strings on valid paths are preserved by safeRedirect
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { buildFastPathRedirect, probeCredentials, safeRedirect } from "./login-utils"

// ---------------------------------------------------------------------------
// safeRedirect
// ---------------------------------------------------------------------------

describe("safeRedirect", () => {
  test("returns / for null", () => {
    expect(safeRedirect(null)).toBe("/")
  })

  test("returns / for undefined", () => {
    expect(safeRedirect(undefined)).toBe("/")
  })

  test("returns / for empty string", () => {
    expect(safeRedirect("")).toBe("/")
  })

  test("returns / for bare /", () => {
    expect(safeRedirect("/")).toBe("/")
  })

  test("returns the path for a normal relative path", () => {
    expect(safeRedirect("/dashboard")).toBe("/dashboard")
  })

  test("rejects //evil.com (open-redirect via double-slash)", () => {
    expect(safeRedirect("//evil.com")).toBe("/")
  })

  test("rejects an external http URL", () => {
    expect(safeRedirect("http://evil.com")).toBe("/")
  })

  test("preserves query string on a valid path", () => {
    expect(safeRedirect("/path?query=1")).toBe("/path?query=1")
  })

  test('returns "/" for "/\\evil.com" (backslash bypass)', () => {
    expect(safeRedirect("/\\evil.com")).toBe("/")
  })

  test('returns "/" for "/\\/evil.com" (backslash-slash bypass)', () => {
    expect(safeRedirect("/\\/evil.com")).toBe("/")
  })

  test('returns "/" for "%2F%2Fevil.com" (URL-encoded double-slash bypass)', () => {
    expect(safeRedirect("%2F%2Fevil.com")).toBe("/")
  })

  test("returns decoded path for a valid URL-encoded path", () => {
    expect(safeRedirect("%2Fvalid%2Fpath")).toBe("/valid/path")
  })

  test('returns "/" for a value that throws decodeURIComponent (invalid percent sequence)', () => {
    expect(safeRedirect("%invalid%url%25%25")).toBe("/")
  })
})

// ---------------------------------------------------------------------------
// buildFastPathRedirect
// ---------------------------------------------------------------------------

describe("buildFastPathRedirect", () => {
  test("returns null when no auth_token param is present", () => {
    expect(buildFastPathRedirect(new URLSearchParams(""))).toBeNull()
  })

  test("appends auth_token to valid redirect target", () => {
    const params = new URLSearchParams("auth_token=tok123&redirect=%2Fdashboard")
    expect(buildFastPathRedirect(params)).toBe("/dashboard?auth_token=tok123")
  })

  test("falls back to / when no redirect param is present", () => {
    const params = new URLSearchParams("auth_token=tok123")
    expect(buildFastPathRedirect(params)).toBe("/?auth_token=tok123")
  })

  test("blocks open-redirect in redirect param (%2F%2Fevil.com)", () => {
    const params = new URLSearchParams("auth_token=tok123&redirect=%2F%2Fevil.com")
    expect(buildFastPathRedirect(params)).toBe("/?auth_token=tok123")
  })

  test("uses & separator when redirect target already contains a query string", () => {
    const params = new URLSearchParams("auth_token=tok123&redirect=%2Fpage%3Ffoo%3Dbar")
    expect(buildFastPathRedirect(params)).toBe("/page?foo=bar&auth_token=tok123")
  })

  test("percent-encodes auth_token value in output URL", () => {
    // URLSearchParams decodes '+' as a space, so encodeURIComponent produces %20 for the space.
    const params = new URLSearchParams("auth_token=a%2Bb%2Fc%3D&redirect=%2Ffoo")
    expect(buildFastPathRedirect(params)).toBe("/foo?auth_token=a%2Bb%2Fc%3D")
  })
})

// ---------------------------------------------------------------------------
// probeCredentials — uses a mocked fetch
// ---------------------------------------------------------------------------

describe("probeCredentials", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns unauthorized when server responds with 401", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    ) as unknown as typeof fetch
    const result = await probeCredentials("http://localhost:4096", "dGVzdA==")
    expect(result).toBe("unauthorized")
  })

  test("returns ok when server responds with 200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as unknown as typeof fetch
    const result = await probeCredentials("http://localhost:4096", "dGVzdA==")
    expect(result).toBe("ok")
  })

  test("returns ok when server responds with 204", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    ) as unknown as typeof fetch
    const result = await probeCredentials("http://localhost:4096", "dGVzdA==")
    expect(result).toBe("ok")
  })

  test("returns unreachable when fetch rejects (network error)", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    ) as unknown as typeof fetch
    // probeCredentials absorbs the network error internally and returns "unreachable".
    const result = await probeCredentials("http://localhost:4096", "dGVzdA==")
    expect(result).toBe("unreachable")
  })

  test("returns unreachable for a 429 rate-limit response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 429 })),
    ) as unknown as typeof fetch
    const result = await probeCredentials("http://localhost:4096", "dGVzdA==")
    expect(result).toBe("unreachable")
  })

  test("returns unreachable for a 500 server error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 500 })),
    ) as unknown as typeof fetch
    const result = await probeCredentials("http://localhost:4096", "dGVzdA==")
    expect(result).toBe("unreachable")
  })

  test("sends the Authorization header to the /api/health endpoint", async () => {
    const captured = { url: undefined as string | undefined, auth: undefined as string | undefined }
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      captured.url = url
      captured.auth = (init?.headers as Record<string, string>)?.["Authorization"]
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch
    await probeCredentials("http://localhost:4096", "mytoken")
    expect(captured.url).toBe("http://localhost:4096/api/health")
    expect(captured.auth).toBe("Basic mytoken")
  })
})
