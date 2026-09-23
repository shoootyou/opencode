/**
 * @spec-handoff
 * @interface
 *   File: `packages/app/src/components/plugin-status-indicator.tsx` (new, E8)
 *
 *   ```ts
 *   import type { Accessor } from "solid-js"
 *   import type { Row } from "./plugin-status-indicator-logic"
 *
 *   // PURE presentational component — no context, no SDK, no store. Takes the already-
 *   // sorted `Row[]` (see `./plugin-status-indicator-logic.ts`'s `sortRows`) as a reactive
 *   // accessor and renders the glyph/badge + tap-to-open Popover. Exported specifically so
 *   // this test file can call it directly as a plain function (mirroring
 *   // `message-timeline.archive-guard.test.tsx`'s `mod.MessageTimeline({...props})` pattern)
 *   // rather than mounting the full SDK-wired tree.
 *   export function PluginStatusIndicatorView(props: { rows: Accessor<Row[]> }): JSX.Element
 *
 *   // The real, SDK-wired component E8 mounts once inside `Titlebar` (D8). Owns the
 *   // `Map`-based store (`./plugin-status-indicator-logic.ts`'s `createStore`/`writeEntry`),
 *   // subscribes to `plugin.custom` via `useSDK().event.on(...)` reading
 *   // `evt.properties.pluginID` / `.event` / `.data` (NEVER `evt.data.*`), refetches
 *   // `GET /plugin-ui/snapshot` on every `server.connected` (via
 *   // `shouldRefetchSnapshot`), and renders through the existing
 *   // `useTitlebarRightMount()` portal exactly like `NewSessionStatus`
 *   // (`new-session-view.tsx:77-83`): `<Show when={mount()} keyed><Portal
 *   // mount={mount()}><PluginStatusIndicatorView rows={sortedRows} /></Portal></Show>`.
 *   export function PluginStatusIndicator(): JSX.Element
 *   ```
 *
 *   **Popover contract (never `TooltipV2` — D7, hard mobile requirement):** the component MUST
 *   import `Popover` from `@opencode-ai/ui/popover` (the `StatusPopover` pattern,
 *   `components/status-popover.tsx:21`) and MUST NOT import `TooltipV2`/`@opencode-ai/ui/v2/tooltip-v2`
 *   anywhere in this file. This test file asserts that structurally (source-text guard, below) in
 *   addition to behaviorally (tap-to-open).
 *
 *   **Rendered DOM contract** (stable `data-testid`/`data-*` attributes — the actual CSS/markup is
 *   Kou's latitude, but these hooks are the test seam and must not be renamed without updating
 *   this file):
 *   - Zero rows → `PluginStatusIndicatorView` renders `null` (no `data-testid="plugin-status-indicator"`
 *     element in the DOM at all — not an empty/hidden box).
 *   - 1-3 rows → the Popover's `trigger` content is a `<span data-testid="plugin-status-indicator">`
 *     wrapping one `<span data-testid="plugin-status-glyph" data-severity={row.severity}
 *     data-plugin-id={row.pluginID} data-event-name={row.eventName}>` per row, in the given
 *     (already-sorted) row order.
 *   - `>3` rows → the trigger content is `<span data-testid="plugin-status-indicator">` wrapping
 *     exactly one `<span data-testid="plugin-status-badge" data-severity={worst}
 *     data-count={String(rows.length)}>` (never a per-row glyph).
 *   - Tapping the trigger opens the Popover body, which lists **every** row (even when collapsed
 *     to a badge) as one `<div data-testid="plugin-status-row" data-plugin-id={row.pluginID}
 *     data-event-name={row.eventName}>` each, containing one `<div data-testid="plugin-status-data-row"
 *     data-key={key}>{key}: {value}</div>` per `dataRows(row.entry)` pair (`./plugin-status-indicator-logic.ts`),
 *     rendered via ordinary JSX text interpolation (Solid's default `textContent`-writing
 *     behavior) — never `innerHTML`, never a template-string built into an attribute that could
 *     parse as markup, never a `<a href>` for any value.
 *   - `_ui` is never rendered as its own `data-key="_ui"` row (its recognized sub-keys drive the
 *     glyph/severity only; unrecognized sub-keys are silently ignored — see the logic module).
 *
 * @behavior
 *   - XSS acceptance criterion 1 (RFC §2d, hard contract): a `data` value shaped like
 *     `<img src=x onerror=alert(1)>` renders as literal text — the matching
 *     `plugin-status-data-row`'s `.textContent` equals the hostile string byte-for-byte, and no
 *     `<img>` (or any other injected element) exists anywhere in the mount.
 *   - XSS acceptance criterion 2: a `javascript:`-scheme string value never produces an `<a>`
 *     anywhere in the mount. v1 renders all values as text; there is no URL-scheme allowlist path
 *     to a live link at all.
 *   - Tap-to-open: the Popover body is absent until the trigger is tapped once, present after,
 *     and returns to absent after a second tap (StatusPopover's own controlled-open pattern).
 *   - `_ui` reserved-namespace rendering: a row whose `data.data` is
 *     `{ _ui: { status: "warn", label: "x" }, spendPct: 82 }` renders exactly one data row
 *     (`spendPct: 82`) and never a `_ui` row, in the opened Popover body.
 *
 * @edge-cases
 *   - Because Bun's own `.tsx` JSX transform (not `babel-preset-solid`) eagerly evaluates JSX
 *     children/props at the call site — see this repo's `solid-web-browser-shim.ts` header
 *     comment and the SolidJS test-convention note this plan's pre-implementation context
 *     supplies — `PluginStatusIndicatorView`'s Popover invocation and its `Show`-gated
 *     glyph-vs-badge branch MUST go through `solid-js/web`'s `createComponent(...)` directly with
 *     getter-based prop objects (`get open() { return shown() }`, `get children() {...}`),
 *     mirroring `PwaUpdatePrompt.tsx`'s established pattern, rather than raw JSX
 *     `<Popover>...</Popover>` syntax. Otherwise `open`/`children` are evaluated once at mount and
 *     never react to `shown()` toggling under `bun test`, even though the exact same source
 *     renders correctly under the real Vite+`babel-preset-solid` pipeline. This is why the mocked
 *     `@opencode-ai/ui/popover` stub below reacts via a real `createEffect` rather than reactive
 *     JSX — so the test can distinguish "component wired correctly" from "shim ate the
 *     reactivity" during E8's implementation.
 *   - `dataRows`'s `_ui`-exclusion and ascending-key-order guarantees are asserted at the pure-math
 *     level in `./plugin-status-indicator-logic.test.ts`; this file only asserts the DOM
 *     consequence (no `_ui` row rendered, and the one plain row rendered correctly) — it does not
 *     re-derive the sort/selection logic.
 *
 * @see .yui-soul/rfcs/approved/050-opencode-plugin-ui-event-channel/README.md (§2c "Tap-to-open
 *      Popover, never a Tooltip", §2d "Rendering safety — spec'd, not assumed")
 * @see ./plugin-status-indicator-logic.test.ts (companion zero-UI-import test file — sort,
 *      collapse, eviction, TTL, severity ranking; NOT duplicated here)
 * @see ./PwaUpdatePrompt.test.tsx (the `mock.module` + `render()` DOM-mount pattern this file
 *      follows)
 * @see ./status-popover.tsx:21 (the tap-to-open `Popover` pattern this component must use)
 *
 * @manual-verification-note
 *   OQ3 (RFC §2b) — portal-target initial resolution in a real browser, and whether the
 *   `newLayoutDesigns` runtime toggle orphans a long-lived mount tenant — is EXPLICITLY not
 *   unit-testable: it depends on real `getElementById` timing against the real DOM lifecycle of
 *   `<Titlebar>` swapping its `<Switch><Match>` chrome, which `happy-dom` + `render()` cannot
 *   faithfully reproduce (there is no real paint/layout pass, and `useTitlebarRightMount()`'s own
 *   `onMount`-based resolution timing is exactly the thing under question). This is deliberately
 *   left as the two `checkpoint:human-verify` tasks already recorded in
 *   `.yui-soul/plans/wip/293-opencode-plugin-ui-event-channel/e8-indicator-impl.md` (Task 2/3) —
 *   flagged here again so a future reader of this file does not go looking for a unit test that
 *   was never supposed to exist for this specific risk.
 */

