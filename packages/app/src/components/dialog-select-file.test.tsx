/**
 * @spec-handoff
 * @interface createServerSessionEntries(props: {
 *   server: ServerConnection.Key
 *   opened: () => LocalProject[]
 *   stored: () => Project[]
 *   load: (search: string, signal: AbortSignal) => Promise<{ data: SessionInfo[] }>
 *   untitled: () => string
 *   category: () => string
 * }): (text: string) => Promise<CommandPaletteEntry[]>
 *   File: `./command-palette.ts` (unchanged by this plan — already correctly filters archived
 *   sessions). Consumed by `./dialog-select-file.tsx` (`DialogSelectFileLegacy`) and
 *   `./dialog-command-palette-v2.tsx` (both layouts' file/session search).
 * @behavior — Decision A (resolved 2026-07-29, `e1-spec-contract.md`)
 *   - Archived sessions are excluded from `createServerSessionEntries`'s results (this is
 *     ALREADY true on `dev` today — line `command-palette.ts:261`,
 *     `.filter((session) => !session.time.archived)` — verified here as a non-regression pin,
 *     not a red assertion).
 *   - Returned session entries NEVER carry a truthy `archived` field (the mapped object literal
 *     never sets one — see `command-palette.ts:262-276`), which behaviorally guarantees the
 *     dimmed-row rendering condition (`!!item.archived`) in `dialog-select-file.tsx` can never be
 *     true for any entry actually produced by this function, regardless of what the archived
 *     session's real `time.archived` timestamp is.
 *   - The sole discovery surface for archived sessions is the "Browse archived sessions" command
 *     (`session.archived.browse`, restored in `./session-archive-commands.tsx` — see
 *     `./session-archive-commands.test.tsx`), NOT the general command-palette/file search this
 *     file tests.
 * @behavior — `dialog-select-file.tsx` dead-code removal (RED until E3)
 *   - The dimmed-row `classList={{ "opacity-70": !!item.archived }}` rendering branch inside the
 *     `<Match when={item.type === "session"}>` block of `DialogSelectFileLegacy` (currently
 *     `dialog-select-file.tsx` lines ~156-183) must be REMOVED as dead code, per Decision A — not
 *     merely proven unreachable by data (the behavior test above already does that on unmodified
 *     `dev`), but actually deleted from source.
 * @edge-cases
 *   - Mixed input (archived + non-archived siblings): only the non-archived session must survive
 *     filtering; the archived one must not leak through under any circumstance.
 *   - An empty search string short-circuits to `[]` before any archived-filtering logic runs
 *     (existing behavior, `command-palette.ts:233-236` — pinned here as a non-regression guard so
 *     a future refactor can't accidentally move the archived filter behind this early return).
 * @testability
 *   Mounting `DialogSelectFileLegacy` (or `DialogCommandPaletteV2`) to inspect the ACTUAL rendered
 *   DOM for a dimmed row was attempted and found infeasible in this repo's `bun test` environment
 *   for two independent, empirically-confirmed reasons (see `./session-archive-commands.test.tsx`'s
 *   `@testability` note for the first): (1) `bun test`'s React-shim cannot lazily forward
 *   `props.children` through nested `createSimpleContext` providers (this file's
 *   `createCommandPaletteModel` pulls in `useDialog`/`useGlobal`/`useTabs`/`useFile`/`useLayout`/
 *   `useServerSDK`, all of which need real provider ancestors); (2) independently, the shim's
 *   native-DOM-element branch does not implement SolidJS's `classList={{...}}` reactive attribute
 *   at all (confirmed empirically: `el.setAttribute("classList", "[object Object]")` instead of
 *   toggling an actual `class` on the element) — so even a DOM mount of an isolated `classList`-only
 *   fragment cannot observe the dimming class either way. Given that, this file combines (a) a
 *   real, un-mocked, direct call to the actual exported `createServerSessionEntries` (no
 *   duplicated logic, no mocking of the function under test) to prove the DATA behaviorally never
 *   satisfies the dimming condition, with (b) a source-text pin (matching the established
 *   `../pages/layout.test.tsx` precedent) confirming the actual dead JSX is deleted. Together
 *   these satisfy "verified at the behavior level, not just code deleted": the behavior half
 *   proves unreachability by construction of the data; the source-text half proves the dead
 *   branch referencing that unreachable condition is actually gone, not just inert.
 * @see ./command-palette.ts (createServerSessionEntries — unchanged; the function under test)
 * @see ./dialog-select-file.tsx (the file E3 edits — dead dimmed-row branch removed)
 * @see ../../../.yui-soul/plans/wip/187-opencode-restore-archive-ui/e1-spec-contract.md
 */

import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServerSessionEntries } from "./command-palette"
import { ServerConnection } from "@/context/server"

const dialogSelectFilePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "dialog-select-file.tsx")

// Builds a real-shaped SDK Session with only the fields createServerSessionEntries reads varied
// per case (mirrors ./browse-archived.test.ts's `session()` helper for consistency).
function session(overrides: Partial<Session> & { id: string; time: Session["time"] }): Session {
  return {
    slug: overrides.id,
    projectID: "project-1",
    directory: "/work/project-1",
    title: "Default title",
    version: "1.0.0",
    ...overrides,
  } as Session
}

function buildEntries(sessions: Session[], search = "query") {
  return createRoot((dispose) => {
    const entries = createServerSessionEntries({
      server: ServerConnection.Key.make("http://localhost:4096"),
      opened: () => [],
      stored: () => [],
      // createServerSessionEntries's `load` typing expects SessionInfo (the wire shape); the real
      // implementation immediately normalizes via normalizeSessionInfo, which passes a Session
      // through unchanged when it has no `location` field (see ./browse-archived.test.ts's
      // identical fixture-typing rationale).
      load: async () => ({ data: sessions as unknown as SessionInfo[] }),
      untitled: () => "Untitled session",
      category: () => "Session",
    })
    return entries(search).finally(dispose)
  })
}

describe("createServerSessionEntries — archived-session filter (Decision A: exclusionary)", () => {
  test("excludes an archived session from a mixed archived/non-archived result set", async () => {
    const result = await buildEntries([
      session({ id: "active", title: "Active session", time: { created: 0, updated: 0 } }),
      session({ id: "archived", title: "Archived session", time: { created: 0, updated: 100, archived: 100 } }),
    ])

    expect(result.map((entry) => entry.sessionID)).toEqual(["active"])
  })

  test("returned entries never carry a truthy `archived` field (dimmed-row condition can never be true)", async () => {
    const result = await buildEntries([
      session({ id: "active-1", title: "One", time: { created: 0, updated: 0 } }),
      session({ id: "active-2", title: "Two", time: { created: 0, updated: 0 } }),
    ])

    expect(result.length).toBeGreaterThan(0)
    for (const entry of result) {
      expect(Boolean((entry as { archived?: number }).archived)).toBe(false)
    }
  })

  test("an empty search string short-circuits to [] before archived-filtering runs (non-regression guard)", async () => {
    const empty = await buildEntries([session({ id: "s1", title: "One", time: { created: 0, updated: 0 } })], "")

    expect(empty).toEqual([])
  })
})

describe("dialog-select-file.tsx dead dimmed-row branch (red until E3)", () => {
  test("no longer renders a dimmed ('opacity-70') archived-session row keyed off item.archived", async () => {
    const source = await readFile(dialogSelectFilePath, "utf8")

    expect(source).not.toMatch(/opacity-70["'][^}]*item\.archived/)
    expect(source).not.toMatch(/item\.archived/)
  })
})
