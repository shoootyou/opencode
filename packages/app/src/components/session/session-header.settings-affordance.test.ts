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
 *   - The activation handler and the label are wired to the SAME live JSX element: extraction
 *     positively anchors to the `<Show when={isV2}>` tag's own true-branch children (never "just
 *     outside fallback"), resolves the component it renders, and requires one JSX tag in that
 *     component's body whose `onClick` AND `aria-label` BOTH resolve — inline, or via a
 *     `props.state.*` field traced back to its own definition, bounded to that field's own
 *     comma-terminated value — to the real trigger/label, not merely to a differently-wired
 *     sibling control (e.g. the review-panel toggle). See @edge-cases for what this rejects.
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
 *     most users — including default New Layout users — ever see. The fallback-exclusion anchors
 *     to THIS SPECIFIC `<Show when={isV2}>` tag (not the first `fallback={` in the whole file —
 *     this file has 3 such props), so a fix landed only there stays RED here.
 *   - Must NOT be satisfied by (regression fixtures below, each independently proven RED): (a)
 *     dead/unconditional/ungated code containing both strings, with no real fix present anywhere;
 *     (b) a real button with `onClick` stripped; (c) the trigger call demoted to a `//` comment;
 *     (d) the whole button JSX deleted while its state fields dangle unused. Also must NOT be
 *     satisfied by a structurally-similar-but-wrong control (e.g. the review-panel toggle, which
 *     has its own `onClick`/`aria-label` pair on the same tag shape but resolves to different
 *     content) — this is what catches a same-object-different-field mismatch.
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
 *   applied to a sibling regression). This file therefore uses source-text parsing with brace/tag
 *   -balanced, block-scoped extraction (never a bare whole-file substring search) instead of a
 *   render-and-click test. Separately, this repo's shim does not implement `classList={{...}}` on
 *   native DOM elements (stringified as `"[object Object]"`), a second, independent reason a
 *   DOM-mount approach would not reliably observe this button's active/pressed state even if the
 *   provider-tree issue above were solved — not relied on here.
 * @see ./session-header.tsx (the file E2 edits)
 * @see ./settings-dialog.tsx (`useSettingsCommand` — already-correct, unchanged by this plan)
 * @see ../session-archive-commands.test.tsx (source-text-parsing + @testability precedent)
 * @see ../dialog-select-file.test.tsx (source-text-parsing + brace/structural-check precedent)
 * @see ../../../../.yui-soul/plans/wip/263-opencode-settings-nav-affordance/e1-regression-test.md
 * @see ../../../../.yui-soul/reviews/263-opencode-settings-nav-affordance/r1-shin.md (round-1
 *   critical finding this rewrite addresses: vacuous-pass via co-occurrence-only matching)
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sessionHeaderPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-header.tsx")

