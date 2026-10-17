// Workbox `navigateFallbackAllowlist` for the PWA service worker.
//
// Only paths matching one of these patterns receive the SPA navigation
// fallback (`/index.html`) when an active service worker controls the client.
// All other paths (API, events, etc.) pass through to the network.
//
// This constant is the single source of truth: `vite.pwa.ts` imports it
// into the `VitePWA({ workbox: { navigateFallbackAllowlist } })` option so the
// allowlist is assertable in tests without evaluating the full Vite config.
//
// SPA routes (from shell/routes/routes.tsx):
//   - `/`                       (root)
//   - `/server/:key/session/:id` (session view)
//   - `/login`                  (custom login page)
//   - `/settings`               (settings)
//   - `/new-session`            (draft route)
//   - `/:slug`                  (ordinary single-segment SPA navigation)
export const navigateFallbackAllowlist = [
  /^\/$/,
  /^\/login$/,
  /^\/settings$/,
  /^\/new-session$/,
  /^\/server\/[^/]+\/session\/[^/]+$/,
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
// `vite.pwa.ts` imports it into `VitePWA({ workbox: { navigateFallbackDenylist } })`.
export const navigateFallbackDenylist = [
  /^\/api(?:[/?]|$)/,
  /^\/auth(?:[/?]|$)/,
  /^\/cdn-cgi(?:[/?]|$)/,
  /^\/doc(?:[/?]|$)/,
  /^\/openapi\.json(?:[?]|$)/,
]
