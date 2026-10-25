/**
 * @spec-handoff
 * @interface selectArchivedSessionsView(input): ArchivedSessionsView
 * @behavior
 *   - Separates initial loading/error from continuation pending/error while retaining loaded rows.
 *   - Exposes only Load more or Retry for a stored next cursor and never pager controls.
 * @edge-cases
 *   - A loaded zero-match filter remains eligible for Load more; restore pending disables continuation.
 * @see RFC 057 D.3.2, D.3.17-18
 */
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: assertions intentionally view the old page-shaped return as opaque until the accepted continuous-list result type exists.
import { expect, test } from "bun:test"
import { selectArchivedSessionsView } from "./archived-sessions-view"

test("selects loaded empty and no-match copy without page-scoped actions", () => {
  expect(
    selectArchivedSessionsView({ status: "ready", visibleSessionCount: 0, filter: "missing" }) as unknown,
  ).toMatchObject({
    message: "loaded-no-match",
  })
  expect(selectArchivedSessionsView({ status: "ready", visibleSessionCount: 0, filter: "" }) as unknown).toMatchObject({
    message: "loaded-empty",
  })
})

test("offers Load more for a continuation cursor even when search has zero matches", () => {
  expect(
    selectArchivedSessionsView({
      status: "ready",
      visibleSessionCount: 0,
      filter: "absent",
      nextCursor: "cursor-2",
    }) as unknown,
  ).toEqual({ message: "loaded-no-match", loadMoreEnabled: true, retryEnabled: false })
})

test("replaces Load more with same-cursor Retry after a continuation failure and disables it during restore", () => {
  expect(
    selectArchivedSessionsView({
      status: "ready",
      visibleSessionCount: 2,
      filter: "",
      nextCursor: "cursor-2",
      continuationError: new Error("failed"),
    }) as unknown,
  ).toEqual({ message: undefined, loadMoreEnabled: false, retryEnabled: true })
  expect(
    selectArchivedSessionsView({
      status: "ready",
      visibleSessionCount: 2,
      filter: "",
      nextCursor: "cursor-2",
      restoringID: "row-1",
    }) as unknown,
  ).toEqual({ message: undefined, loadMoreEnabled: false, retryEnabled: false })
})
