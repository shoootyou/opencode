/**
 * @spec-handoff
 * @interface listAllSessions(api: Pick<SessionApi, "list">, input: Omit<SessionListInput, "cursor">, options?: { signal?: AbortSignal }): Promise<SessionInfo[]>
 * @behavior
 *   - Loads every cursor page iteratively, preserving the list query.
 *   - Retains first-seen sessions only and rejects a repeated next cursor.
 *   - Stops loading when the optional cancellation signal is aborted.
 * @edge-cases
 *   - A later page may repeat an ID from an earlier page.
 *   - Cancellation is not a successful partial result.
 */
import { describe, expect, test } from "bun:test"
import type { SessionApi, SessionInfo, SessionListInput } from "@opencode/client/promise"
import { listAllSessions } from "./list"

describe("listAllSessions", () => {
  test("loads every page in server order and retains the query", async () => {
    const calls: SessionListInput[] = []

    const pages = new Map<string | undefined, { data: SessionInfo[]; cursor: { next?: string } }>([
      [undefined, { data: [sessionInfo("session-3"), sessionInfo("session-2")], cursor: { next: "next" } }],
      ["next", { data: [sessionInfo("session-1", true)], cursor: {} }],
    ])

    const api = {
      list: async (query = {}) => {
        calls.push(query)

        return pages.get(query.cursor) ?? { data: [], cursor: {} }
      },
    } satisfies Pick<SessionApi, "list">

    const result = await listAllSessions(api, { directory: "/repo", order: "desc" })

    expect(result.map((session) => session.id)).toEqual(["session-3", "session-2", "session-1"])
    expect(result[2]?.time.archived).toBe(2)
    expect(calls).toEqual([
      { directory: "/repo", order: "desc", limit: 100, cursor: undefined },
      { directory: "/repo", order: "desc", limit: 100, cursor: "next" },
    ])
  })

  test("requests the terminal empty page when the server returns a next cursor", async () => {
    const cursors: Array<string | undefined> = []

    const api = {
      list: async (query = {}) => {
        cursors.push(query.cursor)

        if (query.cursor) return { data: [], cursor: { next: "unused" } }

        return { data: [sessionInfo("session-1")], cursor: { next: "terminal" } }
      },
    } satisfies Pick<SessionApi, "list">

    const result = await listAllSessions(api, { directory: "/repo", limit: 25 })

    expect(result.map((session) => session.id)).toEqual(["session-1"])
    expect(cursors).toEqual([undefined, "terminal"])
  })

  test("deduplicates a session repeated by a later cursor page", async () => {
    const api = {
      list: async (query = {}) => {
        if (!query.cursor)
          return { data: [sessionInfo("session-2"), sessionInfo("session-1")], cursor: { next: "older" } }
        return { data: [sessionInfo("session-1"), sessionInfo("session-0")], cursor: {} }
      },
    } satisfies Pick<SessionApi, "list">

    const result = await listAllSessions(api, { parentID: null })

    expect(result.map((session) => session.id)).toEqual(["session-2", "session-1", "session-0"])
  })

  test("rejects a repeated cursor before issuing another duplicate page request", async () => {
    const cursors: Array<string | undefined> = []
    const api = {
      list: async (query = {}) => {
        cursors.push(query.cursor)
        if (cursors.length > 2) throw new Error("must not request a repeated cursor")
        return { data: [sessionInfo(`session-${cursors.length}`)], cursor: { next: "same-cursor" } }
      },
    } satisfies Pick<SessionApi, "list">

    await expect(listAllSessions(api, { parentID: null })).rejects.toThrow("Repeated session list cursor")
    expect(cursors).toEqual([undefined, "same-cursor"])
  })

  test("does not fetch the next page after cancellation", async () => {
    const controller = new AbortController()
    const cursors: Array<string | undefined> = []
    const api = {
      list: async (query = {}) => {
        cursors.push(query.cursor)
        if (cursors.length > 1) throw new Error("must not fetch after cancellation")
        controller.abort()
        return { data: [sessionInfo("session-1")], cursor: { next: "next" } }
      },
    } satisfies Pick<SessionApi, "list">

    await expect(listAllSessions(api, { parentID: null }, { signal: controller.signal })).rejects.toThrow("AbortError")
    expect(cursors).toEqual([undefined])
  })
})

function sessionInfo(id: string, archived = false) {
  return {
    id,
    projectID: "project-1",
    agent: "build",
    model: { id: "model-1", providerID: "provider-1" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1, archived: archived ? 2 : undefined },
    title: id,
    location: { directory: "/repo" },
  } as SessionInfo
}
