/**
 * @spec-handoff
 * @interface SessionsQuery({ archived?: boolean | "only", cursor?: SessionsCursor }): SessionsQuery
 * @behavior
 *   - Decodes only the literal query strings "true", "false", and "only" for archived.
 *   - Carries archived with scope, order, and search in an opaque cursor.
 *   - Uses cursor-carried fields rather than contradictory follow-up query fields.
 * @edge-cases
 *   - A legacy cursor without archived remains valid.
 *   - Malformed cursors are rejected.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionsCursor, SessionsQuery } from "../src/groups/session.js"
import { Session } from "@opencode/schema/session"

describe("session archive cursor contract", () => {
  test("decodes archived from literal boolean query strings rather than truthiness", () => {
    expect(Schema.decodeUnknownSync(SessionsQuery)({ archived: "true" })).toMatchObject({ archived: true })
    expect(Schema.decodeUnknownSync(SessionsQuery)({ archived: "false" })).toMatchObject({ archived: false })
    expect(Schema.decodeUnknownSync(SessionsQuery)({ archived: "only" })).toMatchObject({ archived: "only" })
    expect(() => Schema.decodeUnknownSync(SessionsQuery)({ archived: "yes" })).toThrow()
  })

  test("round trips archived with search, order, and scope", async () => {
    const input = {
      archived: "only" as const,
      search: "protocol",
      order: "desc" as const,
      parentID: null,
      anchor: { id: Session.ID.make("ses_archive_cursor"), time: 1, direction: "next" as const },
    }

    expect(await Effect.runPromise(SessionsCursor.parse(SessionsCursor.make(input)))).toEqual(input)
  })

  test("preserves an old cursor that predates archived", async () => {
    const oldCursor = SessionsCursor.make({
      search: "legacy",
      order: "asc" as const,
      anchor: { id: Session.ID.make("ses_legacy_cursor"), time: 2, direction: "previous" as const },
    })

    expect(await Effect.runPromise(SessionsCursor.parse(oldCursor))).toEqual({
      search: "legacy",
      order: "asc",
      anchor: { id: Session.ID.make("ses_legacy_cursor"), time: 2, direction: "previous" },
    })
  })

  test("rejects malformed cursors", async () => {
    await expect(Effect.runPromise(SessionsCursor.parse("not-a-cursor"))).rejects.toBe("Invalid cursor")
  })
})
