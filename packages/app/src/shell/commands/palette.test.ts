/**
 * @spec-handoff
 * @interface createServerSessionEntries(props): (query: string) => Promise<CommandPaletteEntry[]>
 * @behavior
 *   - Excludes every session whose `time.archived` is truthy from palette search results.
 *   - Keeps non-archived sibling sessions available in the same search result.
 * @edge-cases
 *   - An archived timestamp must not leak into an entry as `archived`, so an active palette row
 *     cannot receive archived-specific presentation from a normal palette result.
 * @see ./palette.ts
 */

import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client/promise"
import { createRoot } from "solid-js"
import { ServerConnection } from "@/runtime/server/registry"
import { createServerSessionEntries } from "./palette"

function session(id: string, archived?: number): SessionInfo {
  return {
    id,
    title: id,
    location: { directory: `/workspace/${id}` },
    time: { created: 1, updated: 2, archived },
  } as SessionInfo
}

function searchSessions(sessions: SessionInfo[]) {
  return createRoot((dispose) => {
    const entries = createServerSessionEntries({
      server: ServerConnection.key({ type: "http", http: { url: "http://localhost:4096" } }),
      opened: () => [],
      stored: () => [],
      load: async () => ({ data: sessions }),
      get: async () => sessions[0]!,
      untitled: () => "Untitled",
      category: () => "Sessions",
      recentCategory: () => "Recent sessions",
    })
    return entries("search").finally(dispose)
  })
}

describe("createServerSessionEntries", () => {
  test("excludes archived sessions from mixed palette search results", async () => {
    const entries = await searchSessions([session("active"), session("archived", 3)])

    expect(entries).toEqual([
      expect.objectContaining({ sessionID: "active", title: "active" }),
    ])
    expect(entries.every((entry) => !entry.archived)).toBe(true)
  })
})
