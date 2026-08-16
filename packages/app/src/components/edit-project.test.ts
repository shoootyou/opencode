/**
 * @spec-handoff
 * @interface createEditProjectModel(props: { project: LocalProject; server: ServerConnection.Any }): { save: UseMutationResult; ... }
 *   File: `./edit-project.ts` (unchanged by this test file — red phase, no implementation edits).
 *   `save.mutate()` (real-ID branch, `props.project.id` truthy and not `"global"`) must call
 *   `serverCtx().sdk.client.project.update(...)`, and on success call `sync.set("project", ...)`,
 *   `sync.project.icon(...)`, then `dialog.close()`. Per plan `209-opencode-subagent-animation-
 *   project-color`, step E5's spec (`e5-taku-spec-task2.md`, "Root cause A fix"), this must NOT
 *   depend on `serverCtx().sdk.protocol` — the real-ID save must succeed identically whether the
 *   server resolves to protocol `"v1"` or `"v2"`.
 * @behavior
 *   - Real-ID save succeeds (calls `sdk.client.project.update` and reaches `dialog.close()`)
 *     regardless of whether `serverCtx().sdk.protocol` resolves to `"v1"` or `"v2"` — today, the
 *     stale `if ((await serverCtx().sdk.protocol) !== "v1") return` guard (edit-project.ts:73-74)
 *     silently no-ops the whole mutation for `"v2"`, so this is RED today for the `"v2"` case.
 *   - On a falsy/failed `project.update` response (`!project`), the mutation surfaces an error
 *     toast via the existing `showToast`/`common.requestFailed` pattern
 *     (`session-header.tsx:132-138`'s `showRequestError`) and does NOT close the dialog — RED
 *     today (no error-toast call exists anywhere in this file).
 *   - On success, the dialog still closes (regression guard) — this one is expected to PASS
 *     today; it exists to prove the other two fixes don't regress the happy path.
 *   - Global/id-less save (`props.project.id` falsy or `=== "global"`) calls
 *     `sync.project.meta(worktree, patch)` with `name`/`icon.color`/`icon.override`/
 *     `commands.start` from form state, then `dialog.close()` — coverage backfill for
 *     pre-existing, unmodified behavior (`edit-project.ts:106-111`), not red-phase TDD; expected
 *     to PASS immediately.
 * @edge-cases
 *   - Protocol resolves to `"v2"`: real-ID save must behave identically to `"v1"` (no guard-based
 *     branching remains).
 *   - `!project` (failed response): dialog must stay open, no `sync.set`/`sync.project.icon`
 *     calls, one error toast shown with `common.requestFailed` title.
 *   - Global/id-less save with empty color/iconOverride/startup fields: patch's `icon.color`,
 *     `icon.override`, and `commands.start` are `undefined` (not empty string), matching the
 *     `|| undefined` fallbacks in `edit-project.ts:106-111`.
 * @see ./edit-project.ts (real-ID save branch, lines ~73-97 — target of the fix, unmodified here)
 * @see ./session-header.tsx:132-138 (showRequestError pattern reused for the error-toast spec)
 * @see ../../../../.yui-soul/plans/wip/209-opencode-subagent-animation-project-color/e5-taku-spec-task2.md
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import * as realSolidQuery from "@tanstack/solid-query"
import type { Project } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import type { ServerConnection } from "@/context/server"

const dialogCloseCalls: number[] = []
const syncSetCalls: Array<{ key: string }> = []
const syncIconCalls: Array<{ directory: string; value: string | undefined }> = []
const syncMetaCalls: Array<{
  directory: string
  patch: { name?: string; icon?: { color?: string; override?: string }; commands?: { start?: string } }
}> = []
const showToastCalls: Array<{ variant?: string; title?: string }> = []

let updateProtocol: Promise<"v1" | "v2"> = Promise.resolve("v1")
let updateResponse: Project | undefined
const updateCalls: unknown[] = []

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    worktree: "/repo/project-1",
    time: { created: 0, updated: 0 },
    sandboxes: [],
    ...overrides,
  } as Project
}

// `edit-project.ts` calls `useMutation(() => ({ mutationFn: ... }))` with no explicit
// `queryClient` argument, so the real `@tanstack/solid-query` hook would require a real
// `QueryClientProvider` context ancestor (`useQueryClient` throws "No QueryClient set" otherwise
// — confirmed against `node_modules/@tanstack/solid-query/build/index.js`). Since the mutation's
// own reactive state (`isPending`, retries, caching) is irrelevant to this file's assertions —
// only whether `mutationFn` ran and what it did — a minimal mock that invokes `mutationFn`
// directly sidesteps standing up a real `QueryClient`/provider tree entirely.
mock.module("@tanstack/solid-query", () => ({
  // Spread the real module's exports first — same rationale as
  // `message-timeline.archive-guard.test.tsx`'s mock of this same module: sibling test files in
  // this same `bun test` process transitively depend on other named exports (`QueryClient`,
  // `useQuery`, etc.) that this file doesn't itself need to override. Only `useMutation` is
  // replaced, and only within this file's own test run.
  ...realSolidQuery,
  useMutation: (optionsFn: () => { mutationFn: () => Promise<unknown> }) => {
    const options = optionsFn()
    return {
      isPending: false,
      mutate: () => {
        void options.mutationFn()
      },
      mutateAsync: () => options.mutationFn(),
    }
  },
}))

mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    close: () => {
      dialogCloseCalls.push(1)
    },
  }),
}))

mock.module("@/context/global", () => ({
  useGlobal: () => ({
    ensureServerCtx: () => ({
      sdk: {
        get protocol() {
          return updateProtocol
        },
        client: {
          project: {
            update: async (input: unknown) => {
              updateCalls.push(input)
              return { data: updateResponse }
            },
          },
        },
      },
      sync: {
        set: (key: string, _updater: unknown) => {
          syncSetCalls.push({ key })
        },
        project: {
          icon: (directory: string, value: string | undefined) => {
            syncIconCalls.push({ directory, value })
          },
          meta: (
            directory: string,
            patch: { name?: string; icon?: { color?: string; override?: string }; commands?: { start?: string } },
          ) => {
            syncMetaCalls.push({ directory, patch })
          },
        },
      },
    }),
  }),
}))

mock.module("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => (key === "common.requestFailed" ? "Request failed" : key) }),
}))

mock.module("@/utils/toast", () => ({
  showToast: (options: { variant?: string; title?: string }) => {
    showToastCalls.push(options)
    return 0
  },
}))

let createEditProjectModel: typeof import("./edit-project").createEditProjectModel

beforeEach(async () => {
  dialogCloseCalls.length = 0
  syncSetCalls.length = 0
  syncIconCalls.length = 0
  syncMetaCalls.length = 0
  showToastCalls.length = 0
  updateCalls.length = 0
  updateProtocol = Promise.resolve("v1")
  updateResponse = baseProject()

  if (!createEditProjectModel) {
    createEditProjectModel = (await import("./edit-project")).createEditProjectModel
  }
})

function makeProps(project: Partial<LocalProject> = {}): { project: LocalProject; server: ServerConnection.Any } {
  return {
    project: { id: "project-1", worktree: "/repo/project-1", expanded: false, ...project } as LocalProject,
    server: { type: "http", http: { url: "http://localhost:4096" } } as ServerConnection.Any,
  }
}

describe("createEditProjectModel real-ID save — protocol independence (Root cause A)", () => {
  test.each(["v1", "v2"] as const)(
    "save succeeds and reaches dialog.close() regardless of detected protocol (%s)",
    async (protocol) => {
      updateProtocol = Promise.resolve(protocol)
      updateResponse = baseProject()

      await createRoot(async (dispose) => {
        const model = createEditProjectModel(makeProps())
        await model.save.mutateAsync()
        dispose()
      })

      expect(updateCalls).toHaveLength(1)
      expect(dialogCloseCalls).toHaveLength(1)
    },
  )
})

describe("createEditProjectModel real-ID save — error surfacing on failure (Root cause A)", () => {
  test("shows an error toast and leaves the dialog open when project.update returns a falsy response", async () => {
    updateProtocol = Promise.resolve("v1")
    updateResponse = undefined

    await createRoot(async (dispose) => {
      const model = createEditProjectModel(makeProps())
      await model.save.mutateAsync()
      dispose()
    })

    expect(showToastCalls).toHaveLength(1)
    expect(showToastCalls[0]?.variant).toBe("error")
    expect(showToastCalls[0]?.title).toBe("Request failed")
    expect(dialogCloseCalls).toHaveLength(0)
    expect(syncSetCalls).toHaveLength(0)
    expect(syncIconCalls).toHaveLength(0)
  })
})

describe("createEditProjectModel real-ID save — success path closes the dialog (regression guard)", () => {
  test("closes the dialog and syncs project/icon state on a successful save", async () => {
    updateProtocol = Promise.resolve("v1")
    updateResponse = baseProject()

    await createRoot(async (dispose) => {
      const model = createEditProjectModel(makeProps({ icon: { override: "data:image/png;base64,x" } }))
      await model.save.mutateAsync()
      dispose()
    })

    expect(dialogCloseCalls).toHaveLength(1)
    expect(syncSetCalls).toEqual([{ key: "project" }])
    expect(syncIconCalls).toHaveLength(1)
  })
})

describe("createEditProjectModel global/id-less save — sync.project.meta path (coverage backfill, pre-existing behavior)", () => {
  test.each([undefined, "global"] as const)(
    "calls sync.project.meta(worktree, patch) with name/icon/commands from form state and closes the dialog (project.id = %s)",
    async (projectID) => {
      await createRoot(async (dispose) => {
        const model = createEditProjectModel(makeProps({ id: projectID }))
        model.setStore("name", "My Cool Project")
        model.setStore("color", "mint")
        model.setStore("iconOverride", "data:image/png;base64,xyz")
        model.setStore("startup", "npm run dev")
        await model.save.mutateAsync()
        dispose()
      })

      expect(updateCalls).toHaveLength(0)
      expect(syncMetaCalls).toHaveLength(1)
      expect(syncMetaCalls[0]?.directory).toBe("/repo/project-1")
      expect(syncMetaCalls[0]?.patch).toEqual({
        name: "My Cool Project",
        icon: { color: "mint", override: "data:image/png;base64,xyz" },
        commands: { start: "npm run dev" },
      })
      expect(dialogCloseCalls).toHaveLength(1)
      expect(syncSetCalls).toHaveLength(0)
      expect(syncIconCalls).toHaveLength(0)
    },
  )

  test("omits color/override/start from the patch when the form fields are empty", async () => {
    await createRoot(async (dispose) => {
      const model = createEditProjectModel(makeProps({ id: "global" }))
      model.setStore("color", undefined)
      model.setStore("iconOverride", undefined)
      model.setStore("startup", "")
      await model.save.mutateAsync()
      dispose()
    })

    expect(syncMetaCalls).toHaveLength(1)
    expect(syncMetaCalls[0]?.patch.icon).toEqual({ color: undefined, override: undefined })
    expect(syncMetaCalls[0]?.patch.commands).toEqual({ start: undefined })
    expect(dialogCloseCalls).toHaveLength(1)
  })
})
