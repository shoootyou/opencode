/**
 * @spec-handoff
 * @interface SessionTabAvatarView(props: { project?: LocalProject; directory: string; revealProjectOnHover?: boolean; unread: boolean; loading: boolean }): JSX.Element
 *   File: `./session-tab-avatar.tsx`. No new props on `SessionTabAvatarView` itself — the fix is
 *   entirely inside the component body: the existing `<SessionProgressIndicatorV2>` call site
 *   (inside the `<Show when={props.loading}>` branch) must pass a new `color` prop.
 * @behavior
 *   - When `props.loading` is true, `SessionTabAvatarView` renders `<SessionProgressIndicatorV2>`
 *     with `color={`var(--v2-avatar-bg-${getProjectAvatarVariant(props.project?.icon?.color)})`}`
 *     — reusing the already-imported `getProjectAvatarVariant` helper (from `@/context/layout`),
 *     the same helper already used one line below for `ProjectAvatar`'s `variant` prop. No new
 *     color-mapping mechanism is introduced.
 *   - For a project with `icon.color` set to a known key (e.g. `"cyan"`), the indicator's
 *     rendered `<svg>` must carry `--session-progress-indicator-color: var(--v2-avatar-bg-cyan)`
 *     as an inline style.
 *   - For a project with NO configured `icon.color` (`undefined`) or no `project` at all,
 *     `getProjectAvatarVariant(undefined)` resolves to `"gray"`, so the indicator must receive
 *     `color="var(--v2-avatar-bg-gray)"` — not a visual regression from today's
 *     `var(--v2-icon-icon-muted, #808080)` default (both are neutral grey; see E2 spec Notes).
 * @edge-cases
 *   - `props.project` entirely omitted (no project object) → same "gray" fallback as
 *     `project.icon.color === undefined`.
 *   - An unrecognized/legacy `icon.color` key (e.g. `"mint"`, `"lime"`) is remapped by
 *     `getProjectAvatarVariant` before reaching the indicator (`"mint"` -> `"cyan"`, `"lime"` ->
 *     `"green"`) — the indicator receives the REMAPPED variant, not the raw key.
 * @see ./session-tab-avatar.tsx (component under test)
 * @see ../../../../packages/session-ui/src/v2/components/session-progress-indicator-v2.test.tsx (Sub-fix A's other half — the indicator's own color-prop contract)
 * @see ../../../../.yui-soul/plans/wip/209-opencode-subagent-animation-project-color/e2-taku-spec-task1.md (spec source, Sub-fix A contract, call-site snippet)
 */

import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { SessionTabAvatarView } from "./session-tab-avatar"
import type { LocalProject } from "@/context/layout"

function mountIntoContainer(props: {
  project?: LocalProject
  loading: boolean
  unread?: boolean
}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <SessionTabAvatarView
        project={props.project}
        directory={props.project?.worktree ?? "/tmp/no-project"}
        unread={props.unread ?? false}
        loading={props.loading}
      />
    ),
    container,
  )
  return {
    svg: container.querySelector("svg"),
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

describe("SessionTabAvatarView threads project color into SessionProgressIndicatorV2 (Sub-fix A)", () => {
  test("project with icon.color 'cyan' -> indicator receives var(--v2-avatar-bg-cyan)", () => {
    const { svg, dispose } = mountIntoContainer({
      project: { worktree: "/tmp/proj", icon: { color: "cyan" } } as LocalProject,
      loading: true,
    })
    expect(svg).not.toBeNull()
    expect(svg!.style.getPropertyValue("--session-progress-indicator-color")).toBe("var(--v2-avatar-bg-cyan)")
    dispose()
  })

  test("project with no icon.color (undefined) -> indicator receives var(--v2-avatar-bg-gray) fallback, no regression", () => {
    const { svg, dispose } = mountIntoContainer({
      project: { worktree: "/tmp/proj" } as LocalProject,
      loading: true,
    })
    expect(svg).not.toBeNull()
    expect(svg!.style.getPropertyValue("--session-progress-indicator-color")).toBe("var(--v2-avatar-bg-gray)")
    dispose()
  })

  test("no project at all -> indicator still receives var(--v2-avatar-bg-gray) fallback", () => {
    const { svg, dispose } = mountIntoContainer({
      loading: true,
    })
    expect(svg).not.toBeNull()
    expect(svg!.style.getPropertyValue("--session-progress-indicator-color")).toBe("var(--v2-avatar-bg-gray)")
    dispose()
  })

  test("legacy icon.color key 'mint' is remapped to 'cyan' variant before reaching the indicator", () => {
    const { svg, dispose } = mountIntoContainer({
      project: { worktree: "/tmp/proj", icon: { color: "mint" } } as LocalProject,
      loading: true,
    })
    expect(svg!.style.getPropertyValue("--session-progress-indicator-color")).toBe("var(--v2-avatar-bg-cyan)")
    dispose()
  })
})
