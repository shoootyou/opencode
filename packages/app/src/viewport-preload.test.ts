/**
 * @spec-handoff
 * @interface packages/app/public/oc-viewport-preload.js (IIFE, no exports)
 *   Runs at first paint (synchronous `<script>` in `<head>`, right after the
 *   theme-preload script, no `defer`/`async`/`type="module"`). Sets the CSS
 *   custom property `--app-viewport-height` on `document.documentElement`
 *   ONLY when running as an installed standalone PWA
 *   (`matchMedia("(display-mode: standalone)").matches === true`).
 * @testability
 *   Mirrors ./theme-preload.test.ts: the script is read as raw source via
 *   `Bun.file(...).text()` and executed with `Function(src)()` (not imported
 *   as a module — the file has no exports, it mutates global DOM state via
 *   IIFE side effect). `window.matchMedia`, `window.visualViewport`, and
 *   `window.innerHeight` are mocked per-test with `Object.defineProperty`
 *   (all `configurable: true` so later tests can redefine them).
 * @behavior
 *   - Non-standalone: does nothing — property stays unset, no listeners
 *     attached (a later `resize` dispatch has no effect).
 *   - Standalone: on load, synchronously sets `--app-viewport-height` from
 *     `window.visualViewport.height` (preferred) or `window.innerHeight`
 *     (fallback when `visualViewport` is unavailable).
 *   - Standalone: re-syncs the property whenever `window` fires `resize`
 *     OR `window.visualViewport` fires `resize` — both listeners are wired
 *     independently, since Safari's dynamic toolbar / on-screen-keyboard
 *     changes can fire `visualViewport` resize without firing `window`
 *     resize (the exact gap the original padding-only fix missed).
 * @edge-cases
 *   - `visualViewport` undefined at all times → falls back to `innerHeight`
 *     both on initial sync and on subsequent `window` resize.
 *   - index.html must load the script eagerly (no `defer`/`async`/module)
 *     immediately after `oc-theme-preload-script`, or the property isn't set
 *     before first paint and the standalone-mode CSS flashes at the wrong
 *     size before this script runs.
 * @see ./theme-preload.test.ts (eval-based testability pattern this mirrors)
 * @see ./pwa.test.ts (companion drift-guard tests for the index.css consumer)
 * @see ../../../.yui-soul/plans/wip/135-opencode-safari-pwa-viewport-fix/e10-viewport-preload-spec.md
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PROPERTY = "--app-viewport-height"

const src = await Bun.file(new URL("../public/oc-viewport-preload.js", import.meta.url)).text()

const run = () => Function(src)()

function propertyValue() {
  return document.documentElement.style.getPropertyValue(PROPERTY)
}

function mockMatchMedia(standalone: boolean) {
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: standalone,
      }) as MediaQueryList,
    configurable: true,
  })
}

// A minimal visualViewport double: exposes `height` and captures listeners
// registered via `addEventListener("resize", ...)` so a test can invoke one
// directly, proving the script wires visualViewport's OWN resize event
// (not just window's).
function mockVisualViewport(height: number) {
  const listeners: Array<() => void> = []
  const viewport = {
    height,
    addEventListener: (type: string, cb: () => void) => {
      if (type === "resize") listeners.push(cb)
    },
    removeEventListener: () => {},
  }
  Object.defineProperty(window, "visualViewport", {
    value: viewport,
    configurable: true,
  })
  return { viewport, fireResize: () => listeners.forEach((cb) => cb()) }
}

function clearVisualViewport() {
  Object.defineProperty(window, "visualViewport", {
    value: undefined,
    configurable: true,
  })
}

function mockInnerHeight(height: number) {
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true })
}

beforeEach(() => {
  document.documentElement.style.removeProperty(PROPERTY)
  mockMatchMedia(false)
  clearVisualViewport()
  mockInnerHeight(768)
})

describe("viewport preload", () => {
  test("does nothing when not running in standalone display-mode", () => {
    mockMatchMedia(false)
    mockVisualViewport(894)

    run()

    expect(propertyValue()).toBe("")
  })

  test("does not attach a resize listener when not standalone", () => {
    mockMatchMedia(false)
    mockInnerHeight(812)

    run()
    mockInnerHeight(1000)
    window.dispatchEvent(new Event("resize"))

    expect(propertyValue()).toBe("")
  })

  test("sets the property synchronously from visualViewport.height when standalone", () => {
    mockMatchMedia(true)
    mockVisualViewport(894)

    run()

    expect(propertyValue()).toBe("894px")
  })

  test("falls back to window.innerHeight when visualViewport is unavailable", () => {
    mockMatchMedia(true)
    clearVisualViewport()
    mockInnerHeight(812)

    run()

    expect(propertyValue()).toBe("812px")
  })

  test("re-syncs the property when window fires resize", () => {
    mockMatchMedia(true)
    clearVisualViewport()
    mockInnerHeight(812)

    run()
    expect(propertyValue()).toBe("812px")

    mockInnerHeight(650)
    window.dispatchEvent(new Event("resize"))

    expect(propertyValue()).toBe("650px")
  })

  test("re-syncs the property when visualViewport itself fires resize (not via window)", () => {
    mockMatchMedia(true)
    const { viewport, fireResize } = mockVisualViewport(894)

    run()
    expect(propertyValue()).toBe("894px")

    // Mutate the mocked viewport's height and invoke its OWN captured resize
    // listener directly — no window-level "resize" event is dispatched here.
    // This is the load-bearing assertion: it proves the script listens to
    // visualViewport's resize independently of window's, which is the exact
    // gap that made the original padding-only fix insufficient (Safari's
    // dynamic toolbar/keyboard changes fire visualViewport resize without
    // necessarily firing window resize).
    viewport.height = 650
    fireResize()

    expect(propertyValue()).toBe("650px")
  })
})

describe("index.html references oc-viewport-preload.js", () => {
  const indexHtmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html")

  test("the exact preload script tag is present immediately after the theme-preload script", async () => {
    const source = await readFile(indexHtmlPath, "utf8")
    const expected =
      '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>\n' +
      '    <script id="oc-viewport-preload-script" src="/oc-viewport-preload.js"></script>'
    expect(source).toContain(expected)
  })

  test("the preload script tag has no defer, async, or type=module attribute", async () => {
    const source = await readFile(indexHtmlPath, "utf8")
    const match = source.match(/<script id="oc-viewport-preload-script"[^>]*><\/script>/)
    expect(match).not.toBeNull()
    const tag = match?.[0] ?? ""
    expect(tag).not.toMatch(/\bdefer\b/)
    expect(tag).not.toMatch(/\basync\b/)
    expect(tag).not.toMatch(/type=["']module["']/)
  })
})
