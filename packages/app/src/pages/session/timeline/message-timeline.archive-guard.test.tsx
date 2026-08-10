/**
 * @spec-handoff
 * @behavior
 *   Behavioral coverage for the `protocol !== "v1"` guard on `message-timeline.tsx`'s
 *   independently-added `archiveSession`/`unarchiveSession` functions (lines ~837-875),
 *   introduced by remediation commit `1b29e28659` during the v1.18.15 fork sync — the same
 *   guard shape as `session-archive-commands.tsx`'s (covered separately in
 *   `../../../components/session-archive-commands.test.tsx`), but this is a SEPARATE,
 *   independently-added pair of functions local to this file, not a shared import, so it needs
 *   its own coverage.
 * @edge-cases
 *   - protocol resolves to something other than "v1" (e.g. "v2") → `client.session.update(...)`
 *     must never be called for either archive or unarchive.
 *   - protocol resolves to "v1" → `client.session.update(...)` is called once with the expected
 *     `{ sessionID, directory, time: { archived: <number> } }` shape for archive, and the
 *     unarchive-patch equivalent for unarchive.
 * @testability
 *   `message-timeline.tsx` is a large, deeply-context-coupled SolidJS component (10+ contexts:
 *   sync, sdk, server-sdk, settings, tabs, dialog, language, session-key, platform, file, plus
 *   TanStack Query/Virtual and several `@opencode-ai/ui`/`@kobalte` component subtrees). The
 *   sibling `message-timeline.archive-toggle.test.ts` documents (and this file's own probing
 *   confirmed) that `bun test`'s React-shim cannot forward `props.children` through NESTED
 *   `createSimpleContext` providers wrapped around each other — but this file does NOT need
 *   nested providers, because every context this component touches is itself mocked via
 *   `mock.module` (the same technique `session-archive-commands.test.tsx` established), so the
 *   component's own `use*()` calls resolve directly to plain mock objects with no provider tree
 *   at all. This sidesteps the documented limitation rather than fighting it.
 *   Getting a full render working required transitively mocking every module `message-timeline.tsx`
 *   imports that itself throws when used outside ITS OWN real ancestor (Kobalte's `Popover`,
 *   `DropdownMenu`/`MenuV2`'s internal Kobalte `Menu` context, `TextField`'s `FormControl`
 *   context, and `ScrollView`'s `createResizeObserver` call against a real element) — none of
 *   which are the code under test, so they are stubbed to inert passthroughs.
 *   `DropdownMenu.Item`'s `onSelect` handlers are captured in call order (the fallback branch is
 *   selected here because `settings.general.newLayoutDesigns()` is mocked `false`); the toggle
 *   item is the 4th one registered (rename, share, export, archive/unarchive, delete) — pinned
 *   by asserting its resolved label matches `common.archive`/`common.unarchive` before invoking
 *   it, so a reordering of the menu would fail loudly here instead of silently invoking the
 *   wrong handler.
 *   The mount container is deliberately kept detached from `document.body` and
 *   `requestAnimationFrame`/`cancelAnimationFrame` are stubbed for the synchronous duration of
 *   the `render()` call — both only to avoid mutating shared `happy-dom` global state
 *   (`document.body`, the RAF queue) that sibling test files in the same `bun test` process read
 *   from (`./observe-element-offset.test.ts` in particular), not because this test's own
 *   assertions need either.
 * @see ./message-timeline.tsx (archiveSession/unarchiveSession, lines ~837-875)
 * @see ./message-timeline.archive-toggle.test.ts (structural source-text pin for the same guard)
 * @see ../../../components/session-archive-commands.test.tsx (equivalent behavioral guard test
 *   for the sibling `useSessionArchiveCommands` hook)
 */

import { describe, expect, mock, test } from "bun:test"
import * as realServerSdk from "@/context/server-sdk"
import * as realSolidQuery from "@tanstack/solid-query"
import * as realSolidVirtual from "@tanstack/solid-virtual"

// ---------------------------------------------------------------------------
// Stub every module message-timeline.tsx imports that either (a) is a context/hook this
// component consumes directly, or (b) throws when mounted without ITS OWN real ancestor
// (Kobalte internals). None of these are the code under test.
// ---------------------------------------------------------------------------
mock.module("@opencode-ai/session-ui/message-part", () => ({
  ContextToolGroup: () => null,
  Message: () => null,
  MessageDivider: () => null,
  Part: () => null,
  partDefaultOpen: () => false,
  groupParts: () => [],
  renderable: () => true,
  sameGroups: () => true,
}))
mock.module("@opencode-ai/session-ui/session-retry", () => ({
  SessionRetry: () => null,
}))
mock.module("@opencode-ai/session-ui/session-diff", () => ({
  normalize: (x: unknown) => x,
}))
mock.module("@/components/session-context-usage", () => ({
  SessionContextUsage: () => null,
}))
mock.module("@opencode-ai/ui/text-field", () => ({
  TextField: () => null,
}))
mock.module("@kobalte/core/popover", () => {
  const passthrough = (props: { children?: unknown }) => props.children ?? null
  return {
    Popover: Object.assign(passthrough, {
      Portal: passthrough,
      Content: passthrough,
    }),
  }
})

