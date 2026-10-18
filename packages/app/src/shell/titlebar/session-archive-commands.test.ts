/**
 * @spec-handoff
 * @interface useTitlebarArchiveCommands(): void
 * @behavior
 *   - Registers the production archive command through the shared timeline transition.
 *   - PATCHes and hydrates the exact route server, removes its tab without automatic navigation, then lands once.
 *   - Suppresses caller-owned finalization when its Solid owner is disposed or its captured server context is replaced while PATCH is pending.
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
    const ctx = { data: { session: { get: () => session, list: () => [session, { id: "b", location: { directory: "/d" }, time: {} }] } } }
    mock.module("@/shell/commands/command", () => ({ useCommand: () => ({ register: (_key, next) => { options = next } }) }))
    mock.module("@/shell/state/layout", () => ({ useLayout: () => ({ route: () => ({ type: "session", server: "s", sessionId: "a" }), home: { selection: () => ({}) } }) }))
    mock.module("@/runtime/server/runtime", () => ({ useGlobal: () => ({ servers: { list: () => ["s"] }, serverCtx: () => ctx, sessionArchive: { archiveSession: async () => { calls.push("direct"); return true }, setSessionArchive: async () => { calls.push("patch"); return true }, isPending: () => false } }) }))
    mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key) => key }) }))
    mock.module("@/shell/tabs/tabs", () => ({ useTabs: () => ({ store: [], removeSessions: (_detail, options) => calls.push("remove:" + options.navigate), select: () => {}, newDraft: async () => calls.push("draft") }) }))
    mock.module("@/runtime/server/registry", () => ({ ServerConnection: { key: (value) => value } }))
    mock.module("./dialog-archived-sessions", () => ({ showArchivedSessionsDialog: () => {} }))
    mock.module("@opencode/ui/context/dialog", () => ({ useDialog: () => ({}) }))
    const { useTitlebarArchiveCommands } = await import("./session-archive-commands.tsx")
    let dispose
    createRoot((next) => { dispose = next; useTitlebarArchiveCommands() })
    await options().find((option) => option.id === "session.archive").onSelect()
    dispose()
    if (calls.includes("direct")) throw new Error("production command used direct archive fallback")
    if (!calls.includes("patch") || !calls.includes("remove:false")) throw new Error("production transition omitted PATCH or no-auto tab removal")
  `
  const child = Bun.spawn({ cmd: ["/usr/local/bin/bun", "--conditions=solid", "--preload", "../../../happydom.ts", "--eval", script], cwd: import.meta.dir })
  expect(await child.exited).toBe(0)
})

test("does no caller-owned work after the shell owner is disposed during a held archive PATCH", async () => {
  const script = String.raw`
    import { createRoot } from "solid-js"
    import { mock } from "bun:test"
    const calls = []
    const gate = Promise.withResolvers()
    let options, dispose
    const session = { id: "a", location: { directory: "/d" }, time: {} }
    const ctx = { data: { session: { get: () => session, list: () => [session, { id: "b", location: { directory: "/d" }, time: {} }] } } }
    mock.module("@/shell/commands/command", () => ({ useCommand: () => ({ register: (_key, next) => { options = next } }) }))
    mock.module("@/shell/state/layout", () => ({ useLayout: () => ({ route: () => ({ type: "session", server: "route-server", sessionId: "a" }), home: { selection: () => ({}) } }) }))
    mock.module("@/runtime/server/runtime", () => ({ useGlobal: () => ({ servers: { list: () => ["route-server"] }, serverCtx: () => ctx, sessionArchive: { setSessionArchive: async () => { calls.push("patch"); await gate.promise; return true }, isPending: () => false } }) }))
    mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key) => key }) }))
    mock.module("@/shell/tabs/tabs", () => ({ useTabs: () => ({ store: [], removeSessions: () => calls.push("remove"), select: () => calls.push("select"), newDraft: async () => calls.push("draft") }) }))
    mock.module("@/runtime/server/registry", () => ({ ServerConnection: { key: (value) => value } }))
    mock.module("./dialog-archived-sessions", () => ({ showArchivedSessionsDialog: () => {} }))
    mock.module("@opencode/ui/context/dialog", () => ({ useDialog: () => ({}) }))
    const { useTitlebarArchiveCommands } = await import("./session-archive-commands.tsx")
    createRoot((next) => { dispose = next; useTitlebarArchiveCommands() })
    const pending = options().find((option) => option.id === "session.archive").onSelect()
    while (!calls.includes("patch")) await Bun.sleep(1)
    dispose()
    gate.resolve()
    await pending
    if (calls.some((call) => call !== "patch")) throw new Error("disposed shell owner finalized archive work: " + calls.join(","))
  `
  const child = Bun.spawn({ cmd: ["/usr/local/bin/bun", "--conditions=solid", "--preload", "../../../happydom.ts", "--eval", script], cwd: import.meta.dir })
  expect(await child.exited).toBe(0)
})

test("does not start an archive PATCH from a callback invoked after its shell owner is disposed", async () => {
  const script = String.raw`
    import { createRoot } from "solid-js"
    import { mock } from "bun:test"
    const calls = []
    let options, dispose
    const session = { id: "a", location: { directory: "/d" }, time: {} }
    const ctx = { data: { session: { get: () => session, list: () => [session] } } }
    mock.module("@/shell/commands/command", () => ({ useCommand: () => ({ register: (_key, next) => { options = next } }) }))
    mock.module("@/shell/state/layout", () => ({ useLayout: () => ({ route: () => ({ type: "session", server: "route-server", sessionId: "a" }), home: { selection: () => ({}) } }) }))
    mock.module("@/runtime/server/runtime", () => ({ useGlobal: () => ({ servers: { list: () => ["route-server"] }, serverCtx: () => ctx, sessionArchive: { setSessionArchive: async () => { calls.push("patch"); return true }, isPending: () => false } }) }))
    mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key) => key }) }))
    mock.module("@/shell/tabs/tabs", () => ({ useTabs: () => ({ store: [], removeSessions: () => calls.push("remove"), select: () => calls.push("select"), newDraft: async () => calls.push("draft") }) }))
    mock.module("@/runtime/server/registry", () => ({ ServerConnection: { key: (value) => value } }))
    mock.module("./dialog-archived-sessions", () => ({ showArchivedSessionsDialog: () => {} }))
    mock.module("@opencode/ui/context/dialog", () => ({ useDialog: () => ({}) }))
    const { useTitlebarArchiveCommands } = await import("./session-archive-commands.tsx")
    createRoot((next) => { dispose = next; useTitlebarArchiveCommands() })
    dispose()
    await options().find((option) => option.id === "session.archive").onSelect()
    if (calls.length) throw new Error("disposed command callback started archive work: " + calls.join(","))
  `
  const child = Bun.spawn({ cmd: ["/usr/local/bin/bun", "--conditions=solid", "--preload", "../../../happydom.ts", "--eval", script], cwd: import.meta.dir })
  expect(await child.exited).toBe(0)
})

test("does no caller-owned work after the captured route-server context is replaced during a held archive PATCH", async () => {
  const script = String.raw`
    import { createRoot } from "solid-js"
    import { mock } from "bun:test"
    const calls = []
    const gate = Promise.withResolvers()
    let options
    const session = { id: "a", location: { directory: "/d" }, time: {} }
    let ctx = { data: { session: { get: () => session, list: () => [session, { id: "b", location: { directory: "/d" }, time: {} }] } } }
    mock.module("@/shell/commands/command", () => ({ useCommand: () => ({ register: (_key, next) => { options = next } }) }))
    mock.module("@/shell/state/layout", () => ({ useLayout: () => ({ route: () => ({ type: "session", server: "route-server", sessionId: "a" }), home: { selection: () => ({}) } }) }))
    mock.module("@/runtime/server/runtime", () => ({ useGlobal: () => ({ servers: { list: () => ["route-server"] }, serverCtx: () => ctx, sessionArchive: { setSessionArchive: async () => { calls.push("patch"); await gate.promise; return true }, isPending: () => false } }) }))
    mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key) => key }) }))
    mock.module("@/shell/tabs/tabs", () => ({ useTabs: () => ({ store: [], removeSessions: () => calls.push("remove"), select: () => calls.push("select"), newDraft: async () => calls.push("draft") }) }))
    mock.module("@/runtime/server/registry", () => ({ ServerConnection: { key: (value) => value } }))
    mock.module("./dialog-archived-sessions", () => ({ showArchivedSessionsDialog: () => {} }))
    mock.module("@opencode/ui/context/dialog", () => ({ useDialog: () => ({}) }))
    const { useTitlebarArchiveCommands } = await import("./session-archive-commands.tsx")
    createRoot(() => useTitlebarArchiveCommands())
    const pending = options().find((option) => option.id === "session.archive").onSelect()
    while (!calls.includes("patch")) await Bun.sleep(1)
    ctx = { data: { session: { get: () => undefined, list: () => [] } } }
    gate.resolve()
    await pending
    if (calls.some((call) => call !== "patch")) throw new Error("replaced server context finalized archive work: " + calls.join(","))
  `
  const child = Bun.spawn({ cmd: ["/usr/local/bin/bun", "--conditions=solid", "--preload", "../../../happydom.ts", "--eval", script], cwd: import.meta.dir })
  expect(await child.exited).toBe(0)
})
