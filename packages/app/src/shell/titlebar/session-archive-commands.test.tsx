/**
 * @spec-handoff
 * @interface useTitlebarArchiveCommands(): void
 * @behavior
 *   - Registers exactly session.archive, session.unarchive, and session.archived.browse once in the current Titlebar command registry.
 *   - Resolves actions only against the current v2 route/selection server; absent servers fail closed.
 *   - Restores eligible root sessions after the void v2 update response by clearing the cached session archive time and opening its tab.
 * @edge-cases
 *   - A rejected restore shows an error without Home or tab effects; archive timestamp 0 is archived.
 *   - Browse opens DialogArchivedSessions with the resolved server and never falls back across a session route.
 * @see ./dialog-archived-sessions.tsx
 * @see ../../home/sessions/archive.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

type Server = { id: string }
type Session = {
  id: string
  parentID?: string
  location: { directory: string }
  time: { archived?: number }
}
type Command = { id: string; disabled?: boolean; onSelect?: () => void }

let route: { type: "session" | "draft" | "home" | "settings" | "connect"; server?: string; sessionId?: string }
let selection: { server?: string }
let servers: Server[]
let sessions = new Map<string, Session>()
let registered: Array<{ key: string; options: () => Command[] }> = []
let updateCalls: unknown[] = []
let archiveHelperCalls: unknown[] = []
let opened: string[] = []
let touched: string[] = []
let addedTabs: unknown[] = []
let selectedTabs: unknown[] = []
let newDrafts: unknown[] = []
let dialogs: unknown[] = []
let toasts: unknown[] = []
let archiveFailure: unknown
let restoreFailure: unknown

function installMocks() {
  mock.module("@/shell/commands/command", () => ({
    useCommand: () => ({ register: (key: string, options: () => Command[]) => registered.push({ key, options }) }),
    parseKeybind: (config: string) =>
      config.split(",").map((combo) => {
        const parts = combo.trim().toLowerCase().split("+")
        return {
          key: parts.find((part) => !["ctrl", "control", "mod", "meta", "cmd", "command", "shift", "alt", "option"].includes(part)) ?? "",
          ctrl: parts.includes("ctrl") || parts.includes("control") || parts.includes("mod"),
          meta: parts.includes("meta") || parts.includes("cmd") || parts.includes("command"),
          shift: parts.includes("shift"),
          alt: parts.includes("alt") || parts.includes("option"),
        }
      }),
    matchKeybind: (keybinds: Array<{ key: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }>, event: KeyboardEvent) =>
      keybinds.some(
        (keybind) =>
          keybind.key === event.key.toLowerCase() &&
          keybind.ctrl === event.ctrlKey &&
          keybind.meta === event.metaKey &&
          keybind.shift === event.shiftKey &&
          keybind.alt === event.altKey,
      ),
  }))
  mock.module("@/shell/state/layout", () => ({
    useLayout: () => ({ route: () => route, home: { selection: () => selection } }),
  }))
  mock.module("@/runtime/server/registry", () => ({
    ServerConnection: { key: (server: Server) => server.id },
  }))
  mock.module("@/runtime/server/runtime", () => ({
    useGlobal: () => ({
      servers: { list: () => servers },
      ensureServerCtx: (server: Server) => ({
        sdk: {
          api: {
            session: {
              update: async (input: { sessionID: string; archive: number | null }) => {
                updateCalls.push({ server: server.id, ...input })
                if (input.archive === null && restoreFailure) throw restoreFailure
                if (input.archive !== null && archiveFailure) throw archiveFailure
                return undefined
              },
            },
          },
        },
        data: {
          session: {
            get: (id: string) => sessions.get(id),
            remember: (session: Session) => sessions.set(session.id, session),
            invalidate: () => undefined,
          },
        },
        projects: { open: (directory: string) => opened.push(directory), touch: (directory: string) => touched.push(directory) },
      }),
    }),
  }))
  mock.module("@/shell/tabs/tabs", () => ({
    useTabs: () => ({
      addSessionTab: (input: unknown) => {
        addedTabs.push(input)
        return input
      },
      select: (tab: unknown) => selectedTabs.push(tab),
      newDraft: async (input: unknown) => newDrafts.push(input),
    }),
  }))
  mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("@/shell/notifications/toast", () => ({ showToast: (input: unknown) => toasts.push(input) }))
  mock.module("@/shell/layout/helpers", () => ({ errorMessage: (error: unknown) => String(error) }))
  mock.module("@opencode/ui/context/dialog", () => ({
    useDialog: () => ({ show: (view: unknown) => dialogs.push(view) }),
    useDialogLayer: () => undefined,
  }))
  mock.module("@/home/sessions/archive", () => ({
  archiveHomeSession: async (input: {
    session: Session
    archive: (request: { sessionID: string; archive: number }) => Promise<unknown>
    commit: (archivedAt: number) => void
  }) => {
    archiveHelperCalls.push(input)
    const archivedAt = Date.now()
    try {
      await input.archive({ sessionID: input.session.id, archive: archivedAt })
      input.commit(archivedAt)
      return true
    } catch {
      return false
    }
  },
  }))
}

type ArchiveModule = typeof import("./session-archive-commands") & {
  useTitlebarArchiveCommands?: () => void
}

async function mount() {
  const module = (await import("./session-archive-commands")) as ArchiveModule
  expect(module.useTitlebarArchiveCommands).toBeTypeOf("function")
  createRoot((dispose) => {
    module.useTitlebarArchiveCommands!()
    dispose()
  })
  expect(registered).toHaveLength(1)
  return registered[0]!.options()
}

beforeAll(installMocks)

function command(options: Command[], id: string) {
  const result = options.find((item) => item.id === id)
  expect(result).toBeDefined()
  return result!
}

function root(overrides: Partial<Session> = {}): Session {
  return { id: "root", location: { directory: "/work" }, time: {}, ...overrides }
}

beforeEach(() => {
  route = { type: "session", server: "one", sessionId: "root" }
  selection = { server: "one" }
  servers = [{ id: "one" }, { id: "two" }]
  sessions = new Map([["root", root()], ["next", root({ id: "next" })]])
  registered = []
  updateCalls = []
  archiveHelperCalls = []
  opened = []
  touched = []
  addedTabs = []
  selectedTabs = []
  newDrafts = []
  dialogs = []
  toasts = []
  archiveFailure = undefined
  restoreFailure = undefined
})

afterAll(() => mock.restore())

describe("current-v2 Titlebar archive commands", () => {
  test("registers one keyed titlebar entry with exactly the three archive IDs", async () => {
    const options = await mount()

    expect(registered[0]?.key).toBe("titlebar.session-archive")
    expect(options.map((item) => item.id)).toEqual(["session.archive", "session.unarchive", "session.archived.browse"])
  })

  test("uses the exact route server for session and draft routes, never a listed fallback", async () => {
    route = { type: "session", server: "missing", sessionId: "root" }
    const options = await mount()

    expect(options.map((item) => [item.id, item.disabled])).toEqual([
      ["session.archive", true],
      ["session.unarchive", true],
      ["session.archived.browse", true],
    ])
    command(options, "session.archive").onSelect?.()
    command(options, "session.archived.browse").onSelect?.()
    expect([updateCalls, archiveHelperCalls, dialogs]).toEqual([[], [], []])
  })

  test("uses selection then the first listed server for home, settings, and connect routes", async () => {
    route = { type: "home" }
    selection = { server: "two" }
    expect(command(await mount(), "session.archived.browse").disabled).not.toBe(true)

    registered = []
    route = { type: "settings" }
    selection = {}
    const options = await mount()
    expect(command(options, "session.archived.browse").disabled).not.toBe(true)
    command(options, "session.archived.browse").onSelect?.()
    expect(dialogs).toHaveLength(1)
  })

  test("disables every action and makes no API request when no server exists", async () => {
    servers = []
    route = { type: "connect" }
    const options = await mount()

    expect(options.every((item) => item.disabled)).toBe(true)
    options.forEach((item) => item.onSelect?.())
    expect([updateCalls, archiveHelperCalls, dialogs]).toEqual([[], [], []])
  })

  test("enables only the applicable root transition, treating archive timestamp 0 as archived", async () => {
    sessions.set("root", root({ parentID: "parent" }))
    let options = await mount()
    expect(command(options, "session.archive").disabled).toBe(true)
    expect(command(options, "session.unarchive").disabled).toBe(true)

    registered = []
    sessions.set("root", root({ time: { archived: 0 } }))
    options = await mount()
    expect(command(options, "session.archive").disabled).toBe(true)
    expect(command(options, "session.unarchive").disabled).not.toBe(true)
  })

  test("archives through the v2 timestamp payload and lands on next, previous, or one new draft only after success", async () => {
    const options = await mount()
    command(options, "session.archive").onSelect?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(archiveHelperCalls).toHaveLength(1)
    expect(updateCalls).toEqual([expect.objectContaining({ server: "one", sessionID: "root", archive: expect.any(Number) })])
    expect(addedTabs).toEqual([])
  })

  test("makes no archive landing, tab, or Home effect after archive failure", async () => {
    archiveFailure = new Error("offline")
    const options = await mount()
    command(options, "session.archive").onSelect?.()
    await Promise.resolve()
    await Promise.resolve()

    expect([opened, touched, addedTabs, selectedTabs, newDrafts]).toEqual([[], [], [], [], []])
  })

  test("restores after the void update response by clearing cached archive time and opening its tab", async () => {
    sessions.set("root", root({ time: { archived: 0 } }))
    const options = await mount()
    command(options, "session.unarchive").onSelect?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(updateCalls).toEqual([{ server: "one", sessionID: "root", archive: null }])
    expect(opened).toEqual(["/work"])
    expect(touched).toEqual(["/work"])
    expect(addedTabs).toEqual([{ server: "one", sessionId: "root" }])
    expect(selectedTabs).toEqual([{ server: "one", sessionId: "root" }])
    expect(sessions.get("root")?.time.archived).toBeUndefined()
    expect(toasts).toEqual([])
  })

  test("keeps all restore success effects absent after an API failure", async () => {
    sessions.set("root", root({ time: { archived: 12 } }))
    restoreFailure = new Error("offline")
    const options = await mount()
    command(options, "session.unarchive").onSelect?.()
    await Promise.resolve()
    await Promise.resolve()

    expect([opened, touched, addedTabs, selectedTabs]).toEqual([[], [], [], []])
    expect(toasts).toHaveLength(1)
  })

  test("opens the current DialogArchivedSessions using the exact resolved server", async () => {
    selection = { server: "two" }
    route = { type: "home" }
    const options = await mount()
    command(options, "session.archived.browse").onSelect?.()

    expect(dialogs).toHaveLength(1)
  })
})
