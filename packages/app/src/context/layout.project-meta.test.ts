/**
 * @spec-handoff
 * @interface enrich(project: { worktree: string; expanded: boolean }): LocalProject
 *   Internal to `LayoutProvider`'s `init` in `./layout.tsx` (unexported), exercised here via
 *   `useLayout().projects.list()` (the memo composed from `enrich()`, `./layout.tsx:516-525`).
 *   File: `./layout.tsx` — unchanged by this test file (red phase, no implementation edits).
 *   Per plan `209-opencode-subagent-animation-project-color`, step E5's spec
 *   (`e5-taku-spec-task2.md`, "Root cause B fix (Option A)"), `enrich()` must merge
 *   `childStore.projectMeta` (name/icon/commands) into the returned project object when
 *   `childStore.project` is falsy (global/id-less), spread AFTER `metadata`/`project` so cached
 *   local writes win, with `icon` merged as its own sub-object (`{ ...metadata?.icon,
 *   ...childStore.projectMeta.icon }`) — not a shallow top-level spread.
 * @behavior
 *   - Global/id-less project (`childStore.project` falsy): `list()`'s output for that project
 *     reflects `childStore.projectMeta.icon.color`, `.name`, and `.commands.start` — RED today,
 *     `enrich()` never reads `childStore.projectMeta` at all.
 *   - Real-ID project (`childStore.project` truthy): `list()`'s output is unaffected by Option A
 *     — `metadata.icon.color` (from `serverSync().data.project`) remains the sole color source,
 *     the pre-existing `childStore.icon` override merge is unchanged — PASSES today (regression
 *     guard proving this file's test harness is sound, not just asserting on the new behavior).
 *   - Defensive tie-break: for a global/id-less project where BOTH the shared `metadata.icon`
 *     (the server's single `"global"` project row, per D6's rationale) and
 *     `childStore.projectMeta.icon` carry a `color`, `childStore.projectMeta.icon` must win
 *     (spread later in the merge literal) — RED today, since the merge doesn't exist yet, so
 *     this precedence can't be observed either way (metadata's stale color leaks through
 *     unchallenged instead).
 * @edge-cases
 *   - `childStore.projectMeta.name`/`.commands` must also flow through generically (spread of
 *     the whole `projectMeta` object, not narrowly `icon.color` only) — this is the same read-
 *     path gap that silently breaks `renameProject`'s global/id-less branch
 *     (`pages/layout.tsx:1279`) today.
 *   - Real-ID projects structurally never receive a `projectMeta` merge, because the gate is
 *     `!projectID` (a whole-branch gate), not a field-level presence check — asserted via the
 *     regression-guard test using a real-ID project whose `childStore.projectMeta` is left
 *     `undefined` (matching current reality: `edit-project.ts`'s real-ID branch never writes it).
 * @see ./layout.tsx (enrich(), lines ~445-460 — target of the fix, unmodified here)
 * @see ./global-sync/child-store.ts (ProjectMeta write path — `projectMeta()`, unaffected by this fix)
 * @see ./global-sync/types.ts (`ProjectMeta`, `State.projectMeta` — shape read by `enrich()`)
 * @see ../../../../.yui-soul/plans/wip/209-opencode-subagent-animation-project-color/e5-taku-spec-task2.md
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import * as realUiContext from "@opencode-ai/ui/context"
import * as realSolidRouter from "@solidjs/router"
import * as realServerSync from "./server-sync"
import * as realServerSdk from "./server-sdk"
import * as realServer from "./server"
import * as realPlatform from "./platform"
import * as realTabs from "./tabs"
import * as realPersist from "@/utils/persist"

// `layout.tsx`'s `LayoutProvider` is built via `createSimpleContext({ init, ... })`. Mounting the
// real provider+consumer JSX tree is infeasible under this repo's `bun test` React-shim (see the
// `createSimpleContext` eager-children-evaluation gotcha documented against
// `session-archive-commands.test.tsx`/`dialog-select-file.test.tsx`). Instead, this file replaces
// `createSimpleContext` with a capture that hands back the raw `init` function, then calls it
// directly inside a `createRoot` — bypassing the JSX/Provider layer entirely while still running
// the REAL `enrich()`/`list()` logic from `./layout.tsx`, unmodified. Verified empirically:
// `createMemo` reads (which `list()`/`enriched()` are) compute synchronously on first read, with
// no reliance on a DOM render or effect-flush cycle.
type CapturedInit = (props: Record<string, unknown>) => {
  projects: {
    list: () => Array<{
      worktree: string
      expanded: boolean
      id?: string
      name?: string
      icon?: { color?: string; override?: string; url?: string }
      commands?: { start?: string }
    }>
  }
}

// Every `mock.module()` call in this file spreads the REAL module's exports first (mirroring
// `edit-project.test.ts`'s `...realSolidQuery` pattern). `mock.module()` replaces the module
// process-wide for the whole `bun test` run, not just this file — a partial override (only the
// keys this file happens to need) leaves sibling test files that statically import the same
// specifier (e.g. `server-sync.test.ts` importing `./server-sync`, `terminal.test.ts` importing
// `@solidjs/router`) crashing with `SyntaxError: Export named 'X' not found`, since a static
// import binds to the exact export shape of whichever mock ran last. Confirmed empirically:
// without the spread, running this file before those others in the same `bun test` process
// breaks them. NOTE: `mock.restore()`/`afterEach`/`afterAll` do NOT undo `mock.module()`
// overrides (confirmed against Bun's own docs, https://bun.sh/docs/test/mocks — "It does not
// reset modules overridden with mock.module()" — and empirically here) — the spread itself,
// which makes every unmocked export identical to the real module, is the only fix; there is no
// call that reverts a `mock.module()` override within a single `bun test` process.
let capturedInit: CapturedInit | undefined
mock.module("@opencode-ai/ui/context", () => ({
  ...realUiContext,
  createSimpleContext: (input: { init: CapturedInit }) => {
    capturedInit = input.init
    return {
      use: () => {
        throw new Error("useLayout() is not exercised directly in this file — see capturedInit")
      },
      provider: () => undefined,
    }
  },
}))

mock.module("@solidjs/router", () => ({
  ...realSolidRouter,
  useLocation: () => ({ pathname: "/", search: "" }),
}))

type ProjectMetaFixture = { name?: string; icon?: { color?: string; override?: string }; commands?: { start?: string } }
type ChildStoreFixture = { project: string; icon?: string; projectMeta?: ProjectMetaFixture }

let childStores: Record<string, [ChildStoreFixture, () => void]> = {}
let projectData: Array<{
  id: string
  worktree: string
  name?: string
  icon?: { color?: string; override?: string }
}> = []

mock.module("./server-sync", () => ({
  ...realServerSync,
  useServerSync: () => () => ({
    ready: true,
    data: { project: projectData },
    child: (directory: string) =>
      childStores[directory] ?? [{ project: "", icon: undefined, projectMeta: undefined }, () => {}],
    project: {
      icon: () => undefined,
      meta: () => undefined,
      loadSessions: async () => undefined,
    },
    set: () => undefined,
  }),
}))

mock.module("./server-sdk", () => ({
  ...realServerSdk,
  useServerSDK: () => () => ({ scope: "local" }),
}))

let projectsList: Array<{ worktree: string; expanded: boolean }> = []
mock.module("./server", () => ({
  ...realServer,
  RECENTLY_CLOSED_DISPLAY_LIMIT: 5,
  // `ServerConnection` is itself an object export (a TS namespace's runtime members), not a
  // function — a shallow top-level `...realServer` spread doesn't reach inside it, so it must be
  // nested-spread too or sibling files that call e.g. `ServerConnection.key`/`.local`/`.builtin`
  // (not just `.Key.make`, which is all this file needs) would still see only this stub shape.
  ServerConnection: { ...realServer.ServerConnection, Key: { make: (v: string) => v } },
  useServer: () => ({
    key: "local",
    projects: {
      list: () => projectsList,
      recentlyClosed: () => [],
      open: () => undefined,
      close: () => undefined,
      expand: () => undefined,
      collapse: () => undefined,
      move: () => undefined,
      remove: () => undefined,
    },
  }),
}))

mock.module("./platform", () => ({
  ...realPlatform,
  usePlatform: () => ({ platform: "web" }),
}))

mock.module("./tabs", () => ({
  ...realTabs,
  useTabs: () => ({ store: [] }),
}))

mock.module("@/utils/persist", () => ({
  ...realPersist,
  // Only `persisted` needs overriding — the mocked version below ignores its `target` argument
  // entirely, so `Persist.*`'s actual return shape (and `removePersisted`'s actual behavior,
  // which this file never exercises or asserts on) are irrelevant here even though `layout.tsx`
  // calls `Persist.serverGlobal()`/`.serverWorkspace()`/`.serverSession()` to build that argument.
  // Leaving `Persist` and `removePersisted` untouched (via the `...realPersist` spread above)
  // avoids the nested-object-mock problem entirely: no stub shape to keep in sync with the real
  // one, and no risk of a sibling file like `persist.test.ts` observing a stub instead.
  persisted: (_target: unknown, store: [unknown, unknown]) => [
    store[0],
    store[1],
    null,
    Object.assign(() => true, { promise: undefined }),
  ],
}))

let layoutModuleLoaded = false

beforeEach(async () => {
  projectData = []
  projectsList = []
  childStores = {}
  if (layoutModuleLoaded) return
  layoutModuleLoaded = true
  // Force a FRESH module instance of `./layout` via a cache-busting query string, instead of a
  // bare `await import("./layout")`. Bun's ESM loader caches modules by exact resolved
  // specifier: if an earlier-run test file in the same `bun test` process (e.g.
  // `dialog-select-file.test.tsx`, which statically imports `./command-palette` ->
  // `@/context/layout`) already triggered a real, uncaptured load of `"./layout"` before this
  // file's `mock.module("@opencode-ai/ui/context", ...)` call above took effect, that CACHED
  // module instance's top-level `createSimpleContext({...})` call already ran against the real
  // implementation and will NEVER re-run. A bare `import("./layout")` here would just return
  // that same stale cached instance, silently leaving `capturedInit` unset (this file's original
  // bug — 45+ reproductions, "capturedInit not set" with zero exceptions). A distinct query
  // string forces the loader to treat this as a new module graph node, re-executing
  // `layout.tsx`'s top-level code fresh, at a point strictly after this file's `mock.module()`
  // registrations (which run at this file's module-eval time, before any `beforeEach`) — so the
  // capture succeeds regardless of what any other test file already did to the real
  // `"./layout"` specifier or what order `bun test` schedules files in. Confirmed empirically:
  // this fixes the previously-flaky failure when run alongside `dialog-select-file.test.tsx` in
  // the same `bun test` invocation (`bun test --conditions=solid --preload ./happydom.ts
  // src/components/dialog-select-file.test.tsx src/context/layout.project-meta.test.ts`).
  await import(`./layout?project-meta-test-fresh=${Date.now()}-${Math.random()}`)
})

function readList() {
  if (!capturedInit) throw new Error("capturedInit not set — createSimpleContext mock did not run")
  return createRoot((dispose) => {
    const layout = capturedInit!({})
    const list = layout.projects.list()
    dispose()
    return list
  })
}

describe("useLayout().projects.list() — Root cause B: childStore.projectMeta read-path (Option A, e5 spec)", () => {
  test("global/id-less project surfaces childStore.projectMeta's icon.color, name, and commands.start (RED until Option A lands)", () => {
    projectData = [{ id: "global", worktree: "/repo/global-project", name: "Shared", icon: {} }]
    projectsList = [{ worktree: "/repo/global-project", expanded: false }]
    childStores["/repo/global-project"] = [
      {
        project: "", // falsy childStore.project => global/id-less branch in enrich()
        icon: undefined,
        projectMeta: {
          name: "My Cool Project",
          icon: { color: "mint" },
          commands: { start: "npm run dev" },
        },
      },
      () => {},
    ]

    const [project] = readList()

    expect(project?.icon?.color).toBe("mint")
    expect(project?.name).toBe("My Cool Project")
    expect(project?.commands?.start).toBe("npm run dev")
  })

  test("real-ID project's icon.color still comes from metadata, with childStore.icon override merged (regression guard — passes today)", () => {
    projectData = [{ id: "proj-1", worktree: "/repo/real-project", name: "Real Project", icon: { color: "orange" } }]
    projectsList = [{ worktree: "/repo/real-project", expanded: false }]
    childStores["/repo/real-project"] = [
      {
        project: "proj-1", // truthy childStore.project => real-ID branch, never merges projectMeta
        icon: "data:image/png;base64,xyz",
        projectMeta: undefined, // edit-project.ts's real-ID save branch never writes this
      },
      () => {},
    ]

    const [project] = readList()

    expect(project?.icon?.color).toBe("orange")
    expect(project?.icon?.override).toBe("data:image/png;base64,xyz")
    expect(project?.name).toBe("Real Project")
  })

  test("defensive tie-break: for a global/id-less project, childStore.projectMeta.icon wins over the shared metadata.icon by spread order (RED until Option A lands)", () => {
    // Per the spec's D6 rationale, every global/id-less directory resolves `metadata` to the
    // server's single shared "global" project row. This case pins what happens if that shared
    // row's own `icon.color` is non-empty (e.g. stale data) at the same time as this directory's
    // `childStore.projectMeta.icon.color` — the merge order specified in e5-taku-spec-task2.md
    // (`{ ...metadata, ...project, ...childStore.projectMeta, icon: { ...metadata?.icon,
    // ...childStore.projectMeta.icon } }`) makes projectMeta win because it is spread later.
    projectData = [{ id: "global", worktree: "/repo/tie-break", name: "Shared", icon: { color: "orange" } }]
    projectsList = [{ worktree: "/repo/tie-break", expanded: false }]
    childStores["/repo/tie-break"] = [
      {
        project: "", // falsy => global/id-less branch, merge is attempted
        icon: undefined,
        projectMeta: { icon: { color: "mint" } },
      },
      () => {},
    ]

    const [project] = readList()

    expect(project?.icon?.color).toBe("mint")
  })
})
