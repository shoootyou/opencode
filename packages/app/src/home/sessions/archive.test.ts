/**
 * @spec-handoff
 * @interface archiveHomeSession(input: { server: ServerConnection.Key; session: HomeSession; archive(request: { sessionID: string; archive: number }): Promise<unknown>; commit(): void; onError?(error: unknown): void }): Promise<boolean>
 * @behavior
 *   - Sends exactly the session ID and the current archive timestamp to the archive API.
 *   - Commits and removes the session tab only after a successful archive request.
 *   - Reports one rejection without committing or removing a tab, and returns false.
 * @edge-cases
 *   - A pending request has no visible effect.
 *   - Replayed successes remain idempotent in the committed Home roots.
 */
import { expect, setSystemTime, test } from "bun:test"
import { SESSION_TABS_REMOVED_EVENT, readSessionTabsRemovedDetail } from "@/shell/titlebar/session-events"
import { archiveHomeSession } from "./archive"
import type { ServerConnection } from "@/runtime/server/registry"

const remote = "remote" as ServerConnection.Key

test("archives with the canonical request, then commits once and removes one tab", async () => {
  setSystemTime(new Date("2026-10-13T12:00:00.000Z"))
  const events: Array<ReturnType<typeof readSessionTabsRemovedDetail>> = []
  const onRemoved = (event: Event) => events.push(readSessionTabsRemovedDetail(event))
  let request: unknown
  let commits = 0
  window.addEventListener(SESSION_TABS_REMOVED_EVENT, onRemoved)

  try {
    const result = await archiveHomeSession({
      server: remote,
      session: { id: "ses_1", location: { directory: "/workspace" } },
      archive: async (input) => {
        request = input
      },
      commit: () => {
        commits++
      },
    })

    expect(request).toEqual({ sessionID: "ses_1", archive: Date.now() })
    expect(commits).toBe(1)
    expect(events).toEqual([{ server: remote, directory: "/workspace", sessionIDs: ["ses_1"] }])
    expect(result).toBe(true)
  } finally {
    window.removeEventListener(SESSION_TABS_REMOVED_EVENT, onRemoved)
    setSystemTime()
  }
})

test("does not commit or remove a tab before the archive request settles", async () => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  let commits = 0
  let events = 0
  const onRemoved = () => events++
  window.addEventListener(SESSION_TABS_REMOVED_EVENT, onRemoved)

  try {
    const archive = archiveHomeSession({
      server: remote,
      session: { id: "ses_1", location: { directory: "/workspace" } },
      archive: () => pending,
      commit: () => {
        commits++
      },
    })

    expect(commits).toBe(0)
    expect(events).toBe(0)
    resolve()
    expect(await archive).toBe(true)
    expect(commits).toBe(1)
    expect(events).toBe(1)
  } finally {
    window.removeEventListener(SESSION_TABS_REMOVED_EVENT, onRemoved)
  }
})

test("reports an unavailable controller archive once without committing or removing a tab", async () => {
  const failure = new Error("offline")
  const errors: unknown[] = []
  let commits = 0
  let events = 0
  const onRemoved = () => events++
  window.addEventListener(SESSION_TABS_REMOVED_EVENT, onRemoved)

  try {
    const result = await archiveHomeSession({
      server: remote,
      session: { id: "ses_1", location: { directory: "/workspace" } },
      archive: async () => Promise.reject(failure),
      commit: () => {
        commits++
      },
      onError: (error) => errors.push(error),
    })

    expect(errors).toEqual([failure])
    expect(commits).toBe(0)
    expect(events).toBe(0)
    expect(result).toBe(false)
  } finally {
    window.removeEventListener(SESSION_TABS_REMOVED_EVENT, onRemoved)
  }
})

test("keeps an idempotent Home-root commit stable when a successful archive is replayed", async () => {
  const roots = new Set(["ses_1"])
  const archive = () => Promise.resolve()
  const commit = () => roots.delete("ses_1")

  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", location: { directory: "/workspace" } },
    archive,
    commit,
  })
  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", location: { directory: "/workspace" } },
    archive,
    commit,
  })

  expect([...roots]).toEqual([])
  expect(roots.size).toBe(0)
})
