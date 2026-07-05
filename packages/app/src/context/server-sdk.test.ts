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
import { coalesceServerEvents, enqueueServerEvent, isUnauthorizedSseError, resumeStreamAfterPageShow } from "./server-sdk"
import type { Event } from "@opencode-ai/sdk/v2/client"

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
