/**
 * @spec-handoff
 * @interface selectArchivedSessionsView(input): ArchivedSessionsView
 * @interface selectArchivedSessionsView input gains bulkRunning?: boolean (output stays { message, loadMoreEnabled, retryEnabled })
 * @interface rowAria(input: { on: boolean; selected: boolean; selectable: boolean }): { role?: "checkbox"; "aria-checked"?: "true" | "false"; "aria-disabled"?: "true" }
 * @behavior
 *   - Separates initial loading/error from continuation pending/error while retaining loaded rows.
 *   - Exposes only Load more or Retry for a stored next cursor and never pager controls.
 *   - bulkRunning disables Load more and the continuation Retry like restoringID does; it never affects the status "error" Retry.
 *     Selection mode alone (bulkRunning absent or false) changes nothing.
 *   - rowAria: on=false -> {}; on=true -> role "checkbox" and aria-checked "true"/"false"; aria-disabled "true" only when not selectable.
 * @edge-cases
 *   - A loaded zero-match filter remains eligible for Load more; restore pending disables continuation.
 * @see RFC 057 D.3.2, D.3.17-18
 */
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: assertions intentionally view the old page-shaped return as opaque until the accepted continuous-list result type exists.
import { expect, test } from "bun:test"
import { rowAria, selectArchivedSessionsView } from "./archived-sessions-view"

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

const continuing = { status: "ready", visibleSessionCount: 2, filter: "", nextCursor: "cursor-2" } as const

test("keeps Load more enabled when no batch is running, whether bulkRunning is absent or false", () => {
  const enabled = { message: undefined, loadMoreEnabled: true, retryEnabled: false }

  expect(selectArchivedSessionsView(continuing)).toEqual(enabled)
  expect(selectArchivedSessionsView({ ...continuing, bulkRunning: false })).toEqual(enabled)
})

test("disables Load more while a batch runs", () => {
  expect(selectArchivedSessionsView({ ...continuing, bulkRunning: true })).toEqual({
    message: undefined,
    loadMoreEnabled: false,
    retryEnabled: false,
  })
})

test("disables the continuation Retry while a batch runs and restores it afterwards", () => {
  const failed = { ...continuing, continuationError: new Error("failed") }

  expect(selectArchivedSessionsView({ ...failed, bulkRunning: false })).toEqual({
    message: undefined,
    loadMoreEnabled: false,
    retryEnabled: true,
  })
  expect(selectArchivedSessionsView({ ...failed, bulkRunning: true })).toEqual({
    message: undefined,
    loadMoreEnabled: false,
    retryEnabled: false,
  })
})

test("keeps the initial-load Retry enabled while a batch runs", () => {
  expect(
    selectArchivedSessionsView({ status: "error", visibleSessionCount: 0, filter: "", bulkRunning: true }),
  ).toEqual({ message: "error", loadMoreEnabled: false, retryEnabled: true })
})

test("a running batch does not change the message", () => {
  expect(
    selectArchivedSessionsView({ status: "ready", visibleSessionCount: 0, filter: "x", bulkRunning: true }).message,
  ).toBe("loaded-no-match")
  expect(
    selectArchivedSessionsView({ status: "loading", visibleSessionCount: 0, filter: "", bulkRunning: true }).message,
  ).toBe("loading")
})

test("disables Load more while a continuation is pending, with or without a batch", () => {
  expect(selectArchivedSessionsView({ ...continuing, continuationPending: true }).loadMoreEnabled).toBe(false)
  expect(
    selectArchivedSessionsView({ ...continuing, continuationPending: true, bulkRunning: true }).loadMoreEnabled,
  ).toBe(false)
})

test("returns exactly the three view fields", () => {
  expect(Object.keys(selectArchivedSessionsView({ ...continuing, bulkRunning: true })).toSorted()).toEqual([
    "loadMoreEnabled",
    "message",
    "retryEnabled",
  ])
})

test("rowAria is empty when selection mode is off, whatever the row state", () => {
  expect(rowAria({ on: false, selected: false, selectable: true })).toEqual({})
  expect(rowAria({ on: false, selected: true, selectable: false })).toEqual({})
})

test("rowAria marks a selected selectable row as a checked checkbox", () => {
  expect(rowAria({ on: true, selected: true, selectable: true })).toEqual({ role: "checkbox", "aria-checked": "true" })
})

test("rowAria marks an unselected selectable row as an unchecked checkbox", () => {
  expect(rowAria({ on: true, selected: false, selectable: true })).toEqual({
    role: "checkbox",
    "aria-checked": "false",
  })
})

test("rowAria marks an unselectable row as disabled", () => {
  expect(rowAria({ on: true, selected: false, selectable: false })).toEqual({
    role: "checkbox",
    "aria-checked": "false",
    "aria-disabled": "true",
  })
})

test("rowAria keeps a selected row that turned unselectable checked and disabled", () => {
  expect(rowAria({ on: true, selected: true, selectable: false })).toEqual({
    role: "checkbox",
    "aria-checked": "true",
    "aria-disabled": "true",
  })
})

test("rowAria sets no aria-disabled key at all on a selectable row", () => {
  expect("aria-disabled" in rowAria({ on: true, selected: true, selectable: true })).toBe(false)
})
