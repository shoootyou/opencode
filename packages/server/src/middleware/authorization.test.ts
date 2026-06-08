/**
 * @spec-handoff
 * @behavior
 *   - authorizationLayer (API-only): authorized passthrough → bare 401 (no 302
 *     browser redirect, no www-authenticate header).
 * @note Full integration tests for authorizationLayer require a running Effect
 *   HTTP server with ServerAuth.Config and UnauthorizedError layers wired in —
 *   out of scope for unit tests; validated end-to-end via dev server smoke
 *   tests. The isBrowserRequest / safeRedirectPath helpers and the 302
 *   browser-redirect model were removed in RFC 017 (E7); their unit tests are
 *   gone with them.
 */

import { describe, test } from "bun:test"

describe("authorizationLayer (packages/server middleware) — documented gap", () => {
  test.todo("unauthorized request → bare 401, no www-authenticate header", () => {})
  test.todo("authorizationLayer never issues a 302 redirect", () => {})
})
