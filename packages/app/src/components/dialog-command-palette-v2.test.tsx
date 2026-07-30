/**
 * @spec-handoff
 * @interface PaletteRow(props: { item: CommandPaletteEntry; ... }): JSX.Element
 *   File: `./dialog-command-palette-v2.tsx` — the render path used for BOTH the general command
 *   palette (`DialogCommandPaletteV2`) and the home command palette
 *   (`DialogHomeCommandPaletteV2`) when `newLayoutDesigns()` is true (the default; see this
 *   plan's scope-correction note). `dialog-select-file.tsx`'s `DialogSelectFileLegacy` is the
 *   OTHER (legacy) row renderer and already has an equivalent pin in
 *   `./dialog-select-file.test.tsx`.
 * @behavior
 *   - `PaletteRow`'s session-row branch (`<Match when={props.item.type === "session"}>`) must not
 *     dim a row via `classList={{ "opacity-70": !!props.item.archived }}` on either the title or
 *     description `<span>` — this dead branch was removed in commit `d5b4b31edf` alongside the
 *     identical removal in `dialog-select-file.tsx` (see Decision A,
 *     `e1-spec-contract.md`: archived sessions are excluded upstream by
 *     `createServerSessionEntries`, so `item.archived` can never be truthy for any entry this
 *     component actually renders — the dimming branch was unreachable dead code).
 * @edge-cases
 *   - None beyond the source-text absence check below — this mirrors `dialog-select-file.test.tsx`'s
 *     "no longer renders a dimmed row" pin exactly, applied to the other render path.
 * @testability
 *   Mounting `PaletteRow` (or its parents `DialogCommandPaletteV2`/`DialogHomeCommandPaletteV2`)
 *   to inspect actual rendered DOM was not attempted here for the same two reasons documented in
 *   `./dialog-select-file.test.tsx`'s `@testability` note: (1) this repo's `bun test` React-shim
 *   cannot lazily forward `props.children` through nested `createSimpleContext` providers, which
 *   `PaletteRow`'s ancestors (`useLanguage`, `useDialog`, `useGlobal`, `useTabs`, `useCommand`)
 *   all require; (2) independently, the shim does not implement SolidJS's `classList={{...}}`
 *   reactive attribute at all, so even an isolated mount could not observe the dimming class
 *   either way. This file uses the same source-text-pin technique already established by
 *   `dialog-select-file.test.tsx` (and `../pages/layout.test.tsx` before it) instead.
 * @see ./dialog-select-file.test.tsx (equivalent pin for the legacy `DialogSelectFileLegacy` row renderer; @see list there points back here)
 * @see ./dialog-command-palette-v2.tsx (the file this test guards)
 * @see ../../../.yui-soul/plans/wip/187-opencode-restore-archive-ui/e1-spec-contract.md
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dialogCommandPaletteV2Path = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dialog-command-palette-v2.tsx",
)

describe("dialog-command-palette-v2.tsx dead dimmed-row branch (non-regression pin)", () => {
  test("PaletteRow no longer renders a dimmed ('opacity-70') archived-session row keyed off item.archived", async () => {
    const source = await readFile(dialogCommandPaletteV2Path, "utf8")

    expect(source).not.toMatch(/opacity-70["'][^}]*props\.item\.archived/)
    expect(source).not.toMatch(/props\.item\.archived/)
  })
})
