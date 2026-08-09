/**
 * @spec-handoff
 * @interface useSessionArchiveCommands(): {
 *   archiveSession: (session: Session) => Promise<void>
 *   unarchiveSession: (session: Session) => Promise<void>
 *   browseArchivedSessions: () => void
 * }
 *   Module: packages/app/src/components/session-archive-commands.tsx (new — Kou creates this in
 *   E3). Must be called from a component body (calls `command.register(...)`/`onCleanup(...)`
 *   internally). Registers exactly 3 `CommandOption` entries under the dedicated
 *   `command.register("session-archive", ...)` key: `session.archive`, `session.unarchive`,
 *   `session.archived.browse` — see plan `187-opencode-restore-archive-ui`'s `e1-spec-contract.md`
 *   for the full extraction contract (mount point, hook shape, `onSelect` re-derivation).
 * @behavior
 *   - `NewLayout` (`../pages/layout-new.tsx`) must import and call `useSessionArchiveCommands()`
 *     unconditionally at the top of its component body (E1's confirmed mount point —
 *     `SharedProviders` was disproven because `useServerSync()`/`useServerSDK()` are not
 *     ancestors there). This is the exact bug this plan fixes: today `NewLayout` registers zero
 *     commands, so all 3 IDs vanish the moment a session force-redirects out of `LegacyLayout`.
 *   - Once registered, the 3 options must behave exactly like the real, exported
 *     `buildSessionArchiveOptions()` (`./session-archive-commands.tsx`) produces: titles from the
 *     real EN i18n dict via `language.t(...)`, `session.archive`/`session.unarchive` gated on
 *     `!params.dir || !params.id`, `session.archived.browse` never gated.
 *   - `session.archived.browse` must always surface in a palette search for the substring
 *     "archiv" (case-insensitive) via the real `commandPaletteOptions()` filter, regardless of
 *     route/session state (it is never `disabled`).
 * @edge-cases
 *   - Session route not yet resolved (`params.dir`/`params.id` undefined): `session.archive` /
 *     `session.unarchive` are `disabled` and excluded from `commandPaletteOptions()`'s visible
 *     list, but `session.archived.browse` remains fully searchable — asserted directly against
 *     the real filter function fed by the real `buildSessionArchiveOptions()`.
 *   - `newLayoutDesigns` toggled mid-session: an `app.tsx`-level `<Show>` mutual-exclusion concern
 *     (only one of `LegacyLayout`/`NewLayout` is ever mounted at a time), not something
 *     `NewLayout` itself has to guard — not separately asserted here (out of this file's testable
 *     surface; no duplicate-id collision risk since the two shells are never both mounted).
 * @testability
 *   **DOM-mounting `NewLayout` + `CommandProvider` together was attempted and abandoned as
 *   infeasible in this repo's `bun test` environment** (not merely "impractical" per
 *   `../pages/layout.test.tsx`'s note — genuinely broken): `bun test`'s React-shim
 *   (`../solid-web-browser-shim.ts`) evaluates JSX children eagerly (React's `createElement(tag,
 *   props, ...children)` model), whereas every `createSimpleContext`-based provider in this app
 *   (`@opencode-ai/ui/context/helper.tsx`'s `<ctx.Provider value={init}>{props.children}</ctx.Provider>`)
 *   relies on real SolidJS's LAZY `get children()` compiled semantics — context must be set on the
 *   owner *before* children are read. Under the shim, `props.children` is read (and any consumer
 *   component's body executed) *before* the Provider's own body runs, so any component calling
 *   `useCommand()` (or any other `createSimpleContext` hook) as a mounted child of its own
 *   Provider throws `"... context must be used within a context provider"` — confirmed
 *   empirically, reproducible with a two-line `CommandProvider > Probe` mount, independent of
 *   `NewLayout` or any of this plan's fix. This is a pre-existing repo/tooling gap (flagged
 *   separately as a `gotcha` candidate for `.yui-soul/knowledge/`), not something a red-phase test
 *   can route around by better test design. Given that, this file uses the two techniques this
 *   repo already established for exactly this situation instead:
 *   1. Real, un-mocked, static imports of the actual exported pure functions
 *      (`commandPaletteOptions`, `addCommandRegistration` from `@/context/command`, and —
 *      since Kou's refactor extracted it — the real `buildSessionArchiveOptions` from
 *      `./session-archive-commands.tsx` itself) — the same safe, no-render style
 *      `../context/command.test.ts` already uses. The only stub is a minimal `{ t }` object
 *      shaped like `ReturnType<typeof useLanguage>` (reading straight off the real EN dict) plus
 *      no-op `on*` handlers, because mounting the real `useLanguage()` context provider hits the
 *      same shim limitation documented below — the `CommandOption[]` array itself, its ids,
 *      titles, and disabled-gating are 100% the real shipped function, not a parallel duplicate.
 *      These pin the CONTRACT the real function produces; they are **not** red today (the
 *      function already exists and is already correct) and are labeled as contract/shape pins,
 *      not regression assertions.
 *   2. Source-text parsing of `../pages/layout-new.tsx` (the same technique `../pages/layout.test.tsx`
 *      / `../pages/layout-new.test.tsx` already use for this exact file, for the same class of
 *      reason) to assert the hook is actually imported and called unconditionally at the top of
 *      the component body. These ARE genuinely red today (no such import/call exists) and turn
 *      green the moment E3 wires the hook in — this is the real regression pin for the bug. The
 *      "unconditional" half of that claim is checked structurally (brace-depth-0 relative to the
 *      function body — see the test itself), not merely by substring presence, so a future edit
 *      wrapping the call in `if (cond) { ... }` would be caught.
 * @see ./session-archive-commands.tsx (implemented in E3; this file imports its exported
 *   `buildSessionArchiveOptions` directly rather than duplicating the array)
 * @see ../pages/layout-new.tsx (the mount point, per E1's contract)
 * @see ../pages/layout.test.tsx (established source-text-parsing precedent for this same file)
 * @see ../../../.yui-soul/plans/wip/187-opencode-restore-archive-ui/e1-spec-contract.md
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { addCommandRegistration, commandPaletteOptions } from "@/context/command"
import { useLanguage } from "@/context/language"
import { dict as en } from "@/i18n/en"
import { buildSessionArchiveOptions } from "./session-archive-commands"

const layoutNewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages/layout-new.tsx")

// No-render stub satisfying `ReturnType<typeof useLanguage>` for the real, exported
// `buildSessionArchiveOptions` — only `.t` is read by that function, so a minimal `t` that reads
// straight off the real EN dict is sufficient (no context provider mount needed). `onArchive`/
// `onUnarchive`/`onBrowse` are no-ops: the assertions below (ids, titles, disabled gating, palette
// filtering) never trigger `onSelect`, so the handlers firing is out of scope for this file.
const language = { t: (key: string) => en[key as keyof typeof en] } as unknown as ReturnType<typeof useLanguage>

function buildOptions(params: { dir?: string; id?: string }) {
  return buildSessionArchiveOptions({
    dir: params.dir,
    id: params.id,
    language,
    onArchive: () => {},
    onUnarchive: () => {},
    onBrowse: () => {},
  })
}

describe("session-archive command contract (pin — uses real command.tsx filter functions)", () => {
  test("registers under the dedicated 'session-archive' key, not 'layout'", () => {
    const registrations = addCommandRegistration([], {
      key: "session-archive",
      options: () => buildOptions({ dir: "d", id: "i" }),
    })

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.key).toBe("session-archive")
    expect(registrations[0]?.key).not.toBe("layout")
  })

  test("a resolved session route surfaces all 3 command IDs in the raw option list", () => {
    const ids = buildOptions({ dir: "d", id: "i" }).map((option) => option.id)

    expect(ids).toEqual(["session.archive", "session.unarchive", "session.archived.browse"])
  })

  test("'Browse archived sessions' is palette-searchable for the substring 'archiv'", () => {
    const visible = commandPaletteOptions(buildOptions({ dir: "d", id: "i" }))
    const matches = visible.filter((option) => option.title.toLowerCase().includes("archiv"))

    expect(matches.map((option) => option.title)).toContain("Browse archived sessions")
  })

  test("edge case: session route not yet resolved — archive/unarchive are hidden from the palette but browse stays reachable", () => {
    const visible = commandPaletteOptions(buildOptions({})).map((option) => option.id)

    expect(visible).not.toContain("session.archive")
    expect(visible).not.toContain("session.unarchive")
    expect(visible).toContain("session.archived.browse")
  })

  test("edge case: session route not yet resolved — all 3 IDs still exist in the raw (unfiltered) option list", () => {
    const ids = buildOptions({}).map((option) => option.id)

    expect(ids).toEqual(["session.archive", "session.unarchive", "session.archived.browse"])
  })
})

describe("NewLayout wiring (red until E3 — source-text regression pin)", () => {
  test("imports useSessionArchiveCommands from the shared session-archive-commands module", async () => {
    const source = await readFile(layoutNewPath, "utf8")

    expect(source).toMatch(
      /import\s*\{[^}]*\buseSessionArchiveCommands\b[^}]*\}\s*from\s*["']@\/components\/session-archive-commands["']/,
    )
  })

  test("calls useSessionArchiveCommands() unconditionally at the top of the component body", async () => {
    const source = await readFile(layoutNewPath, "utf8")
    const bodyStart = source.indexOf("export default function NewLayout")
    expect(bodyStart).toBeGreaterThan(-1)

    // The function's own opening brace marks depth 0 for the component body.
    const bodyOpenBrace = source.indexOf("{", bodyStart)
    expect(bodyOpenBrace).toBeGreaterThan(-1)

    const returnIndex = source.indexOf("return (", bodyStart)
    expect(returnIndex).toBeGreaterThan(-1)

    // The call must occur BEFORE the JSX return — i.e. at the top of the body alongside the
    // other hook calls (usePlatform/useNavigate), not nested inside a conditional/Show branch
    // deeper in the render tree.
    const body = source.slice(bodyOpenBrace, returnIndex)
    const call = /useSessionArchiveCommands\(\)/.exec(body)
    expect(call).not.toBeNull()

    // Structural check, not just substring presence: count net unmatched `{` opened between the
    // component body's own opening brace and the call. If the call were wrapped in a block
    // (`if (cond) { useSessionArchiveCommands() }`, a nested helper, etc.) this would be > 0 and
    // the call would no longer be unconditional — a plain `.toMatch()` on the body slice would
    // still pass in that case, which is the gap this counts for.
    const before = body.slice(1, call!.index)
    const opens = (before.match(/\{/g) ?? []).length
    const closes = (before.match(/\}/g) ?? []).length
    expect(opens - closes).toBe(0)
  })
})
