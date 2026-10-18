/**
 * @spec-handoff
 * @interface createArchiveLandingEffects(deps); archiveLabelKey(session); snapshotArchiveNeighbour(input); runTimelineArchive(input, deps): Promise<boolean>
 * @behavior
 *   - Archives a root only after snapshotting its next/previous/draft landing.
 *   - Removes the target tab with automatic navigation suppressed, then issues one chosen landing.
 * @see RFC 057 Addendum A.6
 */
import { expect, test } from "bun:test"
import { archiveLabelKey, isArchiveRouteCurrent, runTimelineArchive, snapshotArchiveNeighbour, type ArchiveLanding } from "./archive-model"
const root = (id: string, archived?: number) => ({ id, location: { directory: "/d" }, time: { archived } })
test("uses zero-safe labels and ordered neighbouring root snapshot", () => {
  expect(archiveLabelKey(root("x", 0))).toBe("common.unarchive"); expect(archiveLabelKey(root("x"))).toBe("common.archive")
  expect(snapshotArchiveNeighbour({ target: { server: "s", sessionID: "a" }, directory: "/d", sessions: [root("a"), root("b"), { ...root("c"), parentID: "a" }] })).toEqual({ type: "session", server: "s", sessionID: "b" })
  expect(isArchiveRouteCurrent({ server: "s", sessionID: "x" }, { server: "other", sessionID: "x" })).toBe(false)
})
test("uses the pre-PATCH neighbour snapshot and suppresses automatic tab navigation", async () => {
  const calls: string[] = []; let current = { server: "s", sessionID: "a" }
  const sessions = [root("a"), root("b")]
  const result = await runTimelineArchive({ target: current, session: root("a"), sessions }, { setArchive: async () => { calls.push("patch"); sessions.splice(1); return true }, now: () => 0, isActive: () => true, currentRoute: () => current, navigate: async (landing: ArchiveLanding) => { calls.push(`navigate:${landing.type === "session" ? landing.sessionID : "draft"}`); current = { server: "s", sessionID: "b" } }, removeTabs: (detail: unknown) => calls.push(`remove:${JSON.stringify(detail)}`), toast: () => calls.push("toast") } as never)
  expect(result).toBe(true)
  expect(calls).toEqual(["patch", 'remove:{"server":"s","directory":"/d","sessionIDs":["a"],"navigate":false}', "navigate:b"])
})
test("completes the already-admitted landing after no-auto removal disposes the target owner", async () => {
  let active = true
  const calls: string[] = []
  await runTimelineArchive(
    { target: { server: "s", sessionID: "a" }, session: root("a"), sessions: [root("a"), root("b")] },
    {
      setArchive: async () => true,
      now: () => 0,
      isActive: () => active,
      currentRoute: () => ({ server: "s", sessionID: "a" }),
      removeTabs: () => { active = false; calls.push("remove") },
      navigate: async () => calls.push("navigate"),
      toast: () => calls.push("toast"),
    },
  )
  expect(calls).toEqual(["remove", "navigate"])
})
test("uses the exact route-server identity when deciding whether archive may navigate", async () => {
  const patches: unknown[] = []
  const calls: string[] = []
  await runTimelineArchive(
    { target: { server: "route-server", sessionID: "a" }, session: root("a"), sessions: [root("a"), root("b")] },
    {
      setArchive: async (input: unknown) => { patches.push(input); return true },
      now: () => 7,
      isActive: () => true,
      currentRoute: () => ({ server: "selected-server", sessionID: "a" }),
      removeTabs: () => calls.push("remove"),
      navigate: async () => calls.push("navigate"),
      toast: () => {},
    } as never,
  )
  expect(patches).toEqual([{ server: "route-server", sessionID: "a", archive: 7 }])
  expect(calls).toEqual(["remove"])
})
test("removes through the real tabs adapter with automatic navigation explicitly disabled", async () => {
  const module = await requireArchiveModel()
  expect(module.createArchiveLandingEffects).toBeTypeOf("function")
  const calls: unknown[][] = []
  const effects = module.createArchiveLandingEffects({
    removeSessions: (...args: unknown[]) => calls.push(args),
    navigate: () => {},
  } as never)
  effects.removeTabs({ server: "s", directory: "/d", sessionIDs: ["a"], navigate: false })
  expect(calls).toEqual([[{ server: "s", directory: "/d", sessionIDs: ["a"] }, { navigate: false }]])
})

async function requireArchiveModel() {
  return (await import("./archive-model")) as unknown as {
    createArchiveLandingEffects: (deps: Readonly<{ removeSessions: (...args: unknown[]) => void; navigate: (landing: ArchiveLanding) => void }>) => Readonly<{ removeTabs: (detail: { server: string; directory: string; sessionIDs: readonly string[]; navigate: false }) => void }>
  }
}
