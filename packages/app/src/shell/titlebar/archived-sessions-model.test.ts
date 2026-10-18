/**
 * @spec-handoff
 * @interface loadArchivedSessions(api, {signal,cursor?}): Promise<ArchivedPage>; createArchivedSessionsModel(deps)
 * @behavior
 *   - Loads exactly one archived-only root page of at most 50 rows per explicit action.
 *   - Replaces the current page on next/previous/reset and searches that page locally.
 *   - Restores a row then opens its captured server tab in the specified order.
 *   - A disposed model retains its snapshot and performs no new load, retry, or notification.
 * @edge-cases
 *   - Epoch zero is retained; stale/disposed completions have no effects.
 * @see RFC 057 Addendum C.3, C.6
 */
import { expect, test } from "bun:test"
import { createArchivedSessionsModel, loadArchivedSessions, matchesArchivedSession } from "./archived-sessions-model"
test("loads exactly one archived-only root page including epoch zero", async () => {
  const calls: unknown[] = []
  const page = await loadArchivedSessions({
    list: (async (input: unknown) => {
      calls.push(input)
      return { data: [{ id: "zero", location: { directory: "/Project" }, time: { archived: 0 } }], cursor: {} }
    }) as never,
  }, { signal: new AbortController().signal })
  expect(page.sessions.map((x: { id: string }) => x.id)).toEqual(["zero"])
  expect(calls).toEqual([{ archived: "only", parentID: null, order: "desc", limit: 50 }])
  expect(page.cursor.next).toBeUndefined()
  expect(matchesArchivedSession(page.sessions[0], "project")).toBe(true)
})
test("keeps one page, only fetches next after an explicit action, and restores in order", async () => {
  const calls: string[] = []; let resolve!: () => void; const wait = new Promise<void>((r) => resolve = r)
  const requests: unknown[] = []
  const model = createArchivedSessionsModel({ server: "s", list: async (input: unknown) => { requests.push(input); await wait; return { data: [{ id: "x", title: "Alpha", location: { directory: "/d" }, time: { archived: 0 } }], cursor: { next: "page-2" } } }, setArchive: async () => true, openProject: () => calls.push("open"), touchProject: () => calls.push("touch"), addTab: () => { calls.push("tab"); return "tab" }, selectTab: () => calls.push("select"), close: () => calls.push("close") } as never)
  const load = model.load(); expect(model.state().status).toBe("loading"); resolve(); await load
  expect(requests).toHaveLength(1)
  expect(model.search("alpha")).toHaveLength(1)
  await model.next()
  expect(requests).toHaveLength(2)
  await model.restore("x"); expect(calls).toEqual(["open", "touch", "tab", "select", "close"])
  model.dispose(); expect(await model.restore("x")).toBe(false)
})

test("uses each ready page cursor for Next and Previous, then Reset restores the first page", async () => {
  const requests: unknown[] = []
  const pages = [
    { data: [{ id: "first", location: { directory: "/one" }, time: { archived: 1 } }], cursor: { next: "next" } },
    { data: [{ id: "second", location: { directory: "/two" }, time: { archived: 2 } }], cursor: { previous: "previous" } },
    { data: [{ id: "again", location: { directory: "/three" }, time: { archived: 3 } }], cursor: {} },
    { data: [{ id: "reset", location: { directory: "/four" }, time: { archived: 4 } }], cursor: {} },
  ]
  const model = createArchivedSessionsModel({
    server: "s",
    list: async (input: unknown) => {
      requests.push(input)
      return pages[requests.length - 1]
    },
    setArchive: async () => true,
    openProject: () => {}, touchProject: () => {}, addTab: () => "tab", selectTab: () => {}, close: () => {},
  })
  await model.load()
  await model.next()
  await model.previous()
  await model.load()
  expect(requests).toEqual([
    { archived: "only", parentID: null, order: "desc", limit: 50 },
    { archived: "only", parentID: null, order: "desc", limit: 50, cursor: "next" },
    { archived: "only", parentID: null, order: "desc", limit: 50, cursor: "previous" },
    { archived: "only", parentID: null, order: "desc", limit: 50 },
  ])
  expect(model.state()).toMatchObject({ status: "ready", page: { sessions: [{ id: "reset" }] } })
})
test("does not start loading or notify after disposal", async () => {
  let requests = 0
  let notifications = 0
  const model = createArchivedSessionsModel({ server: "s", list: async () => { requests++; return { data: [], cursor: {} } }, setArchive: async () => true, openProject: () => {}, touchProject: () => {}, addTab: () => "tab", selectTab: () => {}, close: () => {} })
  const before = model.state()
  model.subscribe(() => notifications++)
  model.dispose()
  await model.load()
  expect(requests).toBe(0)
  expect(notifications).toBe(0)
  expect(model.state()).toBe(before)
})
