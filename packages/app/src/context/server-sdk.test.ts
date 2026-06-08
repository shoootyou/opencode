/**
 * @spec-handoff
 * @interface isUnauthorizedSseError(error: unknown): boolean
 * @behavior
 *   - Returns true when error is an Error whose message indicates HTTP 401.
 *   - The SSE stream throws a generic Error with the shape
 *     `SSE failed: ${status} ${statusText}` (confirmed at
 *     packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts:131). For a 401 the
 *     message is exactly "SSE failed: 401 Unauthorized".
 *   - Detection is string-based against error.message using a word-boundary 401 match
 *     (the accepted fallback per RFC 017 B2/D7, since the thrown error carries no
 *     structured status field).
 *   - Returns false for non-401 status messages ("SSE failed: 500 ..."), generic
 *     network errors, and non-Error values.
 * @edge-cases
 *   - new Error("SSE failed: 401 Unauthorized") → true
 *   - new Error("SSE failed: 500 Internal Server Error") → false
 *   - new Error("network down") → false
 *   - "not an error" (string, not an Error) → false
 *   - null / undefined → false
 *   - A 401 substring must match on word boundary: "SSE failed: 1401 ..." → false
 * @testability
 *   - isUnauthorizedSseError MUST be importable from "./server-sdk" without triggering
 *     a failure at module load. The existing test in this file already imports
 *     resumeStreamAfterPageShow from server-sdk.tsx and runs green under
 *     `bun test --preload ./happydom.ts`, so co-locating this pure helper there is
 *     acceptable. If a future UI import makes the module explode at load, extract
 *     isUnauthorizedSseError to a plain .ts sibling and re-export it.
 *   - The SSE error guard wiring (calling redirectToLogin in onSseError and the
 *     for-await catch when isUnauthorizedSseError(error) && shouldRedirectToLogin(...))
 *     is integration-level and not unit-tested here; its decision is fully covered by
 *     isUnauthorizedSseError (this file) + shouldRedirectToLogin (server.test.ts).
 * @see ./server-sdk.tsx
 * @see ../utils/server.ts (shouldRedirectToLogin + redirectToLogin shared by the guard)
 */

import { describe, expect, test } from "bun:test"
import { isUnauthorizedSseError, resumeStreamAfterPageShow } from "./server-sdk"

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// isUnauthorizedSseError — D7: detect a 401 from the generic SSE error
// ---------------------------------------------------------------------------

describe("isUnauthorizedSseError", () => {
  test("true for the real SDK 401 message shape", () => {
    expect(isUnauthorizedSseError(new Error("SSE failed: 401 Unauthorized"))).toBe(true)
  })

  test("false for a 500 SSE failure", () => {
    expect(isUnauthorizedSseError(new Error("SSE failed: 500 Internal Server Error"))).toBe(false)
  })

  test("false for a generic network error", () => {
    expect(isUnauthorizedSseError(new Error("network down"))).toBe(false)
  })

  test("false for a non-Error value", () => {
    expect(isUnauthorizedSseError("not an error")).toBe(false)
  })

  test("false for null and undefined", () => {
    expect(isUnauthorizedSseError(null)).toBe(false)
    expect(isUnauthorizedSseError(undefined)).toBe(false)
  })

  test("does not match 401 embedded in a larger number (word boundary)", () => {
    expect(isUnauthorizedSseError(new Error("SSE failed: 1401 Weird"))).toBe(false)
  })
})
