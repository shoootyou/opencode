/**
 * @spec-handoff
 * @interface createSessionListQuery(input: { showArchived: boolean }): { archived?: true }
 * @interface sessionListItem(session: { time: { archived?: number | null } }): { archived: boolean }
 * @interface toggleSessionArchive(input: { sessionID: string; archivedAt?: number | null; now: number; update(input: { sessionID: string; archive: number | null }): Promise<void>; refresh(): Promise<void> }): Promise<void>
 * @interface toggleArchivedVisibility(showArchived: boolean): boolean
 * @behavior
 *   - The default query omits archived sessions; enabling the filter sends archived: true.
 *   - Archived sessions are marked and toggling sends a timestamp or null through the v2 archive API.
 *   - A successful void update refreshes the session list.
 *   - The archive-visibility action toggles the list-wide filter without requiring a selected row, including when either list is empty.
 */
import { describe, expect, test } from "bun:test"
import {
  createSessionListQuery,
  sessionListItem,
  toggleArchivedVisibility,
  toggleSessionArchive,
} from "../../src/component/session-list-model"

describe("session list archive model", () => {
  test("omits archived sessions by default and requests them when the filter is enabled", () => {
    expect(createSessionListQuery({ showArchived: false })).toEqual({})
    expect(createSessionListQuery({ showArchived: true })).toEqual({ archived: true })
  })

  test("marks archived sessions", () => {
    expect(sessionListItem({ time: {} }).archived).toBeFalse()
    expect(sessionListItem({ time: { archived: 0 } }).archived).toBeTrue()
  })

  test("toggles archived visibility without depending on a selected session", () => {
    // The component action must call this pure helper with no selected option, so both empty-list states remain reachable.
    expect(toggleArchivedVisibility(false)).toBeTrue()
    expect(toggleArchivedVisibility(true)).toBeFalse()
  })

  test("archives an active session then refreshes after the void response", async () => {
    const calls: string[] = []

    await toggleSessionArchive({
      sessionID: "ses_active",
      now: 1_700_000_000_000,
      update: async (input) => {
        expect(input).toEqual({ sessionID: "ses_active", archive: 1_700_000_000_000 })
        calls.push("update")
      },
      refresh: async () => {
        expect(calls).toEqual(["update"])
        calls.push("refresh")
      },
    })

    expect(calls).toEqual(["update", "refresh"])
  })

  test("unarchives an archived session then refreshes after the void response", async () => {
    const updates: Array<{ sessionID: string; archive: number | null }> = []
    let refreshed = false

    await toggleSessionArchive({
      sessionID: "ses_archived",
      archivedAt: 1_650_000_000_000,
      now: 1_700_000_000_000,
      update: async (input) => {
        updates.push(input)
      },
      refresh: async () => {
        refreshed = true
      },
    })

    expect(updates).toEqual([{ sessionID: "ses_archived", archive: null }])
    expect(refreshed).toBeTrue()
  })
})
