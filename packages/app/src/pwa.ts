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
export const navigateFallbackAllowlist = [/^\/$/, /^\/[^/]+\/session(\/[^/]+)?$/, /^\/login$/]
