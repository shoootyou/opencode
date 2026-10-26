/**
 * @spec-handoff
 * @interface createSessionListModel(input: SessionListModelInput): SessionListModel
 * @behavior
 *   - Keeps showArchived in the list resource identity.
 *   - Sends archived:false for active roots or true for archived roots.
 *   - Shows active root sessions by default and archived root sessions (including timestamp 0) when enabled.
 *   - Applies the current archive filter to network, latest, loading, error, and local-fallback data.
 * @edge-cases
 *   - A completion for the prior archive-filter identity never becomes visible.
 *   - Child sessions never appear in either view.
 * @see ../src/component/dialog-session-list.tsx
 */
import { expect, test } from "bun:test"
import { Definitions } from "../src/config/keybind"

type Session = {
  id: string
  parentID?: string
  title: string
  time: { archived?: number }
}

type Identity = {
  query: string
  allProjects: boolean
  location: string
  showArchived: boolean
}

type Result = {
  identity: Identity
  sessions: Session[]
  error?: unknown
}

type SessionListModel = {
  identity: Identity
  request: { archived?: boolean }
  visible(input: { local: Session[]; latest?: Result; result?: Result; loading: boolean }): Session[]
}

type SessionListModule = {
  createSessionListModel?: (input: Identity) => SessionListModel
}

const active: Session = { id: "active", title: "Active root", time: {} }
const archivedAtEpoch: Session = { id: "archived-zero", title: "Archived root", time: { archived: 0 } }
const archivedChild: Session = { id: "archived-child", parentID: "archived-zero", title: "Archived child", time: { archived: 2 } }

async function createModel(showArchived: boolean) {
  const subject: SessionListModule = await import("../src/component/dialog-session-list")
  expect(subject.createSessionListModel).toBeTypeOf("function")
  return subject.createSessionListModel!({ query: "", allProjects: true, location: "/fixture", showArchived })
}

test("defines archive dialog keybinds as discoverable opt-in commands", () => {
  expect(Definitions["session.archive.toggle"]).toEqual({
    default: "none",
    description: "Archive or unarchive the selected session",
  })
  expect(Definitions["session.archived.toggle_visibility"]).toEqual({
    default: "none",
    description: "Show or hide archived sessions",
  })
})

test("starts each session-list opening with active roots and an active-only request identity", async () => {
  const model = await createModel(false)

  expect(model.identity).toEqual({ query: "", allProjects: true, location: "/fixture", showArchived: false })
  expect(model.request).toEqual({ archived: false })
  expect(model.visible({ local: [active, archivedAtEpoch, archivedChild], loading: false })).toEqual([active])
})

test("shows only archived roots and uses archived-only HTTP mode when archive visibility is enabled", async () => {
  const model = await createModel(true)

  expect(model.request).toEqual({ archived: true })
  expect(model.visible({ local: [active, archivedAtEpoch, archivedChild], loading: false })).toEqual([archivedAtEpoch])
})

test("does not flash an in-flight result belonging to the prior archive filter", async () => {
  const model = await createModel(false)
  const archivedIdentity = { ...model.identity, showArchived: true }

  expect(
    model.visible({
      local: [active],
      latest: { identity: archivedIdentity, sessions: [archivedAtEpoch] },
      loading: true,
    }),
  ).toEqual([active])
})

test("enforces the current archive filter on empty-query local fallback, errors, and loading results", async () => {
  const model = await createModel(true)
  const current = model.identity

  expect(model.visible({ local: [active, archivedAtEpoch], loading: false })).toEqual([archivedAtEpoch])
  expect(
    model.visible({
      local: [active, archivedAtEpoch],
      result: { identity: current, sessions: [active], error: new Error("offline") },
      loading: false,
    }),
  ).toEqual([archivedAtEpoch])
  expect(
    model.visible({
      local: [active],
      latest: { identity: current, sessions: [active, archivedAtEpoch, archivedChild] },
      loading: true,
    }),
  ).toEqual([archivedAtEpoch])
})
