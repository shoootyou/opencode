/**
 * @spec-handoff
 * @interface
 *   File: `packages/app/src/components/plugin-status-indicator.tsx` (E8; AMENDED for RFC 050
 *   revision 5 — D20-D26 cross-directory scope — in E8b)
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
 *   // rather than mounting the full SDK-wired tree. `Row` now carries `directory` (D22) — see
 *   // the rendered-DOM contract below for what changes as a result.
 *   export function PluginStatusIndicatorView(props: { rows: Accessor<Row[]> }): JSX.Element
 *
 *   // The real, SDK-wired component. Mounts once inside `Titlebar` (D8). Owns the
 *   // `Map`-based store (`./plugin-status-indicator-logic.ts`'s `createStore`/`writeEntry`,
 *   // now directory-keyed), subscribes to EVERY server event via
 *   // `useServerSDK().event.listen(handler)` — NEVER `useSDK()`/`sdk().event.on(...)`, per D25
 *   // (this is what E8 already implemented; D25 only corrects revision-4's own prose about it).
 *   // `listen`'s handler receives `{ name, details }`: `details` is the event
 *   // (`details.type === "plugin.custom"` gate, reading `details.properties.pluginID` /
 *   // `.event` / `.data`, NEVER `details.data.*`), and `name` is the emitter key — the
 *   // DIRECTORY for a live event (D24), taken VERBATIM, including the literal string
 *   // `"global"` if it appears (never dropped, never filtered). Refetches
 *   // `GET /plugin-ui/snapshot` on every `server.connected` (via `shouldRefetchSnapshot`,
 *   // matched on `details.type` — the emitter key is NOT consulted for this event, since
 *   // `server.connected` itself arrives under the literal `"global"` key). On a snapshot
 *   // refetch, EACH entry's directory comes from that entry's OWN `SnapshotEntry.directory`
 *   // field (D22) — never from any ambient/caller directory context — and a single response
 *   // whose `entries` mix rows from multiple directories populates every one of those
 *   // directory buckets in one ingestion pass (D20/D21). Renders through the existing
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
 *     data-plugin-id={row.pluginID} data-event-name={row.eventName} data-directory={row.directory}>`
 *     per row, in the given (already-sorted) row order. **AMENDED (D22):** the glyph gains
 *     `data-directory` — for identification/testability only. The glyph carries NO visible
 *     directory label: RFC §2d/D22 is explicit that "the glyph row is not labelled: at 1–3
 *     glyphs there is no width for it".
 *   - `>3` rows → the trigger content is `<span data-testid="plugin-status-indicator">` wrapping
 *     exactly one `<span data-testid="plugin-status-badge" data-severity={worst}
 *     data-count={String(rows.length)}>` (never a per-row glyph, and never a directory
 *     attribute — the badge aggregates across whatever directories contributed to it).
 *   - Tapping the trigger opens the Popover body, which lists **every** row (even when collapsed
 *     to a badge) as one `<div data-testid="plugin-status-row" data-plugin-id={row.pluginID}
 *     data-event-name={row.eventName} data-directory={row.directory} title={row.directory}>`
 *     each — **AMENDED (D22):** the row div gains `data-directory` AND a `title` attribute
 *     carrying the FULL directory path (the tooltip/ambiguous-case affordance the RFC names) —
 *     containing one `<span data-testid="plugin-status-directory-label">{basename(row.directory)}</span>`
 *     as the FIRST child (the visible secondary label, per RFC: "each Popover row is labelled
 *     with the basename of its directory ... alongside the existing pluginID/eventName
 *     identity"), followed by one `<div data-testid="plugin-status-data-row"
 *     data-key={key}>{key}: {value}</div>` per `dataRows(row.entry)` pair
 *     (`./plugin-status-indicator-logic.ts`), rendered via ordinary JSX text interpolation
 *     (Solid's default `textContent`-writing behavior) — never `innerHTML`, never a
 *     template-string built into an attribute that could parse as markup, never a `<a href>` for
 *     any value. `basename(directory)` is the final path segment after stripping a trailing
 *     separator, e.g. `/home/rodo/code/opencode` → `"opencode"`; a directory with no separator
 *     at all (the literal `"global"`) is its own basename verbatim — `"global"` → `"global"`.
 *     The label is DATA, not copy: it must not be translated, reformatted, or routed through the
 *     i18n layer (RFC §2d "Row labelling").
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
 *   - **D24 — live-event directory source:** the SDK-wired `PluginStatusIndicator` reads the
 *     directory for a `plugin.custom` arrival from `payload.name` (the `event.listen` callback's
 *     `{ name, details }`), taken VERBATIM — including the literal string `"global"`, which MUST
 *     be retained and rendered, never dropped or filtered. There is no client-side directory
 *     filter anywhere in this component.
 *   - **D22 — snapshot-merge directory source:** a cold-start `GET /plugin-ui/snapshot` entry's
 *     directory comes from that entry's own `SnapshotEntry.directory` field, never from the
 *     component's own ambient directory context (this component has none — it is mounted once,
 *     server-scoped, per D25).
 *   - **D20/D21 — cross-directory aggregation:** a single snapshot response whose `entries` array
 *     mixes rows from two different directories populates BOTH directory buckets in one
 *     ingestion pass, each rendered and attributed with its own `directory`.
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
 *   - The SDK-wired `PluginStatusIndicator` tests below mock BOTH `@/context/server-sdk`
 *     (`useServerSDK`) and `./titlebar` (`useTitlebarRightMount`) in full, rather than mounting
 *     real providers — mirroring `session-archive-commands.test.tsx`'s `mock.module` precedent
 *     for exactly this class of context-heavy hook. `refetchSnapshot`'s `await` chain is one
 *     microtask hop deep once the mocked `snapshot()` call resolves; tests that trigger a
 *     `server.connected` event `await Promise.resolve()` twice afterward to let it settle before
 *     asserting on the DOM.
 *
 * @see .yui-soul/rfcs/approved/050-opencode-plugin-ui-event-channel/README.md (§2c "Tap-to-open
 *      Popover, never a Tooltip", §2d "Rendering safety — spec'd, not assumed", §2d "Row
 *      labelling" (revision 5), D20, D21, D22, D24, D25)
 * @see ./plugin-status-indicator-logic.test.ts (companion zero-UI-import test file — sort,
 *      collapse, eviction, TTL, severity ranking, directory-keyed store math; NOT duplicated here)
 * @see ./PwaUpdatePrompt.test.tsx (the `mock.module` + `render()` DOM-mount pattern this file
 *      follows)
 * @see ./session-archive-commands.test.tsx (the `mock.module("@/context/server-sdk", ...)`
 *      precedent the SDK-wired tests below follow)
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
 *   was never supposed to exist for this specific risk. The SDK-wired tests below mock
 *   `useTitlebarRightMount()` entirely and therefore do not exercise real portal-target
 *   resolution either — they exercise the directory-attribution wiring only.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
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
// Mocks for the SDK-wired `PluginStatusIndicator` tests (D20/D21/D22/D24). Mirrors
// `session-archive-commands.test.tsx`'s `mock.module("@/context/server-sdk", ...)` precedent —
// full replacement rather than partial context, since `useServerSDK`/`useTitlebarRightMount` both
// require real provider ancestors this file does not set up.
//
// `capturedListener` captures the SINGLE `event.listen(handler)` callback the component
// registers, letting a test simulate an arriving server event by invoking it directly with a
// `{ name, details }` payload shaped exactly like `useServerSDK().event.listen`'s real handler
// argument (`name` = the emitter key / directory, `"global"` for un-directoried events like
// `server.connected`; `details` = the event itself).
// ---------------------------------------------------------------------------
type ListenPayload = { name: string; details: { type: string; properties?: Record<string, unknown> } }
type ListenHandler = (payload: ListenPayload) => void

let capturedListener: ListenHandler | undefined
let snapshotResponse: {
  data?: {
    serverTime: number
    entries: Array<{
      directory: string
      pluginID: string
      event: string
      data: Record<string, unknown>
      publishedAt: number
    }>
  }
} = { data: undefined }
let mountTargetEl: HTMLElement | null = null

mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({
    event: {
      listen: (handler: ListenHandler) => {
        capturedListener = handler
        return () => {
          capturedListener = undefined
        }
      },
    },
    client: {
      pluginUi: {
        snapshot: async () => snapshotResponse,
      },
    },
  }),
}))

mock.module("./titlebar", () => ({
  useTitlebarRightMount: () => () => mountTargetEl,
}))

// ---------------------------------------------------------------------------
// The component is dynamically imported AFTER mock.module is registered, per the
// PwaUpdatePrompt.test.tsx precedent (mock.module hoisting order matters for module-graph mocks).
// ---------------------------------------------------------------------------
let PluginStatusIndicatorView: (props: { rows: Accessor<Row[]> }) => JSX.Element
let PluginStatusIndicator: () => JSX.Element

async function loadComponent() {
  const mod = await import("./plugin-status-indicator")
  PluginStatusIndicatorView = mod.PluginStatusIndicatorView
  PluginStatusIndicator = mod.PluginStatusIndicator
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function row(overrides: Partial<Row> & { data?: Record<string, unknown> }): Row {
  return {
    directory: overrides.directory ?? "/repo/project-a",
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

function mountWired() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const target = document.createElement("div")
  document.body.appendChild(target)
  mountTargetEl = target

  const dispose = render(() => PluginStatusIndicator(), container)
  return {
    container,
    mountTarget: target,
    dispose: () => {
      dispose()
      container.remove()
      target.remove()
    },
  }
}

function openPopover(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>("[data-testid='popover-trigger']")
  expect(trigger).not.toBeNull()
  trigger!.click()
}

beforeEach(() => {
  capturedListener = undefined
  snapshotResponse = { data: undefined }
  mountTargetEl = null
})

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
// Directory attribution and rendering (D22) — basename label, full path as title, data-directory
// ---------------------------------------------------------------------------
describe("PluginStatusIndicatorView — directory attribution and rendering (D22)", () => {
  test("a glyph carries data-directory for identification but renders no visible directory label (no width for it at 1-3 glyphs)", async () => {
    await loadComponent()
    const rows = [row({ directory: "/repo/project-a", eventName: "e1" })]
    const { container, dispose } = mountView(rows)

    const glyph = container.querySelector("[data-testid='plugin-status-glyph']")
    expect(glyph).not.toBeNull()
    expect(glyph?.getAttribute("data-directory")).toBe("/repo/project-a")
    expect(container.querySelector("[data-testid='plugin-status-directory-label']")).toBeNull()
    dispose()
  })

  test("each Popover row is labelled with its directory's basename, with the full path available as the row's title attribute", async () => {
    await loadComponent()
    const rows = [
      row({
        directory: "/home/rodo/code-projects/personal/opencode",
        pluginID: "budget",
        eventName: "spend",
      }),
    ]
    const { container, dispose } = mountView(rows)

    openPopover(container)

    const rowEl = container.querySelector("[data-testid='plugin-status-row']")
    expect(rowEl).not.toBeNull()
    expect(rowEl?.getAttribute("data-directory")).toBe("/home/rodo/code-projects/personal/opencode")
    expect(rowEl?.getAttribute("title")).toBe("/home/rodo/code-projects/personal/opencode")

    const label = container.querySelector("[data-testid='plugin-status-directory-label']")
    expect(label).not.toBeNull()
    expect(label?.textContent).toBe("opencode")
    dispose()
  })

  test("the literal directory 'global' renders its own literal string as the basename label (no separator to strip)", async () => {
    await loadComponent()
    const rows = [row({ directory: "global", pluginID: "heartbeat", eventName: "status" })]
    const { container, dispose } = mountView(rows)

    openPopover(container)

    const label = container.querySelector("[data-testid='plugin-status-directory-label']")
    expect(label?.textContent).toBe("global")
    const rowEl = container.querySelector("[data-testid='plugin-status-row']")
    expect(rowEl?.getAttribute("title")).toBe("global")
    dispose()
  })

  test("two rows sharing (pluginID, eventName) but differing only by directory render as two distinct, independently-attributed Popover rows", async () => {
    await loadComponent()
    const rows = [
      row({ directory: "/repo/project-a", pluginID: "budget", eventName: "spend" }),
      row({ directory: "/repo/project-b", pluginID: "budget", eventName: "spend" }),
    ]
    const { container, dispose } = mountView(rows)

    openPopover(container)

    const rowEls = container.querySelectorAll("[data-testid='plugin-status-row']")
    expect(rowEls.length).toBe(2)
    const directories = [...rowEls].map((el) => el.getAttribute("data-directory")).sort()
    expect(directories).toEqual(["/repo/project-a", "/repo/project-b"])
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

// ---------------------------------------------------------------------------
// SDK-wired PluginStatusIndicator — directory attribution (D20/D21/D22/D24)
// ---------------------------------------------------------------------------
describe("PluginStatusIndicator — SDK-wired component, directory attribution (D20/D21/D22/D24)", () => {
  test("a live plugin.custom event's directory comes from payload.name, taken verbatim (D24)", async () => {
    await loadComponent()
    snapshotResponse = { data: { serverTime: Date.now(), entries: [] } }
    const { mountTarget, dispose } = mountWired()

    expect(capturedListener).toBeDefined()
    capturedListener?.({
      name: "/repo/project-a",
      details: { type: "plugin.custom", properties: { pluginID: "budget", event: "spend", data: {} } },
    })

    const glyph = mountTarget.querySelector("[data-testid='plugin-status-glyph']")
    expect(glyph).not.toBeNull()
    expect(glyph?.getAttribute("data-directory")).toBe("/repo/project-a")
    dispose()
  })

  test("the literal directory 'global' from a live event is retained verbatim, never dropped or filtered (D24)", async () => {
    await loadComponent()
    snapshotResponse = { data: { serverTime: Date.now(), entries: [] } }
    const { mountTarget, dispose } = mountWired()

    capturedListener?.({
      name: "global",
      details: { type: "plugin.custom", properties: { pluginID: "heartbeat", event: "status", data: {} } },
    })

    const glyph = mountTarget.querySelector("[data-testid='plugin-status-glyph']")
    expect(glyph).not.toBeNull()
    expect(glyph?.getAttribute("data-directory")).toBe("global")
    dispose()
  })

  test("a cold-start snapshot entry's directory comes from SnapshotEntry.directory, not any ambient caller directory (D22)", async () => {
    await loadComponent()
    const serverTime = Date.now()
    snapshotResponse = {
      data: {
        serverTime,
        entries: [
          {
            directory: "/repo/project-a",
            pluginID: "budget",
            event: "spend",
            data: { pct: 82 },
            publishedAt: serverTime - 1_000,
          },
        ],
      },
    }
    const { mountTarget, dispose } = mountWired()

    capturedListener?.({ name: "global", details: { type: "server.connected", properties: {} } })
    await Promise.resolve()
    await Promise.resolve()

    const glyph = mountTarget.querySelector("[data-testid='plugin-status-glyph']")
    expect(glyph).not.toBeNull()
    expect(glyph?.getAttribute("data-directory")).toBe("/repo/project-a")
    dispose()
  })

  test("a single snapshot response with entries for directory A AND directory B populates BOTH directory buckets in one ingestion pass (D20/D21)", async () => {
    await loadComponent()
    const serverTime = Date.now()
    snapshotResponse = {
      data: {
        serverTime,
        entries: [
          {
            directory: "/repo/project-a",
            pluginID: "budget",
            event: "spend",
            data: {},
            publishedAt: serverTime - 1_000,
          },
          {
            directory: "/repo/project-b",
            pluginID: "budget",
            event: "spend",
            data: {},
            publishedAt: serverTime - 2_000,
          },
        ],
      },
    }
    const { mountTarget, dispose } = mountWired()

    capturedListener?.({ name: "global", details: { type: "server.connected", properties: {} } })
    await Promise.resolve()
    await Promise.resolve()

    const glyphs = mountTarget.querySelectorAll("[data-testid='plugin-status-glyph']")
    expect(glyphs.length).toBe(2)
    const directories = [...glyphs].map((el) => el.getAttribute("data-directory")).sort()
    expect(directories).toEqual(["/repo/project-a", "/repo/project-b"])
    dispose()
  })
})
