/**
 * @spec-handoff
 * @interface createTimelineController({ session: TimelineSessionSource }): TimelineController
 * @behavior
 *   - Root sessions expose one archive-toggle menu model: active sessions label Archive and archived
 *     sessions label Unarchive; a model never exposes the opposite action.
 *   - archive() sends exactly { sessionID, archive: Date.now() }; after success it remembers,
 *     evicts, selects an active root fallback, and emits one removed-tab event.
 *   - Unarchive sends { sessionID, archive: null }; its 204/void success clears local archived state
 *     and navigates to the restored session without evicting it.
 *   - While the request is pending or fails, archive() has no success side effects; failures
 *     surface common.requestFailed and return false.
 *   - A route changed while pending must not be navigated by the settled request.
 * @edge-cases
 *   - Archived timestamp 0 is archived; child sessions and archived roots are not fallback targets.
 *   - Unarchive must not read an API response body to construct the restored local session.
 *   - With no active root fallback, open tabs.newDraft({ server, directory }).
 * @see ./controller.tsx
 */

import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test"
import { createRoot } from "solid-js"
import type { SessionStateKey } from "@/runtime/server/scope"
import { createTimelineController } from "./controller"

const fixedNow = new Date("2026-10-13T12:00:00.000Z")
const requestCalls: unknown[] = []
const remembered: unknown[] = []
const evicted: string[] = []
const navigated: string[] = []
const drafts: unknown[] = []
const notifications: unknown[] = []
const toasts: unknown[] = []
const effects: string[] = []
let request: () => Promise<void>
let sessions: Array<Record<string, unknown>> = []

mock.module("@solidjs/router", () => ({
  useNavigate: () => (href: string) => {
    effects.push(`navigate:${href}`)
    navigated.push(href)
  },
}))
mock.module("@/workspaces/location", () => ({
  useWorkspaceLocation: () => () => ({ directory: "/workspace" }),
}))
mock.module("@/runtime/server/client", () => ({
  useServerSDK: () => ({
    api: { session: { update: async (input: unknown) => {
      requestCalls.push(input)
      await request()
    } } },
  }),
}))
mock.module("@/runtime/server/current", () => ({
  useServer: () => ({
    key: "server-1",
    ctx: {
      data: {
        session: {
          pending: { list: () => [] },
          get: (id: string) => sessions.find((session) => session.id === id),
          list: () => sessions,
          remember: (session: unknown) => {
            effects.push("remember")
            remembered.push(session)
          },
          evict: (id: string) => {
            effects.push(`evict:${id}`)
            evicted.push(id)
          },
          message: { list: () => [] },
        },
      },
    },
  }),
  useData: () => ({}),
}))
mock.module("@/settings/model", () => ({
  useSettings: () => ({ general: { timelineDetail: () => ({ shell: {}, edit: {}, thinking: {}, subagents: {}, notices: {}, tools: {} }) } }),
}))
mock.module("@/shell/tabs/tabs", () => ({
  useTabs: () => ({ newDraft: (input: unknown) => {
    effects.push("new-draft")
    drafts.push(input)
  } }),
}))
mock.module("@opencode/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined, close: () => undefined }),
  useDialogLayer: () => undefined,
}))
mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/runtime/platform/platform", () => ({ usePlatform: () => ({}) }))
mock.module("@/session/handoff", () => ({ getSessionMessageHandoff: () => undefined }))
mock.module("@/shell/titlebar/session-events", () => ({ notifySessionTabsRemoved: (input: unknown) => {
  effects.push("tab-event")
  notifications.push(input)
} }))
mock.module("@/shell/notifications/toast", () => ({ showToast: (input: unknown) => toasts.push(input) }))
mock.module("./controller-projection", () => ({
  applyTimelineMessageHandoff: (value: unknown) => value,
  timelineChildTitle: ({ title }: { title: string }) => title,
}))
mock.module("./projection", () => ({ createTimelineProjection: () => ({}) }))