import { describe, expect, mock, test } from "bun:test"
import { createEffect, type Accessor, type JSX } from "solid-js"
import { render } from "solid-js/web"
import type { Row } from "./plugin-status-indicator-logic"

// ---------------------------------------------------------------------------
// Mock `@opencode-ai/ui/popover` — the real `Popover` wraps `@kobalte/core/popover`, which
// throws without its own ancestor context (I18nProvider etc., see `packages/ui/src/context/i18n.tsx`).
// This stub is intentionally reactive via a real `createEffect` (not JSX) — see the
// @edge-cases note above for why plain JSX reactivity is NOT trustworthy under bun test's
// react-shim, and why a createEffect-based stub is what actually distinguishes "component wired
// its Popover invocation correctly" from "shim ate the reactivity" during E8.
// ---------------------------------------------------------------------------
type PopoverStubProps = {
  open?: boolean
  onOpenChange?: (next: boolean) => void
  trigger?: unknown
  children?: unknown
}

mock.module("@opencode-ai/ui/popover", () => {
  return {
    Popover: (props: PopoverStubProps) => {
      const root = document.createElement("div")
      root.setAttribute("data-testid", "popover-stub-root")

      const triggerEl = document.createElement("button")
      triggerEl.type = "button"
      triggerEl.setAttribute("data-testid", "popover-trigger")
      triggerEl.addEventListener("click", () => {
        props.onOpenChange?.(!props.open)
      })
      root.appendChild(triggerEl)

      const bodyEl = document.createElement("div")
      bodyEl.setAttribute("data-testid", "popover-body")
      root.appendChild(bodyEl)

      createEffect(() => {
        triggerEl.replaceChildren()
        const triggerContent = props.trigger
        if (triggerContent instanceof Node) triggerEl.appendChild(triggerContent)
      })

      createEffect(() => {
        bodyEl.replaceChildren()
        bodyEl.hidden = !props.open
        if (!props.open) return
        const children = props.children
        if (children instanceof Node) bodyEl.appendChild(children)
      })

      return root
    },
  }
})

