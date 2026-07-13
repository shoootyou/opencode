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
 *
 * ---------------------------------------------------------------------------
 * @spec-handoff (E2 additive — Cloudflare Access SSE expiry classifier)
 * @interface isCloudflareAccessSessionExpiredSseError(error: unknown): boolean
 *   Pure, synchronous. Returns true ONLY for Error instances whose message
 *   contains an explicit Cloudflare Access/challenge marker (case-insensitive):
 *     /cloudflareaccess\.com/i, /cloudflare access/i, /cf-mitigated/i,
 *     /__cf_chl/i, or /cdn-cgi\/access/i.
 * @behavior (negatives → false)
 *   - "SSE failed: 401 Unauthorized" (owned by isUnauthorizedSseError);
 *   - "SSE failed: 403 Forbidden" (bare 403 is ambiguous — must not loop);
 *   - generic network errors, aborts, stream-closed;
 *   - null, undefined, and non-Error values.
 * @orthogonality
 *   The two classifiers are orthogonal so wiring both branches cannot double-fire:
 *   a 401 SSE error is NOT a CF error, and a CF-marker error is NOT a 401 error
 *   (isUnauthorizedSseError stays false for CF markers with no "401" token).
 * @overlap-ownership (r1 audit remediation)
 *   When a single error message carries BOTH a "401" token AND a Cloudflare
 *   marker (e.g. "SSE failed: 401 Unauthorized redirect to team.cloudflareaccess.com"),
 *   the 401 classifier OWNS it: isUnauthorizedSseError → true and
 *   isCloudflareAccessSessionExpiredSseError → false. The branches are mutually
 *   exclusive with 401 priority, so the wiring resolves to a single owner and the
 *   CF recovery navigation never competes with the /login redirect.
 * @see ../utils/server.ts (recoverFromCloudflareAccessSessionExpiry — the CF branch action)
 */

import { describe, expect, test } from "bun:test"
import { coalesceServerEvents, enqueueServerEvent, isUnauthorizedSseError, resumeStreamAfterPageShow } from "./server-sdk"
import { createSdkForServer } from "@/utils/server"
import type { Event } from "@opencode-ai/sdk/v2/client"

// E2 red phase: isCloudflareAccessSessionExpiredSseError does not exist yet in
// ./server-sdk. A dynamic import binds the missing export to `undefined` so ONLY
// the new Cloudflare SSE tests fail (with "not a function") while the existing
// green tests in this file keep passing. E3 adds the helper.
const { isCloudflareAccessSessionExpiredSseError } = (await import("./server-sdk")) as typeof import("./server-sdk") & {
  isCloudflareAccessSessionExpiredSseError: (error: unknown) => boolean
}

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

// ---------------------------------------------------------------------------
// isCloudflareAccessSessionExpiredSseError — E2 red: classify a Cloudflare
// Access expiry from the generic SSE error, distinct from the textual 401 branch.
// ---------------------------------------------------------------------------