const activeRoot = (id: string) => ({ id, time: { created: 1, updated: 1 } })

function createController(input: { id?: string; routeID?: () => string | undefined; parentID?: string }) {
  let controller: ReturnType<typeof createTimelineController> | undefined
  const dispose = createRoot((cleanup) => {
    controller = createTimelineController({
      session: {
        identity: {
          params: { get id() { return input.routeID?.() ?? input.id } },
          sessionID: () => input.id,
          sessionKey: () => "session-key" as SessionStateKey,
        },
        data: {
          info: () => sessions.find((session) => session.id === input.id) as never,
          parent: () => undefined,
          parentID: () => input.parentID,
          status: () => ({ type: "idle" }),
        },
        history: { messages: () => [] },
      },
    })
    return cleanup
  })
  return { controller: controller!, dispose }
}

function archive(controller: ReturnType<typeof createController>["controller"]) {
  const action = controller.action as typeof controller.action & { archive?: () => Promise<boolean> }
  if (!action.archive) throw new Error("Timeline controller must expose archive() for root sessions")
  return action.archive()
}

function archiveToggle(controller: ReturnType<typeof createController>["controller"]) {
  const action = controller.action as typeof controller.action & {
    archiveToggle?: { labelKey: "common.archive" | "common.unarchive"; run: () => Promise<boolean> }
  }
  if (!action.archiveToggle) throw new Error("Timeline controller must expose an archive-toggle menu model for root sessions")
  return action.archiveToggle
}

beforeEach(() => {
  setSystemTime(fixedNow)
  request = async () => undefined
  sessions = [activeRoot("root-current")]
  requestCalls.length = 0
  remembered.length = 0
  evicted.length = 0
  navigated.length = 0
  drafts.length = 0
  notifications.length = 0
  toasts.length = 0
  effects.length = 0
})

afterEach(() => setSystemTime())