// ---------------------------------------------------------------------------
// The component is dynamically imported AFTER mock.module is registered, per the
// PwaUpdatePrompt.test.tsx precedent (mock.module hoisting order matters for module-graph mocks).
// ---------------------------------------------------------------------------
let PluginStatusIndicatorView: (props: { rows: Accessor<Row[]> }) => JSX.Element

async function loadComponent() {
  const mod = await import("./plugin-status-indicator")
  PluginStatusIndicatorView = mod.PluginStatusIndicatorView
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function row(overrides: Partial<Row> & { data?: Record<string, unknown> }): Row {
  return {
    pluginID: overrides.pluginID ?? "plugin-a",
    eventName: overrides.eventName ?? "event-a",
    severity: overrides.severity ?? "ok",
    entry: overrides.entry ?? { data: overrides.data ?? {}, receivedAt: 1_000 },
  }
}

function mountView(rows: Row[]) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => PluginStatusIndicatorView({ rows: () => rows }), container)
  return {
    container,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

function openPopover(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>("[data-testid='popover-trigger']")
  expect(trigger).not.toBeNull()
  trigger!.click()
}

// ---------------------------------------------------------------------------
// Structural source-text guard — D7 hard requirement (never TooltipV2)
// ---------------------------------------------------------------------------
describe("PluginStatusIndicator source contract", () => {
  test("never imports TooltipV2 — hover-driven, dead on touch (D7)", async () => {
    const path = new URL("./plugin-status-indicator.tsx", import.meta.url).pathname
    const source = await Bun.file(path).text()
    expect(source).not.toMatch(/TooltipV2/)
    expect(source).not.toMatch(/v2\/tooltip-v2/)
  })

  test("imports Popover from @opencode-ai/ui/popover — the StatusPopover tap-to-open pattern", async () => {
    const path = new URL("./plugin-status-indicator.tsx", import.meta.url).pathname
    const source = await Bun.file(path).text()
    expect(source).toMatch(/@opencode-ai\/ui\/popover/)
  })
})

// ---------------------------------------------------------------------------
// Zero / 1-3 / >3 DOM-level smoke tests (the collapse MATH is proven in the pure-logic test file;
// this only proves the component wiring produces the DOM contract above).
// ---------------------------------------------------------------------------
describe("PluginStatusIndicatorView — render-output smoke tests", () => {
  test("zero rows renders nothing at all — no empty box, no placeholder", async () => {
    await loadComponent()
    const { container, dispose } = mountView([])
    expect(container.querySelector("[data-testid='plugin-status-indicator']")).toBeNull()
    dispose()
  })

  test("1-3 rows render one glyph each, never a badge", async () => {
    await loadComponent()
    const rows = [row({ eventName: "e1" }), row({ eventName: "e2" })]
    const { container, dispose } = mountView(rows)

    const glyphs = container.querySelectorAll("[data-testid='plugin-status-glyph']")
    expect(glyphs.length).toBe(2)
    expect(container.querySelector("[data-testid='plugin-status-badge']")).toBeNull()
    dispose()
  })

  test(">3 rows collapse to a single badge with worst severity + entry count, never per-row glyphs", async () => {
    await loadComponent()
    const rows = [
      row({ eventName: "e1", severity: "ok" }),
      row({ eventName: "e2", severity: "warn" }),
      row({ eventName: "e3", severity: "info" }),
      row({ eventName: "e4", severity: "ok" }),
    ]
    const { container, dispose } = mountView(rows)

    expect(container.querySelectorAll("[data-testid='plugin-status-glyph']").length).toBe(0)
    const badge = container.querySelector("[data-testid='plugin-status-badge']")
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute("data-severity")).toBe("warn")
    expect(badge?.getAttribute("data-count")).toBe("4")
    dispose()
  })
})

