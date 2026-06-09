// Pure utility functions used by the login page.
// Kept in a separate module so they can be imported and tested
// without loading the SolidJS component tree.

// Only accept relative paths to prevent open redirect.
// Decodes URL encoding before checking to prevent %2F%2F bypass.
export function safeRedirect(value: string | undefined | null): string {
  if (!value) return "/"
  const trimmed = value.trim()
  let decoded: string
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    return "/"
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) return "/"
  return decoded
}

// Returns the URL to redirect to when an auth_token is already present in the
// URL query params (fast-path, e.g. back-navigation or bookmarked post-login URL).
// Returns null when no auth_token is present.
// Exported as a pure helper so it can be unit-tested without a SolidJS renderer.
export function buildFastPathRedirect(params: URLSearchParams): string | null {
  const existingToken = params.get("auth_token")
  if (!existingToken) return null
  const target = safeRedirect(params.get("redirect"))
  const separator = target.includes("?") ? "&" : "?"
  return `${target}${separator}auth_token=${encodeURIComponent(existingToken)}`
}

// Probe the server health endpoint with the given Basic-auth credentials.
// Returns "ok" on 2xx, "unauthorized" on 401, or "unreachable" for
// network errors and any other status we don't want to loop on.
// Network errors are absorbed here so callers don't need try/catch.
export async function probeCredentials(
  serverUrl: string,
  token: string,
): Promise<"ok" | "unauthorized" | "unreachable"> {
  const res = await fetch(`${serverUrl}/api/health`, {
    headers: { Authorization: `Basic ${token}` },
  }).catch(() => null)
  if (!res) return "unreachable"
  if (res.status === 401) return "unauthorized"
  if (res.ok) return "ok"
  return "unreachable"
}
