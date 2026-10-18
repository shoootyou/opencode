/**
 * @spec-handoff
 * @interface useTitlebarArchiveCommands(): void
 * @behavior
 *   - Registers the production archive command through the shared timeline transition.
 *   - PATCHes and hydrates the exact route server, removes its tab without automatic navigation, then lands once.
 * @edge-cases
 *   - A direct archive fallback is not a valid production command path.
 * @see RFC 057 Addendum C.4 APP-03 and R2-01
 */
import { expect, test } from "bun:test"

test("wires the actual shell archive command through shared transition cleanup and landing", async () => {
  const script = String.raw`
    import { createRoot } from "solid-js"
    import { mock } from "bun:test"
    const calls = []
    let options
    const session = { id: "a", location: { directory: "/d" }, time: {} }
    mock.module("@/shell/commands/command", () => ({ useCommand: () => ({ register: (_key, next) => { options = next } }) }))
    mock.module("@/shell/state/layout", () => ({ useLayout: () => ({ route: () => ({ type: "session", server: "s", sessionId: "a" }), home: { selection: () => ({}) } }) }))
    mock.module("@/runtime/server/runtime", () => ({ useGlobal: () => ({ servers: { list: () => ["s"] }, serverCtx: () => ({ data: { session: { get: () => session, list: () => [session, { id: "b", location: { directory: "/d" }, time: {} }] } } }), sessionArchive: { archiveSession: async () => { calls.push("direct"); return true }, setSessionArchive: async () => { calls.push("patch"); return true }, isPending: () => false } }) }))
    mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key) => key }) }))
    mock.module("@/shell/tabs/tabs", () => ({ useTabs: () => ({ store: [], removeSessions: (_detail, options) => calls.push("remove:" + options.navigate), select: () => {}, newDraft: async () => calls.push("draft") }) }))
    mock.module("@/runtime/server/registry", () => ({ ServerConnection: { key: (value) => value } }))
    mock.module("./dialog-archived-sessions", () => ({ showArchivedSessionsDialog: () => {} }))
    mock.module("@opencode/ui/context/dialog", () => ({ useDialog: () => ({}) }))
    const { useTitlebarArchiveCommands } = await import("./session-archive-commands.tsx")
    createRoot((dispose) => { useTitlebarArchiveCommands(); dispose() })
    await options().find((option) => option.id === "session.archive").onSelect()
    if (calls.includes("direct")) throw new Error("production command used direct archive fallback")
    if (!calls.includes("patch") || !calls.includes("remove:false")) throw new Error("production transition omitted PATCH or no-auto tab removal")
  `
  const child = Bun.spawn({ cmd: ["/usr/local/bin/bun", "--conditions=solid", "--preload", "../../../happydom.ts", "--eval", script], cwd: import.meta.dir })
  expect(await child.exited).toBe(0)
})
