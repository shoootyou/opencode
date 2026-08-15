/**
 * @spec-handoff
 * @interface enrichProject<P extends { worktree: string }>(project: P, childStore: EnrichProjectChildStore, projectData: readonly Project[]): P & Partial<Project>
 *   File: `./enrich-project.ts` (new module — does not exist yet, red phase).
 *   Per plan `218-opencode-live-browser-verification`, step E3's spec
 *   (`e3-fix-whatever-e2-finds.md`, "Bug 2 spec: shared `enrichProject()` extraction + explicit
 *   global-identity guard"). Pure function, no context/store dependencies — takes only the three
 *   primitives both `global.tsx`'s and `layout.tsx`'s `enrich()` need: the bare `project`, the
 *   `childStore` slice (`project`/`icon`/`projectMeta`), and the full `projectData` list.
 *   `isGlobalProject = !projectID || projectID === "global"` — an explicit identity check, not
 *   bare truthiness. Root cause B (the bug this contract exists to close) was specifically that
 *   `childStore.project` resolves to the literal string `"global"` after client bootstrap
 *   (~1-1.25s after page load), which is truthy and therefore defeats a `!projectID` guard
 *   forever after.
 * @behavior
 *   - Real-ID project (`childStore.project` is a real, non-"global" ID): metadata found by
 *     `id` (not `worktree`); `childStore.projectMeta` merge NEVER applies, even if
 *     `childStore.projectMeta` is (incorrectly) present — regression guard for the currently-
 *     working real-ID path, which must not regress.
 *   - Id-less project (`childStore.project === ""`): metadata found by `worktree` (no real ID
 *     yet); `childStore.projectMeta` (name/icon/commands) merges.
 *   - Global sentinel project (`childStore.project === "global"`): metadata found by `worktree`
 *     — NOT by `id` (the server's shared global row would otherwise falsely match `id ===
 *     "global"` for every directory) — `childStore.projectMeta` STILL merges. This is the direct
 *     Root-Cause-B pin: `"global"` is truthy, so a bare `!projectID` guard would treat this as
 *     the real-ID branch and skip the merge; `enrichProject()` must not.
 *   - Defensive tie-break: for a global/id-less project (both the `""` and `"global"` cases),
 *     when both `metadata.icon.color` and `childStore.projectMeta.icon.color` are present,
 *     `childStore.projectMeta.icon.color` wins (spread order: `projectMeta` spread after
 *     `metadata`/`project`).
 *   - `childStore.icon` override (per-workspace local override, unrelated to `projectMeta`)
 *     merges onto `base.icon.override` whenever present, independent of `isGlobalProject` —
 *     regression guard preserving plan 209's original icon-override behavior in the extracted
 *     helper.
 * @edge-cases
 *   - `childStore.project === undefined` (not just `""`) must be treated identically to `""` —
 *     both satisfy `!projectID`.
 *   - A real-ID project with `childStore.projectMeta` unexpectedly set (should never happen in
 *     practice, since `edit-project.ts`'s real-ID save branch never writes it) must still NOT
 *     merge it — the gate is on `isGlobalProject`, not on `projectMeta`'s mere presence.
 * @see ./global.tsx (Root cause A consumer — enrich(), never merged projectMeta at all before this fix)
 * @see ./layout.tsx (Root cause B consumer — enrich(), lines ~445-471, had the merge but guarded on bare `!projectID` truthiness)
 * @see ./types.ts (`ProjectMeta`, `State.projectMeta` — shape read by `enrichProject()`)
 * @see ../../../../../.yui-soul/plans/wip/218-opencode-live-browser-verification/e3-fix-whatever-e2-finds.md
 */

import { describe, expect, test } from "bun:test"
import type { Project } from "@opencode-ai/sdk/v2/client"
import { enrichProject } from "./enrich-project"

function projectRow(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    worktree: "/repo/project-1",
    time: { created: 0, updated: 0 },
    sandboxes: [],
    ...overrides,
  } as Project
}

