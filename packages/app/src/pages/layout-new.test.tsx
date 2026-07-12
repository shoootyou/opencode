/**
 * @spec-handoff
 * @interface NewLayout(props: ParentProps): JSX.Element
 *   File: packages/app/src/pages/layout-new.tsx (default export, lines 10-44). Root shell
 *   div declared at lines 28-33.
 * @behavior
 *   NewLayout already applies `env(safe-area-inset-top, 0px)` / `env(safe-area-inset-bottom,
 *   0px)` inline-style padding to its root shell div. This is the REFERENCE pattern that
 *   `LegacyLayout` (`./layout.tsx`) is being brought into parity with — see
 *   `./layout.test.tsx`. Per plan `135`'s must_haves, NewLayout's existing safe-area behavior
 *   MUST be preserved or improved, never regressed, by the LegacyLayout fix.
 * @edge-cases
 *   - This test is a non-regression PIN, not a red-phase test: it MUST pass today, against
 *     current `dev`, AND continue to pass after E4's LegacyLayout fix lands (E4 touches only
 *     `layout.tsx`, never `layout-new.tsx`).
 *   - Uses the same source-text-parsing approach as `./layout.test.tsx` and `../pwa.test.ts`
 *     for consistency, and so both layouts are asserted the identical way (apples-to-apples
 *     parity check).
 * @testability
 *   Same rationale as `./layout.test.tsx`: `env()` is not observable via DOM mount under
 *   `bun test`'s happy-dom environment, so this parses source text rather than mounting.
 * @see ./layout.tsx (the component being brought into parity with this one)
 * @see ./layout.test.tsx (the red-phase test for LegacyLayout's matching change)
 * @see ../../../../.yui-soul/plans/wip/135-opencode-safari-pwa-viewport-fix/e2-spec-contract.md
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const layoutNewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "layout-new.tsx")

function extractRootDivOpenTag(source: string): string {
  const classMarker =
    'class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"'
  const classIndex = source.indexOf(classMarker)
  if (classIndex === -1) return ""
  const tagStart = source.lastIndexOf("<div", classIndex)
  if (tagStart === -1) return ""
  const tagEnd = source.indexOf(">", classIndex)
  if (tagEnd === -1) return ""
  return source.slice(tagStart, tagEnd + 1)
}

describe("NewLayout root shell — safe-area-inset padding (non-regression pin)", () => {
  test("root shell div's class string is unchanged (anchor sanity check)", async () => {
    const source = await readFile(layoutNewPath, "utf8")
    const openTag = extractRootDivOpenTag(source)
    expect(openTag).not.toBe("")
  })

  test("root shell div applies env(safe-area-inset-top, 0px) as padding-top", async () => {
    const source = await readFile(layoutNewPath, "utf8")
    const openTag = extractRootDivOpenTag(source)
    expect(openTag).toMatch(/"padding-top":\s*"env\(safe-area-inset-top,\s*0px\)"/)
  })

  test("root shell div applies env(safe-area-inset-bottom, 0px) as padding-bottom", async () => {
    const source = await readFile(layoutNewPath, "utf8")
    const openTag = extractRootDivOpenTag(source)
    expect(openTag).toMatch(/"padding-bottom":\s*"env\(safe-area-inset-bottom,\s*0px\)"/)
  })
})
