/**
 * @spec-handoff
 * @interface DialogSessionList(): JSX.Element
 * @behavior
 *   - Each opening begins with archived root sessions hidden, including sessions archived at timestamp 0.
 *   - The dialog's archive visibility is independent from prior dialog openings.
 *   - A successful archive change syncs the selected session before refetching the list.
 * @edge-cases
 *   - Child sessions remain absent from the root-session picker.
 * @see ../src/component/dialog-session-list.tsx
 */
import { expect, mock, test } from "bun:test"
import { Keymap as BaseKeymap } from "../src/context/keymap"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

let dispatch!: (id: string) => void
const useKeymap = BaseKeymap.use

mock.module("../src/context/keymap", () => ({
  Keymap: {
    ...BaseKeymap,
    use() {
      const keymap = useKeymap()
      dispatch = keymap.dispatch
      return keymap
    },
  },
}))

test.serial("session list initially hides epoch-zero archived roots through the real dialog seam", async () => {
  await using setup = await createAppFixture({
    config: { animations: false, keybinds: { "session.list": "ctrl+l" } },
    fetch: (url) => {
      if (url.pathname === "/api/location") {
        const directory = url.searchParams.get("location[directory]") ?? process.cwd()
        return json({ directory, project: { id: "proj_fixture", directory, canonical: directory } })
      }
      if (url.pathname !== "/api/session") return
      return json({
        data: [
          {
            id: "ses_active",
            projectID: "proj_fixture",
            title: "Active root",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 2 },
            location: { directory: process.cwd() },
          },
          {
            id: "ses_archived_zero",
            projectID: "proj_fixture",
            title: "Archived epoch root",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 2, archived: 0 },
            location: { directory: process.cwd() },
          },
          {
            id: "ses_archived_child",
            parentID: "ses_archived_zero",
            projectID: "proj_fixture",
            title: "Archived child",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 2, archived: 1 },
            location: { directory: process.cwd() },
          },
        ],
        cursor: {},
      })
    },
  })

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("l", { ctrl: true })
  const frame = await setup.waitForFrame((value) => value.includes("Active root"))

  expect(frame).not.toContain("Archived epoch root")
  expect(frame).not.toContain("Archived child")
})

test.serial("selection-free archive visibility toggles switch HTTP inclusion mode in both directions with an empty list", async () => {
  const archiveModes: Array<string | null> = []
  await using setup = await createAppFixture({
    config: {
      animations: false,
      keybinds: {
        "session.list": "ctrl+l",
        "session.archived.toggle_visibility": "ctrl+v",
      },
    },
    fetch: (url) => {
      if (url.pathname === "/api/session") {
        archiveModes.push(url.searchParams.get("archived"))
        return json({ data: [], cursor: {} })
      }
      return undefined
    },
  })

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("No sessions available"))
  setup.mockInput.pressKey("v", { ctrl: true })
  await setup.waitForFrame(() => archiveModes.includes("true"))
  setup.mockInput.pressKey("v", { ctrl: true })
  await setup.waitForFrame(() => archiveModes.filter((mode) => mode === null).length >= 2)

  expect(archiveModes).toContain("true")
  expect(archiveModes.filter((mode) => mode === null)).toHaveLength(2)
})

test.serial("selected archive toggle sends null for an archived row and refetches only after success", async () => {
  const patch = Promise.withResolvers<Response>()
  const updates: unknown[] = []
  const syncs: Array<{ path: string; method: string }> = []
  const refetchedRows: unknown[][] = []
  let listCalls = 0
  let archived = true
  await using setup = await createAppFixture({
    config: {
      animations: false,
      keybinds: {
        "session.list": "ctrl+l",
        "session.archived.toggle_visibility": "ctrl+v",
      },
    },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") {
        listCalls++
        if (url.searchParams.get("archived") !== "true") return json({ data: [], cursor: {} })
        const data = [
          {
            id: "ses_archived",
            projectID: "proj_fixture",
            title: "Archived root",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 2, ...(archived ? { archived: 0 } : {}) },
            location: { directory: process.cwd() },
          },
        ]
        if (updates.length) refetchedRows.push(data)
        return json({ data, cursor: {} })
      }
      if (url.pathname.includes("ses_archived")) {
        if (request.method === "PATCH") {
          updates.push(await request.json())
          return patch.promise
        }
        syncs.push({ path: url.pathname, method: request.method })
        return json({ data: {
          id: "ses_archived",
          projectID: "proj_fixture",
          title: "Archived root",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          location: { directory: process.cwd() },
        } })
      }
      return undefined
    },
  })

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("No sessions available"))
  setup.mockInput.pressKey("v", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Archived root"))
  const beforeUpdate = listCalls
  dispatch("session.archive.toggle")
  await setup.waitForFrame(() => updates.length === 1)

  expect(updates).toEqual([{ archive: null }])
  expect(listCalls).toBe(beforeUpdate)

  archived = false
  patch.resolve(new Response(null, { status: 204 }))
  await setup.waitFor(() => syncs.length === 1 && listCalls > beforeUpdate)

  expect(listCalls).toBeGreaterThan(beforeUpdate)
  expect(syncs).toEqual([{ path: "/api/session/ses_archived", method: "GET" }])
  expect((refetchedRows[0][0] as { time: { archived?: number } }).time.archived).toBeUndefined()
})

test.serial("selected archive toggle sends the current timestamp once, syncs it, and refetches after success", async () => {
  const patch = Promise.withResolvers<Response>()
  const updates: unknown[] = []
  const syncs: unknown[] = []
  const refetchedRows: unknown[][] = []
  let listCalls = 0
  let archived: number | undefined
  await using setup = await createAppFixture({
    config: { animations: false, keybinds: { "session.list": "ctrl+l" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") {
        listCalls++
        const data = [
          {
            id: "ses_active",
            projectID: "proj_fixture",
            title: "Active root",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 2, ...(archived === undefined ? {} : { archived }) },
            location: { directory: process.cwd() },
          },
        ]
        if (updates.length) refetchedRows.push(data)
        return json({ data, cursor: {} })
      }
      if (url.pathname.includes("ses_active")) {
        if (request.method === "PATCH") {
          updates.push(await request.json())
          return patch.promise
        }
        const session = {
          id: "ses_active",
          projectID: "proj_fixture",
          title: "Active root",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2, archived },
          location: { directory: process.cwd() },
        }
        syncs.push(session)
        return json({ data: session })
      }
      return undefined
    },
  })

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Active root"))
  const beforeUpdate = listCalls
  dispatch("session.archive.toggle")
  dispatch("session.archive.toggle")
  await setup.waitForFrame(() => updates.length === 1)

  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({ archive: expect.any(Number) })
  expect(listCalls).toBe(beforeUpdate)

  archived = (updates[0] as { archive: number }).archive
  patch.resolve(new Response(null, { status: 204 }))
  await setup.waitFor(() => syncs.length === 1 && listCalls > beforeUpdate)

  expect(listCalls).toBeGreaterThan(beforeUpdate)
  expect((syncs[0] as { time: { archived?: number } }).time.archived).toBe(archived)
  expect((refetchedRows[0][0] as { time: { archived?: number } }).time.archived).toBe(archived)
})
