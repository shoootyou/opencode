/**
 * @spec-handoff
 * @interface DialogArchivedSessions(props: { server: ServerConnection.Any }): JSX.Element
 * @behavior
 *   - Loads the complete archived-root aggregate once per open/retry; search filters that cached aggregate locally.
 *   - Restores a selected archived root with `{ sessionID, archive: null }` and commits effects only after success.
 *   - A void successful restore clears the selected cached session archive time, updates Home/tabs once, then closes.
 * @edge-cases
 *   - Loading, a later-page/repeated-cursor failure, and retry are visible; failures never masquerade as empty results.
 *   - Pending, rejected, or disposed restores have no success-only cache, Home, tab, navigation, or close effects.
 * @see ./browse-archived.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { SessionInfo, SessionListInput, SessionListOutput } from "@opencode/client/promise"
import type { ArchivedEntry } from "./browse-archived"

type ListProps = {
  items: () => Promise<unknown[]> | unknown[]
  onSelect: (entry: ArchivedEntry | undefined) => void
}

let listProps: ListProps | undefined
let retry: (() => void) | undefined
let requestCalls: unknown[] = []
let restoreCalls: unknown[] = []
let cacheWrites: unknown[] = []
let homeEffects: string[] = []
let tabEffects: unknown[] = []
let navigation: string[] = []
let closeCount = 0
let toasts: unknown[] = []
let listRequest: (input: SessionListInput) => Promise<SessionListOutput>
let restoreRequest: (input: { sessionID: string; archive: null }) => Promise<void>

const queryClient = {
  setQueryData: (...input: unknown[]) => cacheWrites.push(input),
  invalidateQueries: (...input: unknown[]) => cacheWrites.push(input),
}

function installMocks() {
  // These are complete current-v2 module overrides. Do not mix legacy `@/context/*` or SDK-v2
  // doubles into this harness: Bun retains module mocks for the test process.
  mock.module("@tanstack/solid-query", () => ({ useQueryClient: () => queryClient }))
  mock.module("@opencode/ui/context/dialog", () => ({
  useDialog: () => ({ close: () => closeCount++ }),
  }))
// Do not import the real dialog module here: its Kobalte implementation cannot run under
// this harness. These stand-ins cover every v2 export consumed by the component.
  mock.module("@opencode/ui/dialog", () => ({
  Dialog: (props: { children?: unknown }) => props.children,
  DialogHeader: (props: { children?: unknown }) => props.children,
  DialogTitle: (props: { children?: unknown }) => props.children,
  }))
  mock.module("@opencode/ui/button", () => ({
  Button: (props: { onClick?: () => void; children?: unknown }) => {
    if (props.onClick) retry = props.onClick
    return props.children
  },
  }))
  mock.module("@opencode/ui/icon", () => ({ Icon: () => undefined }))
  mock.module("@opencode/ui/list", () => ({
  List: (props: ListProps) => {
    listProps = props
    return undefined
  },
  }))
  mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("@/shell/notifications/toast", () => ({ showToast: (input: unknown) => toasts.push(input) }))
  mock.module("@/shell/layout/helpers", () => ({ errorMessage: (error: unknown) => String(error) }))
  mock.module("@/shell/time", () => ({ getRelativeTime: () => "now" }))
  mock.module("@/runtime/server/registry", () => ({
  ServerConnection: { key: () => "server-key" },
  }))
  mock.module("@/runtime/server/runtime", () => ({
  useGlobal: () => ({
    ensureServerCtx: () => ({
      data: { session: { remember: (session: unknown) => cacheWrites.push(["remember", session]) } },
      sync: { data: { path: { home: "/home/test" } } },
      sdk: {
        api: {
          session: {
            list: async (input: SessionListInput) => {
              requestCalls.push(input)
              return listRequest(input)
            },
            update: async (input: { sessionID: string; archive: null }) => {
              restoreCalls.push(input)
              return restoreRequest(input)
            },
          },
        },
      },
      projects: {
        open: (directory: string) => homeEffects.push(`open:${directory}`),
        touch: (directory: string) => homeEffects.push(`touch:${directory}`),
      },
    }),
  }),
  }))
  mock.module("@/home/sessions/index", () => ({
  HOME_SESSION_LIMIT: 64,
  retainHomeSessions: (sessions: SessionInfo[]) => sessions,
  }))
  mock.module("@/shell/tabs/tabs", () => ({
  useTabs: () => ({
    addSessionTab: (input: unknown) => {
      tabEffects.push(["add", input])
      return input
    },
    select: (tab: unknown) => tabEffects.push(["select", tab]),
  }),
  }))
}

let DialogArchivedSessions: typeof import("./dialog-archived-sessions")["DialogArchivedSessions"]

beforeAll(async () => {
  installMocks()
  ;({ DialogArchivedSessions } = await import("./dialog-archived-sessions"))
})

const archived = (id = "archived-1"): SessionInfo =>
  ({
    id,
    title: "Archived root",
    location: { directory: "/work/project" },
    time: { created: 1, updated: 2, archived: 3 },
  }) as SessionInfo

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function waitForSettled(condition: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for dialog state to settle")
}

function mount() {
  let dispose!: () => void
  createRoot((cleanup) => {
    dispose = cleanup
    DialogArchivedSessions({ server: { type: "http", http: { url: "http://localhost:4096" } } as never })
  })
  return () => dispose()
}

beforeEach(() => {
  listProps = undefined
  retry = undefined
  requestCalls = []
  restoreCalls = []
  cacheWrites = []
  homeEffects = []
  tabEffects = []
  navigation = []
  closeCount = 0
  toasts = []
  listRequest = async () => ({ data: [archived()], cursor: { next: null } })
  restoreRequest = async () => undefined
})

afterAll(() => mock.restore())

describe("DialogArchivedSessions v2 archived lifecycle (red until U3-D implementation)", () => {
  test("loads every cursor exactly once per opening, stays loading until the full aggregate resolves, and renders [] as empty", async () => {
    const first = deferred<SessionListOutput>()
    const second = deferred<SessionListOutput>()
    listRequest = async (input) => (requestCalls.length === 1 ? first.promise : second.promise)
    const dispose = mount()
    await flush()

    expect(requestCalls).toEqual([{ archived: true, parentID: null }])
    expect(listProps).toBeDefined()
    expect(listProps!.items()).toBeInstanceOf(Promise)

    first.resolve({ data: [archived("first")], cursor: { next: "next" } })
    await flush()
    expect(requestCalls).toEqual([{ archived: true, parentID: null }, { archived: true, parentID: null, cursor: "next" }])
    second.resolve({ data: [], cursor: { next: null } })
    await flush()
    await expect(Promise.resolve(listProps!.items())).resolves.toEqual([expect.objectContaining({ id: "first" })])
    dispose()
  })

  test("shows a loader/repeated-cursor error rather than empty state and retry starts a fresh aggregate", async () => {
    listRequest = async () => ({ data: [archived()], cursor: { next: "again" } })
    const dispose = mount()
    await waitForSettled(() => toasts.length === 1 && retry !== undefined)

    expect(toasts).toHaveLength(1)
    expect(retry).toBeDefined()
    retry!()
    await waitForSettled(() => toasts.length === 2 && requestCalls.length === 4)
    expect(requestCalls).toHaveLength(4)
    dispose()
  })

  test("filters the cached complete aggregate locally without another list request", async () => {
    listRequest = async () => ({ data: [archived("match"), archived("other")], cursor: { next: null } })
    const dispose = mount()
    await flush()

    await listProps!.items()
    await listProps!.items()
    expect(requestCalls).toHaveLength(1)
    dispose()
  })

  test("sends exactly { sessionID, archive: null }, suppresses duplicate pending selection, and has no pre-success effects", async () => {
    const pending = deferred<void>()
    restoreRequest = () => pending.promise
    const dispose = mount()
    await flush()

    listProps!.onSelect({ id: "archived-1", title: "Archived root", directory: "/work/project", archivedAt: 3, session: archived() })
    listProps!.onSelect({ id: "archived-1", title: "Archived root", directory: "/work/project", archivedAt: 3, session: archived() })
    await flush()
    expect(restoreCalls).toEqual([{ sessionID: "archived-1", archive: null }])
    expect([cacheWrites, homeEffects, tabEffects, navigation, closeCount]).toEqual([[], [], [], [], 0])
    pending.resolve()
    dispose()
  })

  test("keeps the row and dialog open on restore failure, emits one error, and commits no success effects", async () => {
    restoreRequest = async () => { throw new Error("restore failed") }
    const dispose = mount()
    await flush()

    listProps!.onSelect({ id: "archived-1", title: "Archived root", directory: "/work/project", archivedAt: 3, session: archived() })
    await flush()
    expect(closeCount).toBe(0)
    expect(toasts).toHaveLength(1)
    expect([cacheWrites, homeEffects, tabEffects, navigation]).toEqual([[], [], [], []])
    dispose()
  })

  test("uses the selected cached session after a void update to clear archive time, reconcile Home and open one server-scoped tab", async () => {
    restoreRequest = async () => undefined
    const dispose = mount()
    await flush()

    listProps!.onSelect({ id: "archived-1", title: "Archived root", directory: "/work/project", archivedAt: 3, session: archived() })
    await flush()
    expect(cacheWrites).toContainEqual([
      "remember",
      expect.objectContaining({ id: "archived-1", time: expect.objectContaining({ archived: undefined }) }),
    ])
    expect(homeEffects).toEqual(["open:/work/project", "touch:/work/project"])
    expect(tabEffects).toEqual([
      ["add", expect.objectContaining({ sessionId: "archived-1" })],
      ["select", expect.anything()],
    ])
    expect(navigation).toEqual([])
    expect(closeCount).toBe(1)
    expect(toasts).toEqual([])
    dispose()
  })

  test("does not commit settled restore effects after the dialog owner unmounts while pending", async () => {
    const pending = deferred<void>()
    restoreRequest = () => pending.promise
    const dispose = mount()
    await flush()

    listProps!.onSelect({ id: "archived-1", title: "Archived root", directory: "/work/project", archivedAt: 3, session: archived() })
    await flush()
    dispose()
    pending.resolve()
    await flush()

    expect([cacheWrites, homeEffects, tabEffects, navigation, closeCount]).toEqual([[], [], [], [], 0])
  })
})
