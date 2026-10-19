/**
 * @spec-handoff
 * @interface selectArchivedSessionsView(input): ArchivedSessionsView
 * @behavior
 *   - Distinguishes a filtered nonempty page with no visible rows from a genuinely empty page.
 *   - Disables every paging action while a restore is pending.
 * @edge-cases
 *   - Loading and error states expose their own view messages.
 * @see RFC 057 Addendum C.3 and C.6
 */
import { expect, test } from "bun:test"
import { selectArchivedSessionsView } from "./archived-sessions-view"

test("selects no-match only when a nonempty ready page is filtered to zero rows", () => {
  expect(selectArchivedSessionsView({ status: "ready", visibleSessionCount: 0, filter: "missing" })).toMatchObject({
    message: "no-match",
  })
  expect(selectArchivedSessionsView({ status: "ready", visibleSessionCount: 0, filter: "  " })).toMatchObject({
    message: "page-empty",
  })
  expect(selectArchivedSessionsView({ status: "ready", visibleSessionCount: 1, filter: "missing" })).toMatchObject({
    message: undefined,
  })
})

test("selects loading and error messages independently of page controls", () => {
  expect(selectArchivedSessionsView({ status: "loading", visibleSessionCount: 0, filter: "" })).toEqual({
    message: "loading",
    previousEnabled: false,
    nextEnabled: false,
    resetEnabled: false,
  })
  expect(selectArchivedSessionsView({ status: "error", visibleSessionCount: 0, filter: "missing" })).toEqual({
    message: "error",
    previousEnabled: false,
    nextEnabled: false,
    resetEnabled: false,
  })
})

test("enables ready-page controls from cursors and locks them during restore", () => {
  expect(selectArchivedSessionsView({ status: "ready", visibleSessionCount: 1, filter: "", previousCursor: "previous", nextCursor: "next" })).toEqual({
    message: undefined,
    previousEnabled: true,
    nextEnabled: true,
    resetEnabled: true,
  })
  expect(selectArchivedSessionsView({ status: "ready", visibleSessionCount: 1, filter: "", previousCursor: "previous", nextCursor: "next", restoringID: "session-1" })).toEqual({
    message: undefined,
    previousEnabled: false,
    nextEnabled: false,
    resetEnabled: false,
  })
})