// ---------------------------------------------------------------------------
// Tap-to-open Popover behavior (D7/§2c)
// ---------------------------------------------------------------------------
describe("tap-to-open Popover behavior", () => {
  test("Popover body is absent until the trigger is tapped", async () => {
    await loadComponent()
    const { container, dispose } = mountView([row({})])

    const body = container.querySelector<HTMLElement>("[data-testid='popover-body']")
    expect(body).not.toBeNull()
    expect(body!.hidden).toBe(true)
    expect(container.querySelector("[data-testid='plugin-status-row']")).toBeNull()
    dispose()
  })

  test("tapping the trigger opens the body and lists the row", async () => {
    await loadComponent()
    const { container, dispose } = mountView([row({ pluginID: "budget", eventName: "spend" })])

    openPopover(container)

    const body = container.querySelector<HTMLElement>("[data-testid='popover-body']")
    expect(body!.hidden).toBe(false)
    const listedRow = container.querySelector("[data-testid='plugin-status-row']")
    expect(listedRow).not.toBeNull()
    expect(listedRow?.getAttribute("data-plugin-id")).toBe("budget")
    expect(listedRow?.getAttribute("data-event-name")).toBe("spend")
    dispose()
  })

  test("tapping the trigger a second time closes the body again", async () => {
    await loadComponent()
    const { container, dispose } = mountView([row({})])

    openPopover(container)
    expect(container.querySelector<HTMLElement>("[data-testid='popover-body']")!.hidden).toBe(false)

    openPopover(container)
    expect(container.querySelector<HTMLElement>("[data-testid='popover-body']")!.hidden).toBe(true)
    dispose()
  })

  test("the Popover body lists EVERY row even when collapsed to a badge", async () => {
    await loadComponent()
    const rows = [
      row({ eventName: "e1" }),
      row({ eventName: "e2" }),
      row({ eventName: "e3" }),
      row({ eventName: "e4" }),
    ]
    const { container, dispose } = mountView(rows)

    openPopover(container)

    expect(container.querySelectorAll("[data-testid='plugin-status-row']").length).toBe(4)
    dispose()
  })
})

