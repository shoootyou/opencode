/**
 * @spec-handoff
 * @interface SessionProgressIndicatorV2(props: ComponentProps<"svg"> & { color?: string }): JSX.Element
 *   File: `./session-progress-indicator-v2.tsx`. Add `color?: string` to the prop type (it is
 *   NOT a standard SVG attribute in `ComponentProps<"svg">`'s underlying type — this is a new,
 *   component-specific prop). Add `"color"` to the existing `splitProps(props, [...])` local
 *   destructure list alongside `class`/`classList`/`width`/`height`.
 * @behavior
 *   - When `props.color` is set, the rendered `<svg>` carries an inline `style` attribute that
 *     sets the CSS custom property `--session-progress-indicator-color` to that exact value:
 *     `style={local.color ? { "--session-progress-indicator-color": local.color } : undefined}`.
 *   - When `props.color` is omitted/undefined, the rendered `<svg>` has NO such inline style
 *     (no `style` attribute at all, or at minimum no `--session-progress-indicator-color`
 *     declaration) — this is the no-regression fallback path.
 *   - The CSS default color declaration in `session-progress-indicator-v2.css` must read:
 *     `color: var(--session-progress-indicator-color, var(--v2-icon-icon-muted, #808080));`
 *     (exact fallback chain preserved — this is a static text assertion on the stylesheet,
 *     not a rendered-style assertion, since jsdom/happy-dom does not resolve `@import`/cascade).
 *   - Sub-fix B (cascade-layer fix, same two files): `packages/session-ui/src/styles/index.css`
 *     must import `../v2/components/session-progress-indicator-v2.css` wrapped in
 *     `layer(components)` — the same named layer `basic-tool.css` already uses, so
 *     `basic-tool.css`'s higher-specificity `--task-agent-color` override rule can win within
 *     that layer. `session-progress-indicator-v2.tsx` must NOT contain a bare/unlayered
 *     self-import of its own CSS (`import "./session-progress-indicator-v2.css"`) — that bare
 *     import is what currently makes the stylesheet unconditionally outrank every layered rule
 *     per CSS Cascade Layers Level 1, regardless of selector specificity. The self-import line
 *     must be REMOVED, not left in place alongside the new layered import (leaving both would
 *     double-register the stylesheet and the unlayered copy would still win, making the fix a
 *     no-op).
 * @edge-cases
 *   - `color` prop value can be any CSS color string, including a `var(...)` reference (e.g.
 *     `var(--v2-avatar-bg-cyan)`) — the component does not validate or transform the value, it
 *     passes it through verbatim into the inline custom-property declaration.
 *   - Existing consumers that omit `color` entirely (e.g. the Storybook stories file) must keep
 *     rendering with no inline `--session-progress-indicator-color` override, falling through to
 *     the CSS default chain.
 * @testability (Sub-fix B)
 *   Cascade-layer precedence itself (whether an unlayered rule actually outranks a layered one
 *   at paint time) is NOT asserted here — happy-dom/jsdom does not implement CSS `@layer`
 *   resolution or even parse/apply external stylesheets loaded via `@import` at all, so there is
 *   no DOM/CSSOM signal in this test harness that would move when the bug is fixed vs. not. This
 *   mirrors the exact SolidJS/`createSimpleContext` and shim-gap limitations already documented
 *   in this repo's own test files (see `dialog-command-palette-v2.test.tsx`'s `@testability`
 *   note) — where a rendered-DOM assertion is unavailable, this repo's established fallback is a
 *   structural, source-text pin on the exact import/removal in question. Sub-fix B's tests below
 *   therefore assert only the two structural facts the spec's Done criteria list as
 *   independently verifiable without a browser: (1) `index.css` contains the exact layered
 *   `@import` line, (2) the component `.tsx` no longer contains the bare self-import. Full
 *   cascade-precedence confirmation (which rule actually wins visually) is explicitly deferred to
 *   the E2 spec's mandated live-verification step (agent-browser, once available) — NOT
 *   satisfiable by this or any unit test in the current harness.
 * @see ./session-progress-indicator-v2.tsx (component under test)
 * @see ./session-progress-indicator-v2.css (CSS default fallback chain, Sub-fix A CSS-only change)
 * @see ../../styles/index.css (Sub-fix B's target — add the layered `@import`)
 * @see ../../../../.yui-soul/plans/wip/209-opencode-subagent-animation-project-color/e2-taku-spec-task1.md (spec source, both sub-fix contracts + live-verification requirement)
 */

import { describe, expect, test, mock } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

