// Workbox `navigateFallbackAllowlist` for the PWA service worker.
//
// Only paths matching one of these patterns receive the SPA navigation
// fallback (`/index.html`) when an active service worker controls the client.
// All other paths (API, events, etc.) pass through to the network.
//
// This constant is the single source of truth: `vite.config.ts` imports it
// into the `VitePWA({ workbox: { navigateFallbackAllowlist } })` option so the
// allowlist is assertable in tests without evaluating the full Vite config.
//
// SPA routes (from app.tsx / entry.tsx Route definitions):
//   - `/`                       (root)
//   - `/:dir/session/:id?`      (session view)
//   - `/login`                  (custom login page rendered by entry.tsx)
//   - `/new-session`            (draft route)
//   - `/:dir`                   (bare directory; `:dir` is a URL-safe base64 slug,
//                                a single `[A-Za-z0-9_-]+` segment — see
//                                packages/core/src/util/encode.ts). The negative
//                                lookahead excludes `/doc`, the one auth-protected
//                                single-segment server route reachable by top-level
//                                navigation (server.ts docRoute). Other API
//                                single-segment paths are SSE/fetch/WS, never
//                                navigation requests, so the SW fallback never fires.
export const navigateFallbackAllowlist = [
  /^\/$/,
  /^\/[^/]+\/session(\/[^/]+)?$/,
  /^\/login$/,
  /^\/new-session$/,
  /^\/(?!doc$)[A-Za-z0-9_-]+$/,
]

// Workbox `navigateFallbackDenylist` for the PWA service worker.
//
// Workbox evaluates the denylist with precedence over the allowlist, so any
// navigation matching one of these patterns bypasses the SPA `/index.html`
// fallback and reaches the network/edge — even if the allowlist would match it.
//
// `/cdn-cgi` is Cloudflare's reserved edge path. Cloudflare Access reauth
// document navigations (e.g. `/cdn-cgi/access/authorized`, `/cdn-cgi/access/login`)
// MUST reach the CF edge to complete the challenge; serving the cached SPA shell
// for them is the root cause of the session-reload loop. The pattern covers the
// reserved root itself (`/cdn-cgi`, no trailing slash) as well as any sub-path or
// query (`/cdn-cgi/`, `/cdn-cgi/access/login`, `/cdn-cgi?x=1`) by anchoring on a
// boundary — `[/?]` or end of string — so a lookalike SPA slug like
// `/cdn-cgi-console` is NOT denied. This is the single source of truth:
// `vite.config.ts` imports it into `VitePWA({ workbox: { navigateFallbackDenylist } })`.
export const navigateFallbackDenylist = [/^\/cdn-cgi(?:[/?]|$)/]