// Captures every DropdownMenu.Item's {onSelect, resolvedLabel} in registration order so the
// test can find "the archive/unarchive toggle" without depending on internal Kobalte behavior.
type CapturedItem = { onSelect?: () => void; label: string }
const capturedDropdownItems: CapturedItem[] = []
mock.module("@opencode-ai/ui/dropdown-menu", () => {
  const passthrough = (props: { children?: unknown }) => props.children ?? null
  const Item = (props: { children?: unknown; onSelect?: () => void }) => {
    capturedDropdownItems.push({ onSelect: props.onSelect, label: String(props.children ?? "") })
    return props.children ?? null
  }
  return {
    DropdownMenu: Object.assign(passthrough, {
      Trigger: passthrough,
      Portal: passthrough,
      Content: passthrough,
      Item,
      ItemLabel: passthrough,
      Separator: passthrough,
    }),
  }
})
mock.module("@opencode-ai/ui/v2/menu-v2", () => {
  const passthrough = (props: { children?: unknown }) => props.children ?? null
  return {
    MenuV2: Object.assign(passthrough, {
      Trigger: passthrough,
      Portal: passthrough,
      Content: passthrough,
      Item: passthrough,
      Separator: passthrough,
    }),
  }
})
mock.module("@opencode-ai/ui/scroll-view", () => ({
  isScrollKeyTarget: () => false,
  scrollKey: () => undefined,
  scrollKeyOwner: () => undefined,
  ScrollView: (props: { children?: unknown; ref?: (el: HTMLDivElement) => void }) => {
    const el = document.createElement("div")
    props.ref?.(el)
    return el
  },
}))
mock.module("@solidjs/router", () => ({
  useNavigate: () => () => undefined,
}))
mock.module("@tanstack/solid-query", () => ({
  // Spread the REAL module's exports first — same rationale as the `@tanstack/solid-virtual`
  // mock below: sibling test files transitively depend on other named exports of this module
  // (e.g. `useQueries`, `QueryClient`) that this test doesn't itself need to override.
  ...realSolidQuery,
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}))
mock.module("@tanstack/solid-virtual", () => ({
  // Spread the REAL module's exports first (static top-level import, not `await import` inside
  // the factory — a dynamic self-import here deadlocks Bun's module resolver) so sibling files
  // that need the real `observeElementOffset` (e.g. `./observe-element-offset.test.ts`, which
  // `mock.module`'s process-wide replacement would otherwise silently break) keep working.
  // Only `createVirtualizer` is actually exercised by `MessageTimeline`'s own logic under test.
  ...realSolidVirtual,
  createVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    resizeItem: () => undefined,
    measurementsCache: [],
    itemSizeCache: new Map(),
    scrollToIndex: () => undefined,
    scrollToEnd: () => undefined,
    range: undefined,
    takeSnapshot: () => [],
  }),
}))
mock.module("@opencode-ai/ui/context/file", () => ({
  useFileComponent: () => () => undefined,
}))
mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined }),
}))
mock.module("@/context/language", () => ({
  useLanguage: () => ({ t: (k: string) => k, plural: (k: string) => k }),
}))
mock.module("@/pages/session/session-layout", () => ({
  useSessionKey: () => ({
    params: { id: "s1", dir: "d1", serverKey: undefined },
    sessionKey: () => "key",
  }),
}))

// Mutable guard state, reset per test.
let guardProtocol: Promise<"v1" | "v2"> = Promise.resolve("v1")
const guardUpdateCalls: unknown[] = []
// Controls whether the mocked session carries an `archived` timestamp — flips which of
// `archiveSession`/`unarchiveSession` the toggle's onSelect invokes (mirrors
// `isSessionArchived(info()?.time?.archived)` in the component under test).
let guardSessionArchived: number | undefined = undefined

mock.module("@/context/server-sdk", () => ({
  // Spread the REAL module's exports first — same rationale as the `@tanstack/*` mocks above:
  // sibling test files transitively depend on other named exports of this module (e.g.
  // `createServerSdkContext`, consumed via `@/context/global`).
  ...realServerSdk,
  useServerSDK: () => () => ({ protocol: guardProtocol, directory: "d1" }),
}))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({}),
}))
mock.module("@/context/settings", () => ({
  // `newLayoutDesigns: false` selects the DropdownMenu (fallback) branch, not MenuV2 — matching
  // the `capturedDropdownItems` collection this test reads from.
  useSettings: () => ({ general: { newLayoutDesigns: () => false, showReasoningSummaries: () => false } }),
}))
mock.module("@/context/tabs", () => ({
  useTabs: () => ({ newDraft: () => undefined }),
}))
mock.module("@/context/sdk", () => ({
  useSDK: () => () => ({
    directory: "d1",
    protocol: guardProtocol,
    client: {
      session: {
        update: async (input: unknown) => {
          guardUpdateCalls.push(input)
        },
      },
    },
  }),
}))
mock.module("@/context/sync", () => ({
  useSync: () => () => ({
    session: {
      get: (id: string) => ({ id, parentID: undefined, directory: "d1", time: { archived: guardSessionArchived } }),
    },
    data: {
      session: [],
      session_status: {},
      message: {},
      session_message: {},
      part: {},
      config: {},
    },
    set: () => undefined,
  }),
}))