// ---------------------------------------------------------------------------
// _ui reserved namespace — DOM consequence of the pure-logic rule
// ---------------------------------------------------------------------------
describe("_ui reserved namespace — DOM rendering", () => {
  test("a _ui object drives the glyph only and is never rendered as its own data row", async () => {
    await loadComponent()
    const rows = [
      row({
        pluginID: "budget",
        eventName: "spend",
        severity: "warn",
        data: { _ui: { status: "warn", label: "ica-gateway" }, spendPct: 82 },
      }),
    ]
    const { container, dispose } = mountView(rows)

    openPopover(container)

    const dataRows = container.querySelectorAll("[data-testid='plugin-status-data-row']")
    expect(dataRows.length).toBe(1)
    expect(dataRows[0].getAttribute("data-key")).toBe("spendPct")
    expect(dataRows[0].textContent).toBe("spendPct: 82")
    expect(container.querySelector("[data-testid='plugin-status-data-row'][data-key='_ui']")).toBeNull()
    dispose()
  })
})

// ---------------------------------------------------------------------------
// XSS acceptance criterion 1 — literal text, no injected element
// ---------------------------------------------------------------------------
describe("XSS acceptance criterion 1 — hostile HTML-shaped value renders as literal text", () => {
  test("<img src=x onerror=alert(1)> renders verbatim as text, with no injected <img> anywhere", async () => {
    await loadComponent()
    const hostile = "<img src=x onerror=alert(1)>"
    const rows = [row({ pluginID: "budget", eventName: "spend", data: { note: hostile } })]
    const { container, dispose } = mountView(rows)

    openPopover(container)

    const dataRow = container.querySelector("[data-testid='plugin-status-data-row'][data-key='note']")
    expect(dataRow).not.toBeNull()
    expect(dataRow!.textContent).toBe(`note: ${hostile}`)

    // Not merely "no error thrown" — assert against the DOM directly, whole-mount scope.
    expect(container.querySelector("img")).toBeNull()
    expect(container.innerHTML).not.toContain("<img")
    dispose()
  })
})

// ---------------------------------------------------------------------------
// XSS acceptance criterion 2 — no anchor for javascript: values, ever
// ---------------------------------------------------------------------------
describe("XSS acceptance criterion 2 — no anchor element for a javascript: value", () => {
  test("a javascript:-scheme string value never produces an <a> anywhere in the mount", async () => {
    await loadComponent()
    const rows = [
      row({ pluginID: "budget", eventName: "spend", data: { link: "javascript:alert(1)" } }),
    ]
    const { container, dispose } = mountView(rows)

    openPopover(container)

    expect(container.querySelector("a")).toBeNull()

    const dataRow = container.querySelector("[data-testid='plugin-status-data-row'][data-key='link']")
    expect(dataRow).not.toBeNull()
    expect(dataRow!.textContent).toBe("link: javascript:alert(1)")
    dispose()
  })

  test("a plain https: URL value ALSO never produces an <a> — v1 renders every value as text, no allowlist path", async () => {
    await loadComponent()
    const rows = [row({ pluginID: "budget", eventName: "spend", data: { link: "https://example.com" } })]
    const { container, dispose } = mountView(rows)

    openPopover(container)

    expect(container.querySelector("a")).toBeNull()
    dispose()
  })
})
