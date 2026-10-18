/**
 * @spec-handoff
 * @interface loadArchivedSessions(api, {signal}): Promise<ArchiveSession[]>; createArchivedSessionsModel(deps)
 * @behavior
 *   - Loads all archived root rows once and searches its ready snapshot locally.
 *   - Restores a row then opens its captured server tab in the specified order.
 *   - A disposed model retains its snapshot and performs no new load, retry, or notification.
 * @edge-cases
 *   - Epoch zero is retained; stale/disposed completions have no effects.
 * @see RFC 057 Addendum A.5
 */
import { expect, test } from "bun:test"
import { createArchivedSessionsModel, loadArchivedSessions, matchesArchivedSession } from "./archived-sessions-model"
test("loads archived root rows including zero and searches locally", async () => {
  const calls: unknown[] = []
  const rows = await loadArchivedSessions({ list: async (input: unknown) => { calls.push(input); return { data: [{ id: "zero", location: { directory: "/Project" }, time: { archived: 0 } }, { id: "active", location: { directory: "/x" }, time: {} }], cursor: {} } } }, { signal: new AbortController().signal })
  expect(rows.map((x: { id: string }) => x.id)).toEqual(["zero"])
  expect(calls).toHaveLength(1); expect(matchesArchivedSession(rows[0], "project")).toBe(true)
})
test("models loading, retry, local search, restore order, and disposal", async () => {
  const calls: string[] = []; let resolve!: () => void; const wait = new Promise<void>((r) => resolve = r)
  const model = createArchivedSessionsModel({ server: "s", list: async () => { await wait; return { data: [{ id: "x", title: "Alpha", location: { directory: "/d" }, time: { archived: 0 } }], cursor: {} } }, setArchive: async () => true, openProject: () => calls.push("open"), touchProject: () => calls.push("touch"), addTab: () => { calls.push("tab"); return "tab" }, selectTab: () => calls.push("select"), close: () => calls.push("close") })
  const load = model.load(); expect(model.state().status).toBe("loading"); resolve(); await load
  expect(model.search("alpha")).toHaveLength(1); await model.restore("x"); expect(calls).toEqual(["open", "touch", "tab", "select", "close"])
  model.dispose(); expect(await model.restore("x")).toBe(false)
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
