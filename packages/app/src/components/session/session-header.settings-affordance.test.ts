/**
 * @spec-handoff
 * @interface (new JSX inside `SessionHeader()`, `packages/app/src/components/session/session-header.tsx`)
 *   A clickable element (any tag), reachable ONLY when `isV2` (`settings.general.newLayoutDesigns`)
 *   is true — i.e. inside the `<Show when={isV2} fallback={...}>` block's TRUE branch (today just
 *   `<SessionHeaderV2Actions state={v2ActionsState()} />`, or code it calls/receives props from),
 *   NOT inside the `fallback={...}` prop's JSX. `onClick` (or equivalent activation handler) must
 *   call `command.trigger("settings.open")` — the already-registered command from
 *   `useSettingsCommand()` (`./settings-dialog.tsx`), mounted globally per-session via
 *   `TargetSessionSettingsCommand` in `session.tsx:176`. The element's accessible label/tooltip
 *   must reference the existing `sidebar.settings` i18n key (or `command.settings.open`) via
 *   `language.t(...)` — no new i18n key.
 * @behavior
 *   - Clicking/activating fires `command.trigger("settings.open")` and nothing else — no new
 *     dialog-opening or directory-resolution logic is introduced (this test does not attempt to
 *     mount and click; see @testability).
 *   - The label/tooltip text and the trigger call are co-located within the same reasonably local
 *     enclosing block (function body, arrow-function value, or JSX-attribute expression) — proven
 *     by walking matched `{}` outward from the trigger call, capped at 4 levels, so a label
 *     scattered arbitrarily far away in the file would NOT satisfy this contract.
 * @edge-cases
 *   - Must NOT be satisfied by the existing, unrelated `command.trigger("file.open")` search
 *     button (different trigger string, and this file has zero other `"settings.open"` triggers
 *     today, so this is a non-issue in practice — asserted anyway as a documentation guard).
 *   - Must NOT be satisfied by content ONLY inside the `fallback={...}` prop's JSX (the
 *     `isV2 === false` / Legacy-design branch) — see @testability's "branch mix-up" note below.
 *     This is the sharpest edge case this plan surfaced: it is easy to misread this file's
 *     `<Show when={isV2} fallback={<div>...(terminal/review/fileTree buttons)...</div>}>` as if
 *     the `fallback` block (textually written FIRST, as a prop) were the `isV2 === true` branch,
 *     when it is actually the opposite (`isV2 === false`). `isV2` defaults to `true`
 *     (`newLayoutDesignsDefault = true`, `settings.tsx:61`), so the fallback block is NOT what
 *     most users — including default New Layout users — ever see. Placing the new button only in
 *     `fallback` would ship a fix that never reaches the reported bug. This test's extraction
 *     deliberately excises the `fallback={...}` block first (via brace-matching from its own
 *     anchor) before searching, so a fix landed only there stays RED here.
 * @testability
 *   DOM-mounting `SessionHeader` with its real context providers (`useCommand`, `useLanguage`,
 *   `useSettings`, `useLayout`, `useServer`, `usePlatform`, `useSync`, `useTerminal`,
 *   `useSessionLayout`) is confirmed infeasible in this repo's `bun test` environment: the
 *   React-style shim (`../../solid-web-browser-shim.ts`) evaluates JSX children eagerly, whereas
 *   every `createSimpleContext` provider in this app relies on SolidJS's real LAZY `get
 *   children()` semantics — a consumer mounted as a child of its own Provider throws "context
 *   must be used within a context provider" under the shim, independent of anything this plan
 *   changes. Precedent: `../session-archive-commands.test.tsx`'s `@testability` note (same root
 *   cause, empirically confirmed there) and `../dialog-select-file.test.tsx` (same technique,
 *   applied to a sibling regression). This file therefore uses source-text parsing with a
 *   brace-balanced, block-scoped extraction (walking matched `{}` outward from the anchor call,
 *   not a bare whole-file substring search) instead of a render-and-click test. Separately, this
 *   repo's shim does not implement `classList={{...}}` on native DOM elements (stringified as
 *   `"[object Object]"`), which is a second, independent reason a DOM-mount approach would not be
 *   able to observe this button's active/pressed state reliably even if the provider-tree issue
 *   above were solved — not relied on here.
 * @see ./session-header.tsx (the file E2 edits)
 * @see ./settings-dialog.tsx (`useSettingsCommand` — already-correct, unchanged by this plan)
 * @see ../session-archive-commands.test.tsx (source-text-parsing + @testability precedent)
 * @see ../dialog-select-file.test.tsx (source-text-parsing + brace/structural-check precedent)
 * @see ../../../../.yui-soul/plans/wip/263-opencode-settings-nav-affordance/e1-regression-test.md
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sessionHeaderPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-header.tsx")

const SETTINGS_TRIGGER = /command\.trigger\(\s*["']settings\.open["']\s*\)/
const SETTINGS_LABEL = /language\.t\(\s*["'](?:sidebar\.settings|command\.settings\.open)["']/
const FILE_OPEN_TRIGGER = /command\.trigger\(\s*["']file\.open["']\s*\)/

/**
 * Given `index` inside `source`, walks BACKWARD counting nested `}`/`{` to find the nearest
 * enclosing, currently-unmatched `{`, then walks FORWARD from there to its matching `}`.
 * Returns the `[start, end]` (inclusive) span of that one brace pair, or `null` if unbalanced.
 */
