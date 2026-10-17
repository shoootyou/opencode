/**
 * @spec-handoff
 * @interface loadArchivedSessionEntries(list: (input: SessionListInput) => Promise<SessionListOutput>, fallbackTitle: string): Promise<ArchivedEntry[]>
 * @behavior
 *   - Requests the first global root page with exactly `{ archived: true, parentID: null }`.
 *   - Follows every non-null `cursor.next` unchanged, aggregates all pages, then filters and sorts.
 *   - Keeps archived roots (including timestamp 0), ordered by archived time descending then ID ascending.
 * @edge-cases
 *   - An empty aggregate returns `[]`; a later request rejection rejects without a partial result.
 *   - A repeated cursor rejects visibly rather than looping or returning a truncated result.
 * @see ./browse-archived.ts
 */
import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionListInput, SessionListOutput } from "@opencode/client"
import { loadArchivedSessionEntries } from "./browse-archived"

const FALLBACK = "Untitled session"

function session(overrides: Partial<SessionInfo> & { id: string; time: SessionInfo["time"] }): SessionInfo {
  return {
    slug: overrides.id,
    projectID: "project-1",
    directory: "/work/project-1",
    title: "Default title",
    version: "2.0.28",
    ...overrides,
    id: overrides.id,
  } as SessionInfo
}

function page(data: SessionInfo[], next: string | null = null): SessionListOutput {
  return { data, cursor: { next } }
}

describe("loadArchivedSessionEntries", () => {
  test("requests the exact initial root archive page, follows every cursor, and does not stop at a short page", async () => {
    const requests: SessionListInput[] = []
    const list = async (input: SessionListInput) => {
      requests.push(input)
      if (!input.cursor) return page([session({ id: "first", time: { created: 1, updated: 1, archived: 10 } })], "next-1")
      if (input.cursor === "next-1") return page([], "next-2")
      return page([session({ id: "last", time: { created: 2, updated: 2, archived: 20 } })])
    }

    const result = await loadArchivedSessionEntries(list, FALLBACK)

    expect(requests).toEqual([
      { archived: true, parentID: null },
      { archived: true, parentID: null, cursor: "next-1" },
      { archived: true, parentID: null, cursor: "next-2" },
    ])
    expect(result.map((entry) => entry.id)).toEqual(["last", "first"])
  })

  test("filters the completed aggregate to archived roots, retains epoch 0, sorts deterministically, and preserves references", async () => {
    const epoch = session({ id: "epoch", title: "", time: { created: 0, updated: 0, archived: 0 } })
    const firstTie = session({ id: "a", time: { created: 0, updated: 0, archived: 100 } })
    const secondTie = session({ id: "b", time: { created: 0, updated: 0, archived: 100 } })
    const active = session({ id: "active", time: { created: 0, updated: 0 } })
    const child = session({ id: "child", parentID: "a", time: { created: 0, updated: 0, archived: 999 } })

    const result = await loadArchivedSessionEntries(async () => page([secondTie, active, child, epoch, firstTie]), FALLBACK)

    expect(result.map((entry) => entry.id)).toEqual(["a", "b", "epoch"])
    expect(result[2]).toMatchObject({ title: FALLBACK, archivedAt: 0, session: epoch })
    expect(result[2]?.session).toBe(epoch)
  })

  test("returns an empty aggregate without making a follow-up request", async () => {
    let calls = 0

    await expect(
      loadArchivedSessionEntries(async () => {
        calls++
        return page([])
      }, FALLBACK),
    ).resolves.toEqual([])

    expect(calls).toBe(1)
  })

  test("rejects a later-page request instead of returning the earlier partial aggregate", async () => {
    const failure = new Error("second page unavailable")

    await expect(
      loadArchivedSessionEntries(async (input) => {
        if (!input.cursor) return page([session({ id: "first", time: { created: 1, updated: 1, archived: 1 } })], "next-1")
        throw failure
      }, FALLBACK),
    ).rejects.toBe(failure)
  })

  test("rejects a repeated cursor visibly instead of looping or returning a partial aggregate", async () => {
    const requests: SessionListInput[] = []

    await expect(
      loadArchivedSessionEntries(async (input) => {
        requests.push(input)
        return page([session({ id: "first", time: { created: 1, updated: 1, archived: 1 } })], "again")
      }, FALLBACK),
    ).rejects.toThrow('Repeated archived-session cursor: "again"')

    expect(requests).toEqual([
      { archived: true, parentID: null },
      { archived: true, parentID: null, cursor: "again" },
    ])
  })
})
