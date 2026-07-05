/**
 * @spec-handoff
 * @interface (structural regression guard, not a runtime unit under test)
 * @behavior
 *   Point 5 reconciliation (spec-reconciliation.md): the archive/unarchive toggle in the
 *   session "more options" menu must exist in BOTH branches of
 *   `<Show when={settings.general.newLayoutDesigns()} fallback={<DropdownMenu>...}>
 *      <MenuV2>...</MenuV2>
 *   </Show>`.
 *   Upstream's `MenuV2` branch is new code with no fork equivalent to conflict against, so a
 *   naive merge can silently ship a MenuV2 menu item that always calls `archiveSession(id)`
 *   with a hardcoded "common.archive" label — i.e. the unarchive path goes missing for any
 *   user with `newLayoutDesigns()` enabled, without git ever flagging a conflict.
 * @edge-cases
 *   - The toggle wiring — `isSessionArchived(info()?.time?.archived) ? unarchiveSession(id) :
 *     archiveSession(id)` for the onSelect handler, and `archiveToggleLabelKey(info()?.time?.archived)`
 *     for the label — must appear exactly once per menu implementation (DropdownMenu.Item AND
 *     MenuV2.Item), i.e. twice total in the file.
 * @testability
 *   `message-timeline.tsx` is a large, deeply-context-coupled SolidJS component (sync, sdk,
 *   dialog, share, language, ~15 other contexts). Mounting it end-to-end to click through the
 *   menu in both `newLayoutDesigns()` states is disproportionately expensive relative to the
 *   specific risk being guarded (a STRUCTURAL omission in one of two static JSX branches, not a
 *   dynamic runtime bug). This test instead asserts, against the real source text, that the
 *   toggle wiring is present under both the `DropdownMenu.Item` and `MenuV2.Item` archive
 *   entries. This is intentionally narrower than a full render+click integration test — see the
 *   Shin E2 report for the explicit trade-off note.
 * @see ./message-timeline.tsx
 * @see ../../layout/helpers.ts (isSessionArchived, archiveToggleLabelKey, unarchivePatch)
 */

import { describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()

// The exact toggle expression used for both the DropdownMenu and MenuV2 archive/unarchive item.
const TOGGLE_ACTION = /isSessionArchived\(info\(\)\?\.time\?\.archived\)\s*\?\s*unarchiveSession\(id\)\s*:\s*archiveSession\(id\)/g
const TOGGLE_LABEL = /archiveToggleLabelKey\(info\(\)\?\.time\?\.archived\)/g

function matchIndices(re: RegExp, text: string) {
  return Array.from(text.matchAll(re)).map((m) => m.index ?? -1)
}

// For a match at `index`, find which menu-item tag most recently opened before it.
function owningMenuItem(index: number) {
  const dropdown = src.lastIndexOf("<DropdownMenu.Item", index)
  const menuV2 = src.lastIndexOf("<MenuV2.Item", index)
  if (dropdown === -1 && menuV2 === -1) return "none" as const
  return dropdown > menuV2 ? ("DropdownMenu.Item" as const) : ("MenuV2.Item" as const)
}

describe("message-timeline archive/unarchive toggle — structural parity (Point 5)", () => {
  test("imports the shared toggle helpers from pages/layout/helpers", () => {
    expect(src).toContain('import { archiveToggleLabelKey, isSessionArchived, unarchivePatch } from "@/pages/layout/helpers"')
  })

  test("the toggle action (unarchive-or-archive) appears exactly once per menu implementation", () => {
    const indices = matchIndices(TOGGLE_ACTION, src)
    expect(indices).toHaveLength(2)

    const owners = indices.map(owningMenuItem).toSorted()
    expect(owners).toEqual(["DropdownMenu.Item", "MenuV2.Item"])
  })

  test("the toggle label (archive/unarchive text) appears exactly once per menu implementation", () => {
    const indices = matchIndices(TOGGLE_LABEL, src)
    expect(indices).toHaveLength(2)

    const owners = indices.map(owningMenuItem).toSorted()
    expect(owners).toEqual(["DropdownMenu.Item", "MenuV2.Item"])
  })

  test("neither menu implementation hardcodes a plain \"common.archive\" item (the pre-toggle upstream shape)", () => {
    // The upstream-only regression shape this guards against: a MenuV2.Item whose label is the
    // literal untoggled string and whose onSelect unconditionally calls archiveSession, with no
    // isSessionArchived/archiveToggleLabelKey involvement at all.
    const bareArchiveLabel = /language\.t\("common\.archive"\)/g
    const indices = matchIndices(bareArchiveLabel, src)
    expect(indices).toEqual([])
  })
})