function findEnclosingBrace(source: string, index: number): { start: number; end: number } | null {
  let depth = 0
  let start = -1
  for (let i = index - 1; i >= 0; i--) {
    const ch = source[i]
    if (ch === "}") depth++
    else if (ch === "{") {
      if (depth === 0) {
        start = i
        break
      }
      depth--
    }
  }
  if (start === -1) return null

  depth = 1
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return { start, end: i }
    }
  }
  return null
}

/**
 * Brace-balanced, block-scoped extraction (per this plan's E1 requirement): starting at
 * `anchorIndex`, repeatedly widens to the next enclosing `{...}` block (via `findEnclosingBrace`)
 * until one is found whose text satisfies `mustInclude`, or `maxLevels` is exhausted. This is
 * deliberately NOT a whole-file substring search — a label placed arbitrarily far from the
 * trigger call will not satisfy this within a small `maxLevels`.
 */
function widenToBlockContaining(source: string, anchorIndex: number, mustInclude: RegExp, maxLevels = 4): string | null {
  let cursor = anchorIndex
  for (let level = 0; level < maxLevels; level++) {
    const brace = findEnclosingBrace(source, cursor)
    if (!brace) return null
    const block = source.slice(brace.start, brace.end + 1)
    if (mustInclude.test(block)) return block
    cursor = brace.start
  }
  return null
}

/**
 * Extracts the `fallback={...}` prop's JSX (the Legacy / `isV2 === false` design, see
 * `@edge-cases` above) via brace-matching from its own `{` anchor, and returns the source with
 * that whole block excised. Anything found in the returned string is therefore, by construction,
 * NOT inside the Legacy fallback branch.
 */
function excludeLegacyFallbackBlock(source: string): string {
  const anchor = source.indexOf("fallback={")
  expect(anchor).toBeGreaterThan(-1) // sanity: the known `fallback={` prop must still exist

  const braceStart = anchor + "fallback=".length
  expect(source[braceStart]).toBe("{")

  let depth = 1
  let end = -1
  for (let i = braceStart + 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  expect(end).toBeGreaterThan(-1) // sanity: the fallback prop's braces must balance

  return source.slice(0, braceStart) + source.slice(end + 1)
}

describe("SessionHeader isV2 (New Layout) branch — Settings trigger (red until E2)", () => {
  test("sanity: the extraction correctly isolates the Legacy fallback block, not real isV2 content", async () => {
    const source = await readFile(sessionHeaderPath, "utf8")
    const anchor = source.indexOf("fallback={")
    const braceStart = anchor + "fallback=".length

    let depth = 1
    let end = -1
    for (let i = braceStart + 1; i < source.length; i++) {
      const ch = source[i]
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const fallbackBlock = source.slice(braceStart, end + 1)

    // Known-true content of the Legacy (isV2 === false) branch today — proves this extraction
    // grabbed the right span, not an arbitrary/empty one.
    expect(fallbackBlock).toContain("command.review.toggle")
    expect(fallbackBlock).toContain("layout.fileTree.toggle")
    // The one thing under test must NOT be findable inside the isolated Legacy-only span.
    expect(fallbackBlock).not.toMatch(SETTINGS_TRIGGER)
  })

  test("a Settings trigger (command.trigger(\"settings.open\")) exists outside the Legacy fallback block", async () => {
    const source = await readFile(sessionHeaderPath, "utf8")
    const nonFallbackSource = excludeLegacyFallbackBlock(source)

    const match = SETTINGS_TRIGGER.exec(nonFallbackSource)
    // RED today: no such call exists anywhere in this file yet (confirmed zero occurrences
    // before E2). GREEN once E2 adds it anywhere in the isV2-true-reachable code.
    expect(match).not.toBeNull()
  })

  test("the Settings trigger and the sidebar.settings/command.settings.open label are co-located in the same local block", async () => {
    const source = await readFile(sessionHeaderPath, "utf8")
    const nonFallbackSource = excludeLegacyFallbackBlock(source)

    const match = SETTINGS_TRIGGER.exec(nonFallbackSource)
    expect(match).not.toBeNull() // re-asserted so this test is independently legible when it fails

    const anchorIndex = match!.index
    const block = widenToBlockContaining(nonFallbackSource, anchorIndex, SETTINGS_LABEL)

    expect(block).not.toBeNull()
    // Guards against a degenerate widen that happened to swallow the unrelated search button.
    expect(block).not.toMatch(FILE_OPEN_TRIGGER)
  })

  test("does not vacuously pass against the existing, unrelated file.open search button", async () => {
    const source = await readFile(sessionHeaderPath, "utf8")

    // This file already calls command.trigger("file.open") on its search button (a real,
    // already-correct precedent for E2 to follow the *pattern* of — not the target of this test).
    expect(source).toMatch(FILE_OPEN_TRIGGER)

    const fileOpenMatch = FILE_OPEN_TRIGGER.exec(source)!
    // Confirm the settings-trigger regex does not also match at/around the file.open call site.
    const nearby = source.slice(Math.max(0, fileOpenMatch.index - 200), fileOpenMatch.index + 200)
    expect(nearby).not.toMatch(SETTINGS_TRIGGER)
  })
})