async function mountMessageTimeline() {
  const { render } = await import("solid-js/web")
  const mod = await import("./message-timeline")
  const container = document.createElement("div")
  // Deliberately NOT attached to `document.body`: nothing this test asserts on requires the
  // container to be part of the live document (`onSelect` is invoked directly on the captured
  // mock handler, not via a real DOM click), and staying detached avoids mutating the shared
  // `document.body` that `observe-element-offset.test.ts`'s own body-level `MutationObserver`
  // watches in the same `bun test` process.
  const realRaf = globalThis.requestAnimationFrame
  const realCaf = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame
  const dispose = render(
    () =>
      mod.MessageTimeline({
        scroll: { overflow: false, bottom: true, jump: false },
        onResumeScroll: () => undefined,
        setScrollRef: () => undefined,
        onScheduleScrollState: () => undefined,
        onAutoScrollHandleScroll: () => undefined,
        onMarkScrollGesture: () => undefined,
        hasScrollGesture: () => false,
        onUserScroll: () => undefined,
        onHistoryScroll: () => undefined,
        onAutoScrollInteraction: () => undefined,
        shouldAnchorBottom: () => true,
        centered: false,
        setContentRef: () => undefined,
        userMessages: [],
        anchor: (id: string) => id,
      }),
    container,
  )
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
  return {
    container,
    cleanup: () => {
      dispose()
      container.remove()
    },
  }
}

// Finds the captured DropdownMenu.Item whose resolved label is the archive/unarchive toggle
// (`common.archive` or `common.unarchive`, since `useLanguage().t` is mocked to identity), so
// the test invokes the correct handler regardless of menu-item ordering.
function findArchiveToggleOnSelect(): () => void {
  const match = capturedDropdownItems.find((item) => item.label.includes("common.archive") || item.label.includes("common.unarchive"))
  if (!match?.onSelect) throw new Error("archive/unarchive toggle item not found among captured DropdownMenu.Item calls")
  return match.onSelect
}

describe("message-timeline archiveSession/unarchiveSession protocol guard (remediation commit 1b29e28659)", () => {
  test("selecting the archive/unarchive toggle never calls client.session.update when protocol !== 'v1'", async () => {
    guardProtocol = Promise.resolve("v2")
    guardUpdateCalls.length = 0
    capturedDropdownItems.length = 0

    const { cleanup } = await mountMessageTimeline()
    const onSelect = findArchiveToggleOnSelect()
    onSelect()
    // archiveSession/unarchiveSession are async; let the guard's `await sdk().protocol` resolve.
    await Promise.resolve()
    await Promise.resolve()

    expect(guardUpdateCalls).toEqual([])
    cleanup()
  })

  test("selecting the archive toggle calls client.session.update with the archived-time shape when protocol is 'v1'", async () => {
    guardProtocol = Promise.resolve("v1")
    guardUpdateCalls.length = 0
    capturedDropdownItems.length = 0
    guardSessionArchived = undefined
    const before = Date.now()

    const { cleanup } = await mountMessageTimeline()
    const onSelect = findArchiveToggleOnSelect()
    onSelect()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(guardUpdateCalls).toHaveLength(1)
    const call = guardUpdateCalls[0] as { sessionID: string; directory: string; time: { archived: number } }
    expect(call.sessionID).toBe("s1")
    expect(call.directory).toBe("d1")
    expect(call.time.archived).toBeGreaterThanOrEqual(before)
    cleanup()
  })

  test("selecting the unarchive toggle never calls client.session.update when protocol !== 'v1'", async () => {
    guardProtocol = Promise.resolve("v2")
    guardUpdateCalls.length = 0
    capturedDropdownItems.length = 0
    guardSessionArchived = 100

    const { cleanup } = await mountMessageTimeline()
    const onSelect = findArchiveToggleOnSelect()
    onSelect()
    await Promise.resolve()
    await Promise.resolve()

    expect(guardUpdateCalls).toEqual([])
    cleanup()
  })

  test("selecting the unarchive toggle calls client.session.update with the unarchive-patch shape when protocol is 'v1'", async () => {
    guardProtocol = Promise.resolve("v1")
    guardUpdateCalls.length = 0
    capturedDropdownItems.length = 0
    guardSessionArchived = 100

    const { cleanup } = await mountMessageTimeline()
    const onSelect = findArchiveToggleOnSelect()
    onSelect()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(guardUpdateCalls).toHaveLength(1)
    // message-timeline.tsx's unarchiveSession omits `directory` in its update call (unlike
    // session-archive-commands.tsx's equivalent) — pinned here as the actual shape, not assumed.
    expect(guardUpdateCalls[0]).toEqual({
      sessionID: "s1",
      time: { archived: null },
    })
    cleanup()
  })
})