const SETTINGS_TRIGGER = /command\.trigger\(\s*["']settings\.open["']\s*\)/
const SETTINGS_LABEL = /language\.t\(\s*["'](?:sidebar\.settings|command\.settings\.open)["']/
const FILE_OPEN_TRIGGER = /command\.trigger\(\s*["']file\.open["']\s*\)/

// The real fix's state-object fields (`v2ActionsState`), used by the regression fixtures below to
// surgically remove the fix before proving a vacuous-pass mutation still stays RED.
const SETTINGS_STATE_FIELDS_BLOCK =
  '    settingsLabel: language.t("sidebar.settings"),\n' +
  '    settingsKeybind: command.keybindParts("settings.open"),\n' +
  '    onSettingsOpen: () => command.trigger("settings.open"),\n'

// The real fix's visible button JSX (inside `SessionHeaderV2Actions`), identified by its unique
// wrapping `<TooltipV2>` opening text — used by the regression fixtures to delete the button block.
const SETTINGS_BUTTON_BLOCK_START =
  '      <TooltipV2\n        class="shrink-0"\n        placement="bottom"\n        value={\n          <>\n            {props.state.settingsLabel}'

/**
 * Given an index at an opening bracket (`(`, `{`, or `[`), walks forward tracking aggregate
 * bracket depth across all three kinds and returns the index of the matching closer. Valid for
 * well-formed source: bracket kinds always nest as a proper tree, so the first time depth returns
 * to 0 is necessarily the closer for the bracket at `openIndex`.
 */
function findMatchingCloser(source: string, openIndex: number): number {
  let depth = 1
  for (let i = openIndex + 1; i < source.length; i++) {
    const ch = source[i]
    if ("([{".includes(ch)) depth++
    else if (")]}".includes(ch)) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Extracts a top-level `function NAME(...) { ... }` declaration's full body by name — skipping
 * past any `{`/`}` that appear inside the parameter list's type annotations (e.g.
 * `props: { state: Foo }`) before locating the REAL body-opening brace.
 */
function extractFunctionBody(source: string, name: string): string | null {
  const signature = new RegExp(`function\\s+${name}\\s*\\(`).exec(source)
  if (!signature) return null

  const paramsOpen = source.indexOf("(", signature.index)
  if (paramsOpen === -1) return null
  const paramsClose = findMatchingCloser(source, paramsOpen)
  if (paramsClose === -1) return null

  const bodyOpen = source.indexOf("{", paramsClose)
  if (bodyOpen === -1) return null
  const bodyClose = findMatchingCloser(source, bodyOpen)
  if (bodyClose === -1) return null

  return source.slice(signature.index, bodyClose + 1)
}

/**
 * Extracts a `const NAME = <expr>` definition's full text by name. Terminates at a top-level `;`
 * if present, otherwise as soon as the RHS's own brackets fully close back to depth 0 (this
 * codebase does not use semicolons, so `createMemo(() => ({...}))`-shaped RHS values close
 * exactly at their own final `)`).
 */
function extractConstDefinition(source: string, name: string): string | null {
  const declaration = new RegExp(`\\bconst\\s+${name}\\b`).exec(source)
  if (!declaration) return null
  const eqIndex = source.indexOf("=", declaration.index)
  if (eqIndex === -1) return null

  let depth = 0
  let opened = false
  for (let i = eqIndex + 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === ";" && depth <= 0) return source.slice(declaration.index, i)
    if ("([{".includes(ch)) {
      depth++
      opened = true
    } else if (")]}".includes(ch)) {
      depth--
    }
    if (opened && depth === 0) return source.slice(declaration.index, i + 1)
  }
  return null
}

/**
 * Extracts one object-literal field's value text (the RHS of `fieldName: <value>`), stopping at
 * the field's own top-level comma or the enclosing object's closing brace — NOT at an arbitrary
 * character window. This means a same-line trailing `// comment` after the value's terminating
 * comma is never included, so `x: () => {}, // command.trigger(...)` correctly extracts only
 * `() => {}` as the live value.
 */
function extractObjectFieldValue(objectText: string, fieldName: string): string | null {
  const key = new RegExp(`[{,]\\s*${fieldName}\\s*:`).exec(objectText)
  if (!key) return null

  const valueStart = key.index + key[0].length
  let depth = 0
  for (let i = valueStart; i < objectText.length; i++) {
    const ch = objectText[i]
    if ("([{".includes(ch)) depth++
    else if (")]}".includes(ch)) {
      if (depth === 0) return objectText.slice(valueStart, i)
      depth--
    } else if (ch === "," && depth === 0) return objectText.slice(valueStart, i)
  }
  return objectText.slice(valueStart)
}

/**
 * Given an index at a JSX tag's opening `<`, returns the `[start, end]` (inclusive) span of that
 * tag up to its own closing `>` — tracking `{}` depth (not `<>`) so a nested self-closing JSX
 * element inside an attribute expression (e.g. `icon={<IconV2 name="settings-gear" />}`) does not
 * prematurely terminate the outer tag at its inner `/>`.
 */
function findJsxTagSpan(source: string, tagStart: number): { start: number; end: number } | null {
  let depth = 0
  for (let i = tagStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === "{") depth++
    else if (ch === "}") depth--
    else if (ch === ">" && depth === 0) return { start: tagStart, end: i }
  }
  return null
}

/**
 * Locates the FIRST `<Show>` closing tag matching the one opened at `childrenStart` (i.e. right
 * after the `<Show when={isV2} ...>` opening tag's own `>`), counting nested `<Show` / `</Show>`
 * occurrences so a nested Show inside the true-branch children does not close the outer one early.
 */
function findMatchingShowClose(source: string, childrenStart: number): number {
  let depth = 1
  let cursor = childrenStart
  while (depth > 0) {
    const nextOpen = source.indexOf("<Show", cursor)
    const nextClose = source.indexOf("</Show>", cursor)
    if (nextClose === -1) return -1
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++
      cursor = nextOpen + "<Show".length
      continue
    }
    depth--
    if (depth === 0) return nextClose
    cursor = nextClose + "</Show>".length
  }
  return -1
}

/**
 * Finds the first capitalized JSX component reference inside `children` (e.g.
 * `<SessionHeaderV2Actions state={v2ActionsState()} />`) and returns its tag name plus any bare
 * identifiers passed as prop values (call-expression or plain), so the caller can trace those
 * identifiers back to their own definitions elsewhere in the file.
 */
function findJsxComponentReference(children: string): { name: string; propIdentifiers: string[] } | null {
  const tagStart = /<([A-Z][A-Za-z0-9]*)\b/.exec(children)
  if (!tagStart) return null
  const span = findJsxTagSpan(children, tagStart.index)
  if (!span) return null

  const tagText = children.slice(span.start, span.end + 1)
  const propIdentifiers = [...tagText.matchAll(/=\{\s*([A-Za-z_]\w*)\s*(?:\(\))?\s*\}/g)].map((m) => m[1])
  return { name: tagStart[1], propIdentifiers }
}

/**
 * Scans `body` for a JSX tag whose `onClick` AND `aria-label` BOTH resolve — inline, matching the
 * target regex directly on the tag text, or via a `props.state.<field>` reference traced back to
 * `stateDefinitions` and checked, bounded to that field's own value, against the target regex —
 * to the real thing. This requires a genuine, live, same-tag pairing: a structurally similar but
 * differently-wired sibling control (e.g. the review-panel toggle, which has its own onClick/
 * aria-label pair on an identically-shaped tag) does NOT satisfy this, because its fields resolve
 * to different content.
 */
function hasWiredSettingsTag(body: string, stateDefinitions: string[]): boolean {
  const resolvesLive = (field: string | null, directOk: boolean, pattern: RegExp): boolean => {
    if (directOk) return true
    if (field === null) return false
    return stateDefinitions.some((definition) => {
      const value = extractObjectFieldValue(definition, field)
      return value !== null && pattern.test(value)
    })
  }

  const tagStartPattern = /<[A-Za-z][\w-]*\b/g
  let tagStart: RegExpExecArray | null
  while ((tagStart = tagStartPattern.exec(body))) {
    const span = findJsxTagSpan(body, tagStart.index)
    if (!span) continue
    const tagText = body.slice(span.start, span.end + 1)

    const onClickIndirect = /onClick=\{\s*props\.state\.(\w+)\s*\}/.exec(tagText)
    const onClickDirect = SETTINGS_TRIGGER.test(tagText) && /onClick=\{/.test(tagText)
    const ariaLabelIndirect = /aria-label=\{\s*props\.state\.(\w+)\s*\}/.exec(tagText)
    const ariaLabelDirect = SETTINGS_LABEL.test(tagText) && /aria-label=\{/.test(tagText)

    if (!onClickIndirect && !onClickDirect) continue
    if (!ariaLabelIndirect && !ariaLabelDirect) continue

    const onClickLive = resolvesLive(onClickIndirect?.[1] ?? null, onClickDirect, SETTINGS_TRIGGER)
    const ariaLabelLive = resolvesLive(ariaLabelIndirect?.[1] ?? null, ariaLabelDirect, SETTINGS_LABEL)
    if (onClickLive && ariaLabelLive) return true
  }
  return false
}

type WiringInspection = {
  trueChildren: string | null
  componentName: string | null
  componentBody: string | null
  wired: boolean
}

const NOT_WIRED: WiringInspection = { trueChildren: null, componentName: null, componentBody: null, wired: false }

/**
 * The full structural pipeline: positively anchors to THIS FILE'S ONE `<Show when={isV2}>` tag
 * (locating its `fallback={...}` prop relative to THAT tag, not the file's first `fallback={`
 * occurrence — fixes the round-1 LOW finding), extracts its true-branch (isV2 === true) children,
 * resolves the JSX component they render, and checks that component's own body for a JSX tag with
 * a live, same-tag `onClick`+`aria-label` pairing wired to the Settings trigger/label. Returns
 * progressively more of `NOT_WIRED` the earlier the pipeline fails, so callers can assert on
 * exactly where a mutation broke the chain.
 */
function inspectSettingsWiring(source: string): WiringInspection {
  const showTags = [...source.matchAll(/<Show\s+when=\{isV2\}/g)]
  if (showTags.length !== 1) return NOT_WIRED
  const showTagStart = showTags[0].index!

  const fallbackAnchor = source.indexOf("fallback={", showTagStart)
  if (fallbackAnchor === -1) return NOT_WIRED
  const fallbackBraceStart = fallbackAnchor + "fallback=".length
  if (source[fallbackBraceStart] !== "{") return NOT_WIRED
  const fallbackBraceEnd = findMatchingCloser(source, fallbackBraceStart)
  if (fallbackBraceEnd === -1) return NOT_WIRED

  const openTagClose = source.indexOf(">", fallbackBraceEnd + 1)
  if (openTagClose === -1) return NOT_WIRED
  if (source.slice(fallbackBraceEnd + 1, openTagClose).trim() !== "") return NOT_WIRED

  const childrenStart = openTagClose + 1
  const childrenEnd = findMatchingShowClose(source, childrenStart)
  if (childrenEnd === -1) return NOT_WIRED

  const trueChildren = source.slice(childrenStart, childrenEnd)
  const componentRef = findJsxComponentReference(trueChildren)
  if (!componentRef) return { ...NOT_WIRED, trueChildren }

  const componentBody = extractFunctionBody(source, componentRef.name)
  if (!componentBody) return { ...NOT_WIRED, trueChildren, componentName: componentRef.name }

  const stateDefinitions = componentRef.propIdentifiers
    .map((identifier) => extractConstDefinition(source, identifier))
    .filter((definition): definition is string => definition !== null)

  const wired = hasWiredSettingsTag(componentBody, stateDefinitions)
  return { trueChildren, componentName: componentRef.name, componentBody, wired }
}

/** The `fallback={...}` prop's own JSX text for the file's one `<Show when={isV2}>` tag. */
function findShowIsV2FallbackBlock(source: string): string {
  const showTags = [...source.matchAll(/<Show\s+when=\{isV2\}/g)]
  const showTagStart = showTags[0]?.index ?? 0
  const fallbackAnchor = source.indexOf("fallback={", showTagStart)
  const fallbackBraceStart = fallbackAnchor + "fallback=".length
  const fallbackBraceEnd = findMatchingCloser(source, fallbackBraceStart)
  return source.slice(fallbackBraceStart, fallbackBraceEnd + 1)
}

/** Removes the real fix's visible button JSX block (its wrapping `<TooltipV2>...</TooltipV2>`). */
function removeSettingsButtonBlock(source: string): string {
  const start = source.indexOf(SETTINGS_BUTTON_BLOCK_START)
  if (start === -1) throw new Error("fixture setup: could not locate the real Settings button block")
  const end = source.indexOf("</TooltipV2>", start) + "</TooltipV2>".length
  return source.slice(0, start) + source.slice(end)
}

describe("SessionHeader isV2 (New Layout) branch — Settings trigger regression", () => {
  test("sanity: the isV2-anchored fallback extraction isolates the Legacy branch, not real isV2 content", async () => {
    const source = await readFile(sessionHeaderPath, "utf8")
    const fallbackBlock = findShowIsV2FallbackBlock(source)

    // Known-true content of the Legacy (isV2 === false) branch today — proves this extraction
    // grabbed the right span, not an arbitrary/empty one.
    expect(fallbackBlock).toContain("command.review.toggle")
    expect(fallbackBlock).toContain("layout.fileTree.toggle")
    // The one thing under test must NOT be findable inside the isolated Legacy-only span.
    expect(fallbackBlock).not.toMatch(SETTINGS_TRIGGER)
  })

  test("the isV2-true branch renders a Settings control with a live, activation-wired command.trigger(\"settings.open\") and label on the same element", async () => {
    const source = await readFile(sessionHeaderPath, "utf8")
    const result = inspectSettingsWiring(source)

    // The isV2-true branch must render an actual JSX component reference — not be empty, and not
    // rely on dead code sitting elsewhere in the file outside this branch.
    expect(result.trueChildren).not.toBeNull()
    // That component must be a real, locally-defined function whose body we can inspect.
    expect(result.componentName).not.toBeNull()
    expect(result.componentBody).not.toBeNull()
    // A single JSX tag in that body has a live, same-tag onClick+aria-label pair resolving to the
    // real Settings trigger/label — not to a sibling control, not to a stripped/deleted/commented
    // fix (see the regression fixtures below for each of those cases proven RED).
    expect(result.wired).toBe(true)
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

  describe("vacuous-pass regression fixtures (round-1 audit finding 1, a-d) — each must stay RED", () => {
    test("(a) dead, unconditional, ungated code with both strings, and the real fix fully removed, does NOT satisfy the check", async () => {
      const source = await readFile(sessionHeaderPath, "utf8")

      const withoutStateFields = source.replace(SETTINGS_STATE_FIELDS_BLOCK, "")
      expect(withoutStateFields).not.toBe(source) // sanity: removed the real fix's state fields
      const withoutFix = removeSettingsButtonBlock(withoutStateFields)

      const mutated =
        withoutFix +
        '\nconst _unconditionalDeadCode = () => {\n  command.trigger("settings.open")\n  return language.t("sidebar.settings")\n}\nvoid _unconditionalDeadCode\n'

      // The real fix is gone; the only occurrences of both strings are dead, ungated code sitting
      // outside the resolved component's own body — must NOT satisfy the check.
      expect(inspectSettingsWiring(mutated).wired).toBe(false)
    })

    test("(b) a real button with onClick stripped does NOT satisfy the check", async () => {
      const source = await readFile(sessionHeaderPath, "utf8")
      const mutated = source.replace("onClick={props.state.onSettingsOpen}\n          ", "")
      expect(mutated).not.toBe(source) // sanity: the mutation actually matched something

      expect(inspectSettingsWiring(mutated).wired).toBe(false)
    })

    test('(c) the trigger demoted to a dead "//" comment does NOT satisfy the check', async () => {
      const source = await readFile(sessionHeaderPath, "utf8")
      const mutated = source.replace(
        'onSettingsOpen: () => command.trigger("settings.open"),',
        'onSettingsOpen: () => {}, // command.trigger("settings.open")',
      )
      expect(mutated).not.toBe(source) // sanity: the mutation actually matched something

      // The JSX tag itself is untouched (still references props.state.onSettingsOpen); only the
      // field's own live value changed. Confirm the field-value boundary correctly excludes the
      // trailing same-line comment before asserting the overall pipeline goes RED.
      const withoutFieldsRemoved = extractConstDefinition(mutated, "v2ActionsState")
      expect(withoutFieldsRemoved).not.toBeNull()
      expect(extractObjectFieldValue(withoutFieldsRemoved!, "onSettingsOpen")).not.toMatch(SETTINGS_TRIGGER)

      expect(inspectSettingsWiring(mutated).wired).toBe(false)
    })

    test("(d) the visible button JSX deleted while its state fields dangle unused does NOT satisfy the check", async () => {
      const source = await readFile(sessionHeaderPath, "utf8")
      const mutated = removeSettingsButtonBlock(source)
      expect(mutated).not.toBe(source) // sanity: the mutation actually removed something

      // The dangling settingsLabel/onSettingsOpen fields remain in v2ActionsState, but nothing in
      // SessionHeaderV2Actions's body references them anymore — must NOT satisfy the check.
      expect(inspectSettingsWiring(mutated).wired).toBe(false)
    })
  })
})