// Redirect solid-js/solid-js-web to their browser builds (bun test resolves the "node"
// condition by default, which maps both packages to server/SSR stubs that cannot mount into
// a DOM). Mirrors the identical preload-shim pattern already established in
// `packages/app/solid-web-browser-shim.ts` for this same repo-wide bun-test/SolidJS gap.
const solidPkg = Bun.resolveSync("solid-js", import.meta.dir).replace(/\/dist\/[^/]+\.c?js$/, "")
mock.module("solid-js", async () => await import(`${solidPkg}/dist/solid.js`))
mock.module("solid-js/web", async () => await import(`${solidPkg}/web/dist/web.js`))

// Provide the same React.createElement -> createComponent shim `packages/app` uses, since this
// package's tsconfig also has `jsx: "preserve"` (React-style JSX emit consumed by SolidJS at
// runtime via createComponent).
const { createComponent } = await import(`${solidPkg}/dist/solid.js`)
// `@types/react`'s ambient `ReactHTML`-typed global is not installed in this package, so
// `globalThis.React` has no matching declared type here — cast through `unknown` at the
// assignment boundary only (the shim function itself remains fully typed internally).
;(globalThis as unknown as { React: unknown }).React = {
  createElement(
    tag: string | ((...args: unknown[]) => unknown),
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) {
    const merged: Record<string, unknown> = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    if (typeof tag === "function") return createComponent(tag as () => unknown, merged)
    const el = document.createElement(tag)
    for (const [key, val] of Object.entries(merged)) {
      if (key === "children") continue
      if (key === "style" && typeof val === "object" && val !== null) {
        for (const [prop, value] of Object.entries(val as Record<string, string>)) {
          el.style.setProperty(prop, value)
        }
        continue
      }
      el.setAttribute(key, val as string)
    }
    const flatChildren = merged.children !== undefined ? [merged.children].flat(Infinity) : []
    for (const child of flatChildren) {
      if (child == null) continue
      if (typeof child === "string" || typeof child === "number") el.appendChild(document.createTextNode(String(child)))
      else if (child instanceof Node) el.appendChild(child)
    }
    return el
  },
}

const { render } = await import(`${solidPkg}/web/dist/web.js`)
const { SessionProgressIndicatorV2 } = await import("./session-progress-indicator-v2")

function mountIntoContainer(props: { color?: string } = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <SessionProgressIndicatorV2 {...props} />, container)
  return {
    svg: container.querySelector("svg"),
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

describe("SessionProgressIndicatorV2 color prop (Sub-fix A)", () => {
  test("renders an inline --session-progress-indicator-color custom property when color is provided", () => {
    const { svg, dispose } = mountIntoContainer({ color: "var(--v2-avatar-bg-cyan)" })
    expect(svg).not.toBeNull()
    expect(svg!.style.getPropertyValue("--session-progress-indicator-color")).toBe("var(--v2-avatar-bg-cyan)")
    dispose()
  })

  test("passes through an arbitrary color value verbatim (no transformation)", () => {
    const { svg, dispose } = mountIntoContainer({ color: "#ff00aa" })
    expect(svg!.style.getPropertyValue("--session-progress-indicator-color")).toBe("#ff00aa")
    dispose()
  })

  test("no color prop -> no --session-progress-indicator-color inline declaration (no regression)", () => {
    const { svg, dispose } = mountIntoContainer()
    expect(svg).not.toBeNull()
    expect(svg!.style.getPropertyValue("--session-progress-indicator-color")).toBe("")
    dispose()
  })
})

describe("session-progress-indicator-v2.css default color fallback chain (Sub-fix A, static text pin)", () => {
  test("default color declaration reads var(--session-progress-indicator-color, var(--v2-icon-icon-muted, #808080))", async () => {
    const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-progress-indicator-v2.css")
    const source = await readFile(cssPath, "utf8")
    expect(source).toMatch(
      /color:\s*var\(--session-progress-indicator-color,\s*var\(--v2-icon-icon-muted,\s*#808080\)\)/,
    )
  })
})

describe("Sub-fix B: cascade-layer registration (structural/source-text pins — see @testability note above)", () => {
  test("packages/session-ui/src/styles/index.css imports session-progress-indicator-v2.css under layer(components)", async () => {
    const indexCssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "styles",
      "index.css",
    )
    const source = await readFile(indexCssPath, "utf8")
    expect(source).toMatch(
      /@import\s+["']\.\.\/v2\/components\/session-progress-indicator-v2\.css["']\s+layer\(components\)\s*;/,
    )
  })

  test("session-progress-indicator-v2.tsx no longer contains a bare/unlayered self-import of its own CSS", async () => {
    const tsxPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-progress-indicator-v2.tsx")
    const source = await readFile(tsxPath, "utf8")
    expect(source).not.toMatch(/import\s+["']\.\/session-progress-indicator-v2\.css["']/)
  })
})
