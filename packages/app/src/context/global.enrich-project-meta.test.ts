/**
 * @spec-handoff
 * @interface createServerCtx(conn, scope, projects).projects.list(): Array<LocalProject>
 *   Internal `enrich()` function inside `createServerCtx` in `./global.tsx` (unexported before
 *   this test file's harness needs; exported as a visibility-only change per Task 1's spec),
 *   exercised here directly by calling `createServerCtx(...)` and reading `.projects.list()`
 *   (the memo composed from `enrich()`, `./global.tsx:135`). This is the function the New
 *   Layout's default Home page actually reads (via `home-controller.ts`'s
 *   `focusedServerCtx()?.projects.list()`).
 *   File: `./global.tsx` — unchanged by this test file (red phase, no implementation edits other
 *   than the `createServerCtx` export visibility change already applied by Task 1's spec).
 *   Per plan `218-opencode-live-browser-verification`, step E3's spec
 *   (`e3-fix-whatever-e2-finds.md`, "Root cause A"): `global.tsx`'s `enrich()` never merges
 *   `childStore.projectMeta` at all — plan 209 only patched the parallel, unsynced `enrich()` in
 *   `layout.tsx` (legacy sidebar layout), never this one. This is net-new coverage, not a
 *   regression backfill — `global.tsx`'s `enrich()` never had this behavior to test before.
 * @behavior
 *   - Global/id-less project (`childStore.project === ""`): `list()`'s output for that project
 *     must reflect `childStore.projectMeta.icon.color`, `.name`, and `.commands.start` — RED
 *     today, `global.tsx`'s `enrich()` never reads `childStore.projectMeta` at all.
 *   - Global SENTINEL project (`childStore.project === "global"`, the literal string): `list()`'s
 *     output must ALSO reflect `childStore.projectMeta` — RED today for the same reason as above
 *     (the merge doesn't exist at all in this file, so neither the `""` nor `"global"` case
 *     works), AND (once E3's fix lands) this pins the identity-check requirement — `"global"`
 *     must not be excluded just because it is truthy.
 *   - Real-ID project (`childStore.project` truthy, a real non-"global" ID): `list()`'s output is
 *     unaffected by the fix — `metadata.icon.color` (from `sync.data.project`) remains the sole
 *     color source, the pre-existing `childStore.icon` override merge is unchanged — PASSES
 *     today (regression guard proving this file's test harness is sound, not just asserting on
 *     the new behavior).
 * @edge-cases
 *   - Metadata for the global/id-less and sentinel cases must be looked up by `worktree`, not by
 *     `id` — every directory sharing the `"global"` sentinel id would otherwise incorrectly
 *     resolve to whichever row happens to match `id === "global"` first, rather than its own row.
 *   - Real-ID projects structurally never receive a `projectMeta` merge (gate keyed off identity,
 *     not field-level presence) — asserted via the regression-guard test using a real-ID project
 *     whose `childStore.projectMeta` is left `undefined`.
 * @see ./global.tsx (enrich(), lines ~113-128 — target of E3's fix, unmodified here)
 * @see ./layout.tsx (enrich(), lines ~445-471 — the OTHER unsynced copy plan 209 patched instead of this one)
 * @see ./global-sync/child-store.ts (ProjectMeta write path — `projectMeta()`, unaffected by this fix)
 * @see ./global-sync/types.ts (`ProjectMeta`, `State.projectMeta` — shape read by `enrich()`)
 * @see ./global-sync/enrich-project.ts (E3's extracted shared helper — new module, not yet created)
 * @see ../../../../.yui-soul/plans/wip/218-opencode-live-browser-verification/e3-fix-whatever-e2-finds.md
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import * as realPlatform from "./platform"
import * as realLanguage from "./language"
import * as realServerSync from "./server-sync"
import * as realServerSdk from "./server-sdk"

// `createServerCtx` (exported from `./global.tsx` for this file's benefit — a visibility-only
// change, no behavior change, per Task 1's spec) is called directly here rather than mounting
// `GlobalProvider`'s full JSX tree, mirroring the rationale documented in
// `layout.project-meta.test.ts` (mounting the real provider+consumer tree is infeasible under
// this repo's `bun test` React-shim). `createServerCtx` is a plain function taking
// (conn, scope, projects) — no `createSimpleContext`/capture indirection is needed here, since it
// was never wrapped in one to begin with; only its two real dependencies (`./platform`'s
// `usePlatform()`, transitively required by `createServerSdkContext`, and `./server-sync`'s
// `createServerSyncContext`, which this file replaces with a controllable fake) need mocking.
mock.module("./platform", () => ({
  ...realPlatform,
  usePlatform: () => ({ platform: "web" as const }),
}))

// `./language` is not directly imported by `global.tsx`, but `server-sync.tsx`'s
// `createServerSyncContextInner` (not exercised here, since `createServerSyncContext` itself is
// replaced below) would need it if this mock were removed — kept for parity with
// `layout.project-meta.test.ts`'s mock set and to insulate against a future direct import.
mock.module("./language", () => ({
  ...realLanguage,
  useLanguage: () => ({ t: (key: string) => key, plural: (key: string) => key }),
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
  createServerSyncContext: () => ({
    data: { project: projectData },
    child: (directory: string) =>
      childStores[directory] ?? [{ project: "", icon: undefined, projectMeta: undefined }, () => {}],
  }),
}))

// `createServerCtx` also calls the REAL `createServerSdkContext(conn, scope)` to build the `sdk`
// object it passes into `createServerSyncContext` — even though the mock above ignores that
// argument entirely, the real `createServerSdkContext` still runs its own side effects (protocol
// detection via `detectServerProtocol`, which issues a real `fetch` against `conn.http.url` — the
// "Cross-Origin Request Blocked" console noise observed without this mock). Mocking it out
// entirely removes that non-deterministic background network activity from this file's test run.
mock.module("./server-sdk", () => ({
  ...realServerSdk,
  createServerSdkContext: () => ({}),
}))

let createServerCtx: typeof import("./global").createServerCtx | undefined
let createServerProjects: typeof import("./server").createServerProjects
let createStore: typeof import("solid-js/store").createStore
let ServerScope: typeof import("@/utils/server-scope").ServerScope
let QueryClient: typeof import("@tanstack/solid-query").QueryClient
let QueryClientProvider: typeof import("@tanstack/solid-query").QueryClientProvider

beforeEach(async () => {
  projectData = []
  childStores = {}
  if (createServerCtx) return
  ;({ createServerCtx } = await import("./global"))
  ;({ createServerProjects } = await import("./server"))
  ;({ createStore } = await import("solid-js/store"))
  ;({ ServerScope } = await import("@/utils/server-scope"))
  ;({ QueryClient, QueryClientProvider } = await import("@tanstack/solid-query"))
})

function readList(worktrees: string[]) {
  if (!createServerCtx) throw new Error("createServerCtx not loaded — beforeEach did not run")
  const ctxFactory = createServerCtx
  let result: Array<{
    worktree: string
    expanded: boolean
    id?: string
    name?: string
    icon?: { color?: string; override?: string; url?: string }
    commands?: { start?: string }
  }> = []

  createRoot((dispose) => {
    const client = new QueryClient()
    QueryClientProvider({
      client,
      get children() {
        const [store, setStore] = createStore({
          projects: { local: worktrees.map((worktree) => ({ worktree, expanded: false })) },
          lastProject: {},
          recentlyClosed: {},
        } as { projects: Record<string, { worktree: string; expanded: boolean }[]>; lastProject: Record<string, string>; recentlyClosed: Record<string, string[]> })
        const projects = createServerProjects({
          scope: () => ServerScope.local,
          store,
          setStore,
        })
        const conn = { type: "http", http: { url: "http://localhost:4096" } } as unknown as Parameters<
          typeof ctxFactory
        >[0]
        const ctx = ctxFactory(conn, ServerScope.local, projects)
        result = ctx.projects.list() as typeof result
        return undefined
      },
    })
    dispose()
  })

  return result
}

describe("createServerCtx(...).projects.list() — Root cause A: global.tsx's enrich() never merged childStore.projectMeta at all", () => {
  test("global/id-less project (childStore.project === '') surfaces childStore.projectMeta's icon.color, name, and commands.start (RED until E3's fix lands)", () => {
    projectData = [{ id: "global", worktree: "/repo/global-project", name: "Shared", icon: {} }]
    childStores["/repo/global-project"] = [
      {
        project: "",
        icon: undefined,
        projectMeta: {
          name: "My Cool Project",
          icon: { color: "mint" },
          commands: { start: "npm run dev" },
        },
      },
      () => {},
    ]

    const [project] = readList(["/repo/global-project"])

    expect(project?.icon?.color).toBe("mint")
    expect(project?.name).toBe("My Cool Project")
    expect(project?.commands?.start).toBe("npm run dev")
  })

  test("global SENTINEL project (childStore.project === 'global', the literal string) also surfaces childStore.projectMeta (RED until E3's fix lands — pins Root-Cause-B's identity check in this consumer too)", () => {
    projectData = [{ id: "global", worktree: "/repo/sentinel-project", name: "Shared", icon: {} }]
    childStores["/repo/sentinel-project"] = [
      {
        project: "global",
        icon: undefined,
        projectMeta: {
          name: "My Cool Project",
          icon: { color: "mint" },
          commands: { start: "npm run dev" },
        },
      },
      () => {},
    ]

    const [project] = readList(["/repo/sentinel-project"])

    expect(project?.icon?.color).toBe("mint")
    expect(project?.name).toBe("My Cool Project")
    expect(project?.commands?.start).toBe("npm run dev")
  })

  test("real-ID project's icon.color still comes from metadata, with childStore.icon override merged (regression guard — passes today)", () => {
    projectData = [{ id: "proj-1", worktree: "/repo/real-project", name: "Real Project", icon: { color: "orange" } }]
    childStores["/repo/real-project"] = [
      {
        project: "proj-1",
        icon: "data:image/png;base64,xyz",
        projectMeta: undefined,
      },
      () => {},
    ]

    const [project] = readList(["/repo/real-project"])

    expect(project?.icon?.color).toBe("orange")
    expect(project?.icon?.override).toBe("data:image/png;base64,xyz")
    expect(project?.name).toBe("Real Project")
  })
})