describe("enrichProject() — real-ID project (regression guard)", () => {
  test("finds metadata by id, merges childStore.icon override, never merges projectMeta even if present", () => {
    const projectData = [
      projectRow({ id: "proj-1", worktree: "/repo/real-project", name: "Real Project", icon: { color: "orange" } }),
      projectRow({ id: "global", worktree: "/repo/real-project", name: "Should Not Match", icon: { color: "cyan" } }),
    ]

    const result = enrichProject(
      { worktree: "/repo/real-project", expanded: false },
      {
        project: "proj-1",
        icon: "data:image/png;base64,xyz",
        // Should never happen in practice, but pins that the gate is isGlobalProject, not
        // projectMeta's mere presence.
        projectMeta: { name: "Leaked Name", icon: { color: "mint" } },
      },
      projectData,
    )

    expect(result.id).toBe("proj-1")
    expect(result.name).toBe("Real Project")
    expect(result.icon?.color).toBe("orange")
    expect(result.icon?.override).toBe("data:image/png;base64,xyz")
  })
})

describe("enrichProject() — id-less project (childStore.project === '')", () => {
  test("finds metadata by worktree, merges childStore.projectMeta (name/icon/commands)", () => {
    const projectData = [projectRow({ id: "global", worktree: "/repo/id-less", name: "Shared", icon: {} })]

    const result = enrichProject(
      { worktree: "/repo/id-less", expanded: false },
      {
        project: "",
        icon: undefined,
        projectMeta: { name: "My Cool Project", icon: { color: "mint" }, commands: { start: "npm run dev" } },
      },
      projectData,
    )

    expect(result.name).toBe("My Cool Project")
    expect(result.icon?.color).toBe("mint")
    expect(result.commands?.start).toBe("npm run dev")
  })

  test("childStore.project === undefined behaves identically to ''", () => {
    const projectData = [projectRow({ id: "global", worktree: "/repo/id-less", name: "Shared", icon: {} })]

    const result = enrichProject(
      { worktree: "/repo/id-less", expanded: false },
      {
        // `EnrichProjectChildStore.project` is typed `string`, but callers historically may pass
        // an unresolved/undefined-ish value before bootstrap settles — pin the same treatment as
        // `""` defensively.
        project: undefined as unknown as string,
        icon: undefined,
        projectMeta: { name: "Still Global" },
      },
      projectData,
    )

    expect(result.name).toBe("Still Global")
  })
})

describe("enrichProject() — global sentinel project (childStore.project === 'global') — Root-Cause-B pin", () => {
  test("finds metadata by worktree (not by id), still merges childStore.projectMeta", () => {
    const projectData = [
      // Server's single shared global project row — literal id "global", per
      // ProjectV2.ID.make("global"). If enrichProject() looked this up by `id === projectID`
      // instead of `worktree`, EVERY directory sharing this sentinel would incorrectly resolve
      // to this exact row regardless of its own worktree.
      projectRow({ id: "global", worktree: "/repo/other-dir", name: "Wrong Match", icon: { color: "cyan" } }),
      projectRow({ id: "global", worktree: "/repo/sentinel-dir", name: "Shared", icon: {} }),
    ]

    const result = enrichProject(
      { worktree: "/repo/sentinel-dir", expanded: false },
      {
        project: "global",
        icon: undefined,
        projectMeta: { name: "My Cool Project", icon: { color: "mint" }, commands: { start: "npm run dev" } },
      },
      projectData,
    )

    // Metadata resolved by worktree, not by the (truthy, but sentinel) id.
    expect(result.worktree).toBe("/repo/sentinel-dir")
    // Root-Cause-B pin: projectMeta still merges even though childStore.project ("global") is
    // truthy. A bare `!projectID` guard would fail this assertion (projectMeta never applied).
    expect(result.name).toBe("My Cool Project")
    expect(result.icon?.color).toBe("mint")
    expect(result.commands?.start).toBe("npm run dev")
  })
})

describe("enrichProject() — defensive tie-break (global/id-less projects)", () => {
  test.each(["", "global"] as const)(
    "childStore.projectMeta.icon.color wins over metadata.icon.color by spread order (childStore.project = %j)",
    (projectID) => {
      const projectData = [
        projectRow({ id: "global", worktree: "/repo/tie-break", name: "Shared", icon: { color: "orange" } }),
      ]

      const result = enrichProject(
        { worktree: "/repo/tie-break", expanded: false },
        {
          project: projectID,
          icon: undefined,
          projectMeta: { icon: { color: "mint" } },
        },
        projectData,
      )

      expect(result.icon?.color).toBe("mint")
    },
  )
})
