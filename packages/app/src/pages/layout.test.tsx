/**
 * @spec-handoff
 * @interface LegacyLayout(props: ParentProps): JSX.Element
 *   File: packages/app/src/pages/layout.tsx (default export, ~line 87 onward). Root shell
 *   div declared at ~line 2306-2309 (line numbers may drift; this test locates it by its
 *   stable `class` string rather than by line number).
 * @behavior
 *   The `prod`-channel default layout (see `settings.newlayoutdefault.test.ts`) MUST apply
 *   `env(safe-area-inset-top, 0px)` / `env(safe-area-inset-bottom, 0px)` inline-style padding
 *   to its root shell div, mirroring `NewLayout`'s existing pattern (`layout-new.tsx:28-33`).
 *   Combined with the unchanged `#root { height: 100vh }` standalone-mode override in
 *   `index.css` (see `pwa.test.ts`'s drift guard), this prevents content from rendering flush
 *   against the physical screen edges iOS reserves for the status bar / home-indicator when
 *   the app runs as an installed Safari PWA.
 * @edge-cases
 *   - The root div's `class` attribute must be unchanged (this is a style/padding addition
 *     ONLY — no class/layout changes), so this test also pins the exact existing class string
 *     to catch accidental collateral edits.
 *   - The safe-area padding MUST use the `env()` CSS function with an explicit `0px` fallback
 *     (matches `NewLayout`'s pattern exactly), not a bare `env(safe-area-inset-top)` without a
 *     fallback, and not a hardcoded pixel value.
 * @testability
 *   `env()` and computed styles are not observable via DOM mount under `bun test`'s environment
 *   (happy-dom does not resolve `env()`), and `LegacyLayout` pulls in heavy app-wide context
 *   providers (router, platform, sessions) that are impractical to mount in isolation. Following
 *   the established drift-guard convention in `./pwa.test.ts`, this test parses the component's
 *   source text directly and asserts the inline `style` object is present on the correct
 *   element, rather than mounting the component.
 * @see ./layout-new.tsx (the pattern this change mirrors)
 * @see ./layout-new.test.tsx (non-regression pin for NewLayout's existing safe-area behavior)
 * @see ../pwa.test.ts (drift guard for the companion `#root { height: 100vh }` CSS rule)
 * @see ../../../../.yui-soul/plans/wip/135-opencode-safari-pwa-viewport-fix/e2-spec-contract.md
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const layoutPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "layout.tsx")

// The root shell div's stable class string (unique in the file — used as an anchor to locate
// the exact JSX element under test, independent of line-number drift elsewhere in this large
// file). Captures from the class attribute up to the next `>` that closes the opening tag,
// tolerating either a self-closing single-line div or one with a subsequent `style={{...}}`.
function extractRootDivOpenTag(source: string): string {
  const classMarker =
    'class="relative bg-background-base flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"'
  const classIndex = source.indexOf(classMarker)
  if (classIndex === -1) return ""
  // Walk back to the start of the opening tag ("<div").
  const tagStart = source.lastIndexOf("<div", classIndex)
  if (tagStart === -1) return ""
  // Walk forward to the end of the opening tag (the first unescaped ">" after the class
  // marker — safe here because attribute values in this codebase don't contain literal ">").
  const tagEnd = source.indexOf(">", classIndex)
  if (tagEnd === -1) return ""
  return source.slice(tagStart, tagEnd + 1)
}

describe("LegacyLayout root shell — safe-area-inset padding (Safari standalone PWA fix)", () => {
  test("root shell div's class string is unchanged (anchor sanity check)", async () => {
    const source = await readFile(layoutPath, "utf8")
    const openTag = extractRootDivOpenTag(source)
    expect(openTag).not.toBe("")
  })

  test("root shell div applies env(safe-area-inset-top, 0px) as padding-top", async () => {
    const source = await readFile(layoutPath, "utf8")
    const openTag = extractRootDivOpenTag(source)
    expect(openTag).toMatch(/"padding-top":\s*"env\(safe-area-inset-top,\s*0px\)"/)
  })

  test("root shell div applies env(safe-area-inset-bottom, 0px) as padding-bottom", async () => {
    const source = await readFile(layoutPath, "utf8")
    const openTag = extractRootDivOpenTag(source)
    expect(openTag).toMatch(/"padding-bottom":\s*"env\(safe-area-inset-bottom,\s*0px\)"/)
  })

  test("root shell div's style block does not hardcode a pixel fallback other than the spec's 0px", async () => {
    const source = await readFile(layoutPath, "utf8")
    const openTag = extractRootDivOpenTag(source)
    // Guards against a lazy fix like `padding-top: "20px"` instead of the env()-driven pattern.
    expect(openTag).not.toMatch(/"padding-(top|bottom)":\s*"\d/)
  })
})
