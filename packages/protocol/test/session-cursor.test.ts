/**
 * @spec-handoff
 * @interface SessionsQuery { archived?: boolean }
 * @behavior
 *   - Session-list requests accept an explicit archived=true inclusion flag.
 *   - Omitting archived preserves the active-only server default.
 * @edge-cases
 *   - The flag composes with cursor, roots, and limit rather than replacing them.
 * @see ../src/groups/session.ts
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Schema } from "effect"
import { SessionsCursor, SessionsQuery } from "../src/groups/session.js"
import { Session } from "@opencode/schema/session"

describe("SessionsCursor", () => {
  test("round trips without Node globals", async () => {
    const input = {
      workspace: undefined,
      search: "protocol",
      order: "desc" as const,
      anchor: { id: Session.ID.make("ses_test"), time: 1, direction: "next" as const },
    }
    const cursor = SessionsCursor.make(input)

    expect(await Effect.runPromise(SessionsCursor.parse(cursor))).toEqual(input)
  })
})

test("accepts explicit archived inclusion alongside the root-only query", () => {
  expect(
    Schema.decodeUnknownSync(SessionsQuery)({
      archived: "true",
      parentID: "null",
    }),
  ).toMatchObject({ archived: true, parentID: null })
})