describe("createTimelineController archive action", () => {
  test("exposes archive for a root session but not for a child", () => {
    const root = createController({ id: "root-current" })
    const child = createController({ id: "child", parentID: "root-current" })

    expect((root.controller.action as { archive?: unknown }).archive).toBeTypeOf("function")
    expect((child.controller.action as { archive?: unknown }).archive).toBeUndefined()
    root.dispose()
    child.dispose()
  })

  test("sends the frozen canonical payload and has no success effects before the request settles", async () => {
    let settle!: () => void
    request = () => new Promise<void>((resolve) => (settle = resolve))
    const { controller, dispose } = createController({ id: "root-current" })

    const result = archive(controller)
    expect(requestCalls).toEqual([{ sessionID: "root-current", archive: fixedNow.getTime() }])
    expect(remembered).toEqual([])
    expect(evicted).toEqual([])
    expect(navigated).toEqual([])
    expect(drafts).toEqual([])
    expect(notifications).toEqual([])

    settle()
    await result
    dispose()
  })

  test("remembers, evicts, navigates to the next active root, then emits one tab event", async () => {
    sessions = [activeRoot("root-current"), activeRoot("root-next"), { ...activeRoot("archived-zero"), time: { archived: 0 } }, { ...activeRoot("child"), parentID: "root-current" }]
    const { controller, dispose } = createController({ id: "root-current" })

    await expect(archive(controller)).resolves.toBeTrue()
    expect(remembered).toEqual([{ ...activeRoot("root-current"), time: { ...activeRoot("root-current").time, archived: fixedNow.getTime() } }])
    expect(evicted).toEqual(["root-current"])
    expect(navigated).toEqual(["/server/c2VydmVyLTE/session/root-next"])
    expect(notifications).toEqual([{ server: "server-1", directory: "/workspace", sessionIDs: ["root-current"] }])
    expect(effects).toEqual(["remember", "evict:root-current", "navigate:/server/c2VydmVyLTE/session/root-next", "tab-event"])
    dispose()
  })

  test("navigates to the prior active root when no next active root exists", async () => {
    sessions = [activeRoot("root-prior"), activeRoot("root-current"), { ...activeRoot("archived-zero"), time: { archived: 0 } }, { ...activeRoot("child"), parentID: "root-current" }]
    const { controller, dispose } = createController({ id: "root-current" })

    await expect(archive(controller)).resolves.toBeTrue()
    expect(navigated).toEqual(["/server/c2VydmVyLTE/session/root-prior"])
    dispose()
  })

  test("opens a context-preserving draft when archiving the final active root", async () => {
    const { controller, dispose } = createController({ id: "root-current" })

    await expect(archive(controller)).resolves.toBeTrue()
    expect(drafts).toEqual([{ server: "server-1", directory: "/workspace" }])
    expect(navigated).toEqual([])
    dispose()
  })

  test("returns false and surfaces requestFailed without success effects when the request fails", async () => {
    request = async () => Promise.reject(new Error("network down"))
    const { controller, dispose } = createController({ id: "root-current" })

    await expect(archive(controller)).resolves.toBeFalse()
    expect(toasts).toEqual([{ title: "common.requestFailed", description: "network down" }])
    expect(remembered).toEqual([])
    expect(evicted).toEqual([])
    expect(navigated).toEqual([])
    expect(notifications).toEqual([])
    dispose()
  })

  test("settles non-current requests without navigating the route that replaced them", async () => {
    let settle!: () => void
    request = () => new Promise<void>((resolve) => (settle = resolve))
    const route = { id: "root-current" }
    const { controller, dispose } = createController({ id: "root-current", routeID: () => route.id })
    const result = archive(controller)
    route.id = "another-root"
    settle()

    await expect(result).resolves.toBeTrue()
    expect(remembered).toHaveLength(1)
    expect(evicted).toEqual(["root-current"])
    expect(notifications).toEqual([{ server: "server-1", directory: "/workspace", sessionIDs: ["root-current"] }])
    expect(navigated).toEqual([])
    dispose()
  })

  test("exposes only the Unarchive menu model for an archived root session", () => {
    sessions = [{ ...activeRoot("root-current"), time: { created: 1, updated: 1, archived: 0 } }]
    const { controller, dispose } = createController({ id: "root-current" })

    expect(archiveToggle(controller).labelKey).toBe("common.unarchive")
    expect((controller.action as { archive?: unknown }).archive).toBeUndefined()
    dispose()
  })

  test("exposes only the Archive menu model for an active root session", () => {
    const { controller, dispose } = createController({ id: "root-current" })

    expect(archiveToggle(controller).labelKey).toBe("common.archive")
    expect((controller.action as { unarchive?: unknown }).unarchive).toBeUndefined()
    dispose()
  })

  test("unarchives with a void response, clears local archived state, and stays on the restored session", async () => {
    sessions = [{ ...activeRoot("root-current"), time: { created: 1, updated: 1, archived: 0 } }]
    const { controller, dispose } = createController({ id: "root-current" })

    await expect(archiveToggle(controller).run()).resolves.toBeTrue()
    expect(requestCalls).toEqual([{ sessionID: "root-current", archive: null }])
    expect(remembered).toEqual([{ ...activeRoot("root-current"), time: { created: 1, updated: 1, archived: undefined } }])
    expect(evicted).toEqual([])
    expect(notifications).toEqual([])
    expect(navigated).toEqual(["/server/c2VydmVyLTE/session/root-current"])
    dispose()
  })

  test("keeps archived local state and the current route when unarchive fails", async () => {
    request = async () => Promise.reject(new Error("network down"))
    sessions = [{ ...activeRoot("root-current"), time: { created: 1, updated: 1, archived: 0 } }]
    const { controller, dispose } = createController({ id: "root-current" })

    await expect(archiveToggle(controller).run()).resolves.toBeFalse()
    expect(toasts).toEqual([{ title: "common.requestFailed", description: "network down" }])
    expect(remembered).toEqual([])
    expect(evicted).toEqual([])
    expect(navigated).toEqual([])
    dispose()
  })
})
