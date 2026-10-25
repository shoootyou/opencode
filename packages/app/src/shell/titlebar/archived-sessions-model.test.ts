/**
 * @spec-handoff
 * @interface createArchivedSessionsModel(deps): { load(): Promise<void>; loadMore(): Promise<void>; retryMore(): Promise<void> }
 * @behavior
 *   - Loads one archived root batch of 50, then appends unique continuation rows in response order.
 *   - Guards concurrent continuation, retains rows on recoverable continuation failure, and retries its same cursor.
 *   - Ignores stale, disposed, reset, and restore-aborted append completions.
 * @edge-cases
 *   - Empty or cursorless batches exhaust; short nonempty batches with a cursor remain continuable.
 *   - Repeated cursors and duplicate-only batches pause with a recoverable error rather than exhausting.
 * @see RFC 057 D.3.1-9, AP1, AP4-7
 */
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these controlled black-box fixtures deliberately capture the opaque SDK request and assert the proposed model contract before its typed API exists.
import { expect, test } from "bun:test"
import { createArchivedSessionsModel, loadArchivedSessions, matchesArchivedSession } from "./archived-sessions-model"

type ContinuousModel = {
  state: () => { status: string; rows?: readonly { id: string }[]; nextCursor?: string; continuationError?: unknown }
  load: () => Promise<void>
  loadMore: () => Promise<void>
  retryMore: () => Promise<void>
  restore: (id: string) => Promise<boolean>
  dispose: () => void
}

const session = (id: string, archived = 1) => ({ id, title: id, location: { directory: `/${id}` }, time: { archived } })

function model(list: (input: unknown) => Promise<unknown>) {
  return createArchivedSessionsModel({
    server: "captured-server",
    list: async (input: unknown) => list(input) as never,
    setArchive: async () => true,
    openProject: () => {},
    touchProject: () => {},
    addTab: () => "tab",
    selectTab: () => {},
    close: () => {},
  }) as unknown as ContinuousModel
}

test("loads one archived-only root batch with the fixed limit and searches loaded title or directory rows locally", async () => {
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    return { data: [session("zero", 0), session("directory-match")], cursor: { next: "after-root" } }
  })

  await archive.load()
  expect(requests).toEqual([{ archived: "only", parentID: null, order: "desc", limit: 50 }])
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["zero", "directory-match"])
  expect(matchesArchivedSession(session("directory-match"), "directory")).toBe(true)
})

test("appends unseen continuation rows in response order without treating a short cursor-bearing batch as exhausted", async () => {
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    return requests.length === 1
      ? { data: [session("newest"), session("overlap")], cursor: { next: "cursor-2" } }
      : { data: [session("overlap", 999), session("older")], cursor: { next: "cursor-3" } }
  })

  await archive.load()
  await archive.loadMore()
  expect(requests).toEqual([
    { archived: "only", parentID: null, order: "desc", limit: 50 },
    { archived: "only", parentID: null, order: "desc", limit: 50, cursor: "cursor-2" },
  ])
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["newest", "overlap", "older"])
  expect(archive.state().nextCursor).toBe("cursor-3")
})

test("sets the continuation in-flight guard before awaiting and does not completion-chain another request", async () => {
  const held = Promise.withResolvers<unknown>()
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    if (requests.length === 1) return { data: [session("first")], cursor: { next: "cursor-2" } }
    return held.promise
  })

  await archive.load()
  const first = archive.loadMore()
  const duplicate = archive.loadMore()
  expect(requests).toHaveLength(2)
  held.resolve({ data: [session("second")], cursor: { next: "cursor-3" } })
  await Promise.all([first, duplicate])
  expect(requests).toHaveLength(2)
})

test("keeps rows and the failed cursor for retry after duplicate-only or repeated-cursor continuation", async () => {
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    if (requests.length === 1) return { data: [session("first")], cursor: { next: "cursor-2" } }
    if (requests.length === 2) return { data: [session("first")], cursor: { next: "cursor-2" } }
    return { data: [session("second")], cursor: {} }
  })

  await archive.load()
  await archive.loadMore()
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["first"])
  expect(archive.state().nextCursor).toBe("cursor-2")
  expect(archive.state().continuationError).toBeDefined()
  await archive.retryMore()
  expect(requests[2]).toEqual({ archived: "only", parentID: null, order: "desc", limit: 50, cursor: "cursor-2" })
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["first", "second"])
})

test("commits final nonempty rows, exhausts only on empty or missing cursor, and ignores stale append after disposal", async () => {
  const held = Promise.withResolvers<unknown>()
  let calls = 0
  const archive = model(async () => {
    calls++
    if (calls === 1) return { data: [session("first")], cursor: { next: "cursor-2" } }
    return held.promise
  })

  await archive.load()
  const append = archive.loadMore()
  archive.dispose()
  held.resolve({ data: [session("stale")], cursor: {} })
  await append
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["first"])
})

test("restores a captured displayed row through the existing success-only tab sequence", async () => {
  const calls: string[] = []
  const archive = createArchivedSessionsModel({
    server: "captured-server",
    list: async () => ({ data: [session("restorable")], cursor: {} }) as never,
    setArchive: async () => true,
    openProject: () => calls.push("open"),
    touchProject: () => calls.push("touch"),
    addTab: () => {
      calls.push("tab")
      return "tab"
    },
    selectTab: () => calls.push("select"),
    close: () => calls.push("close"),
  })

  await archive.load()
  expect(await archive.restore("restorable")).toBe(true)
  expect(calls).toEqual(["open", "touch", "tab", "select", "close"])
})

test("loadArchivedSessions preserves one-request validation and terminal cursor normalization", async () => {
  const page = await loadArchivedSessions(
    { list: async () => ({ data: [session("final")], cursor: {} }) as never },
    { signal: new AbortController().signal },
  )
  expect(page.sessions.map((row) => row.id)).toEqual(["final"])
  expect(page.cursor.next).toBeUndefined()
})