describe("isCloudflareAccessSessionExpiredSseError", () => {
  // --- positive markers (case-insensitive) ---
  test("true for a cloudflareaccess.com marker", () => {
    expect(isCloudflareAccessSessionExpiredSseError(new Error("SSE failed: redirect to team.cloudflareaccess.com"))).toBe(
      true,
    )
  })

  test("true for a cf-mitigated marker", () => {
    expect(isCloudflareAccessSessionExpiredSseError(new Error("SSE failed: cf-mitigated challenge"))).toBe(true)
  })

  test("true for a 'cloudflare access' marker regardless of case", () => {
    expect(isCloudflareAccessSessionExpiredSseError(new Error("SSE failed: Cloudflare Access denied"))).toBe(true)
  })

  test("true for a __cf_chl challenge marker", () => {
    expect(isCloudflareAccessSessionExpiredSseError(new Error("SSE failed: __cf_chl_opt"))).toBe(true)
  })

  test("true for a cdn-cgi/access marker", () => {
    expect(isCloudflareAccessSessionExpiredSseError(new Error("SSE failed: GET /cdn-cgi/access/login"))).toBe(true)
  })

  // --- negatives ---
  test("false for a bare 401 SSE error (owned by isUnauthorizedSseError)", () => {
    expect(isCloudflareAccessSessionExpiredSseError(new Error("SSE failed: 401 Unauthorized"))).toBe(false)
  })

  test("false for a bare 403 SSE error (ambiguous, must not loop)", () => {
    expect(isCloudflareAccessSessionExpiredSseError(new Error("SSE failed: 403 Forbidden"))).toBe(false)
  })

  test("false for a generic network error", () => {
    expect(isCloudflareAccessSessionExpiredSseError(new Error("network down"))).toBe(false)
  })

  test("false for an abort error", () => {
    const abort = new Error("The operation was aborted")
    abort.name = "AbortError"
    expect(isCloudflareAccessSessionExpiredSseError(abort)).toBe(false)
  })

  test("false for a stream-closed error", () => {
    expect(isCloudflareAccessSessionExpiredSseError(new Error("stream closed"))).toBe(false)
  })

  test("false for null, undefined, and non-Error values", () => {
    expect(isCloudflareAccessSessionExpiredSseError(null)).toBe(false)
    expect(isCloudflareAccessSessionExpiredSseError(undefined)).toBe(false)
    expect(isCloudflareAccessSessionExpiredSseError("cloudflareaccess.com")).toBe(false)
    expect(isCloudflareAccessSessionExpiredSseError(403)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Orthogonality: the 401 classifier and the Cloudflare classifier must never
// both fire on the same error, so wiring both SSE branches cannot double-fire.
// ---------------------------------------------------------------------------

describe("SSE classifier orthogonality (401 vs Cloudflare)", () => {
  test("a 401 SSE error is a 401 but not a Cloudflare error", () => {
    const error = new Error("SSE failed: 401 Unauthorized")
    expect(isUnauthorizedSseError(error)).toBe(true)
    expect(isCloudflareAccessSessionExpiredSseError(error)).toBe(false)
  })

  test("a Cloudflare marker error is a Cloudflare error but not a 401 error", () => {
    const error = new Error("SSE failed: redirect to team.cloudflareaccess.com/cdn-cgi/access/login")
    expect(isCloudflareAccessSessionExpiredSseError(error)).toBe(true)
    expect(isUnauthorizedSseError(error)).toBe(false)
  })

  // --- item 11: overlap ownership — an error carrying BOTH a 401 token AND a CF
  //     marker must be owned by the 401 classifier (mutually-exclusive branches,
  //     401 has priority so the two SSE branches cannot double-fire). ---
  test("an error with BOTH a 401 token and a Cloudflare marker is owned by 401", () => {
    const error = new Error("SSE failed: 401 Unauthorized redirect to team.cloudflareaccess.com")
    // 401 owns it.
    expect(isUnauthorizedSseError(error)).toBe(true)
    // The CF classifier must yield ownership so the wiring resolves to a single owner.
    expect(isCloudflareAccessSessionExpiredSseError(error)).toBe(false)
  })
})

describe("coalesceServerEvents", () => {
  const delta = (value: string, field = "text", partID = "part") => ({
    directory: "/repo",
    payload: {
      type: "message.part.delta",
      properties: { messageID: "msg", partID, field, delta: value },
    } as Event,
  })

  test("merges adjacent deltas for the same field", () => {
    const first = delta("hello ")
    const second = delta("world")
    first.payload.id = "first"
    second.payload.id = "second"
    const result = coalesceServerEvents([first, second])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ id: "second", properties: { delta: "hello world" } })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
  })

  test("preserves event ID order across interleaved deltas", () => {
    const first = delta("a")
    const other = delta("b", "text", "other")
    const last = delta("c")
    first.payload.id = "1"
    other.payload.id = "2"
    last.payload.id = "3"

    const result = coalesceServerEvents([first, other, last])

    expect(result.map((event) => event.payload.id)).toEqual(["1", "2", "3"])
  })
})

describe("enqueueServerEvent", () => {
  const partUpdated = (text: string) =>
    ({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "part", sessionID: "session", messageID: "message", type: "text", text },
      },
    }) as Event

  test("preserves part updates across message remove and re-add barriers", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({ type: "message.removed", properties: { sessionID: "session", messageID: "message" } } as Event)
    enqueue({
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "message",
          sessionID: "session",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
      },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.removed",
      "message.updated",
      "message.part.updated",
    ])
  })

  test("preserves deltas after a replacement snapshot", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("a"))
    enqueue(partUpdated("ab"))
    enqueue({
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: "c" },
    } as Event)

    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.type)).toEqual(["message.part.updated", "message.part.delta"])
    expect(result[0]?.payload).toMatchObject({ properties: { part: { text: "ab" } } })
    expect(result[1]?.payload).toMatchObject({ properties: { delta: "c" } })
  })

  test("preserves updates after session deletion", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "session.deleted",
      "message.part.updated",
    ])
  })

  test("does not coalesce edge-triggered session statuses", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (status: "retry" | "busy") =>
      enqueueServerEvent(events, {
        directory: "/repo",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "session",
            status: status === "retry" ? { type: "retry", attempt: 1, message: "retry", next: 1 } : { type: "busy" },
          },
        } as Event,
      })

    enqueue("retry")
    enqueue("busy")

    expect(events).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Plan 136 E2 RED — redirect: "manual" wiring on the SSE (eventSdk) path.
//
// Captures the actual Request reaching baseFetch on the SSE call path and
// asserts .redirect === "manual". Must fail on current code (redirect defaults
// to "follow" because createSdkForServer does not yet set redirect:"manual").
// Must pass after E3 without modification.
// ---------------------------------------------------------------------------

describe("createSdkForServer — SSE path: Request reaching baseFetch has redirect === 'manual' (Plan 136 E2)", () => {
  test("SSE (eventSdk) path: Request reaching baseFetch has redirect === 'manual'", async () => {
    // Spy at baseFetch level: captures the Request before createGuardedFetch's wrapper
    // returns it up the chain. Returns a null-body 200 so the SSE generator immediately
    // throws "No body in SSE response"; sseMaxRetryAttempts:0 stops the retry loop so
    // the test does not block. capturedRequest is already set at that point.
    let capturedRequest: Request | undefined
    const spyFetch = async (input: Parameters<typeof fetch>[0]) => {
      capturedRequest = input instanceof Request ? input : new Request(input)
      return new Response(null, { status: 200 })
    }
    const sdk = createSdkForServer({
      server: { url: "http://localhost:4096" },
      fetch: spyFetch as typeof fetch,
    })
    // global.event() is the SSE call. sseMaxRetryAttempts:0 ensures the generator
    // exits after the first failed fetch so stream.next() resolves promptly.
    const result = await sdk.global.event({ sseMaxRetryAttempts: 0 } as never)
    // Advance the async generator one step: this triggers the first _fetch(request)
    // call inside createStream(), setting capturedRequest before the generator
    // throws for the missing body and terminates.
    await result.stream.next()
    // MUST FAIL on current code: redirect defaults to "follow".
    // MUST PASS after E3 adds redirect:"manual" to createSdkForServer's config.
    expect(capturedRequest?.redirect).toBe("manual")
  })
})
