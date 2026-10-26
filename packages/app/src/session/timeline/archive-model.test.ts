/**
 * @spec-handoff
 * @interface createArchiveLandingEffects(deps); archiveLabelKey(session); snapshotArchiveNeighbour(input); runTimelineArchive(input, deps): Promise<boolean>
 * @behavior
 *   - Archives a root only after snapshotting its next/previous/draft landing.
 *   - Removes the target tab with automatic navigation suppressed, then issues one chosen landing.
 * @see RFC 057 Addendum A.6
 */
import { expect, test } from "bun:test"
import {
  archiveLabelKey,
  isArchiveRouteCurrent,
  runTimelineArchive,
  snapshotArchiveNeighbour,
  type ArchiveLanding,
} from "./archive-model"

const root = (id: string, archived?: number) => ({ id, location: { directory: "/d" }, time: { archived } })

test("uses zero-safe labels and ordered neighbouring root snapshot", () => {
  expect(archiveLabelKey(root("x", 0))).toBe("common.unarchive")
  expect(archiveLabelKey(root("x"))).toBe("common.archive")
  expect(
    snapshotArchiveNeighbour({
      target: { server: "s", sessionID: "a" },
      directory: "/d",
      sessions: [root("a"), root("b"), { ...root("c"), parentID: "a" }],
    }),
  ).toEqual({ type: "session", server: "s", sessionID: "b" })
  expect(isArchiveRouteCurrent({ server: "s", sessionID: "x" }, { server: "other", sessionID: "x" })).toBe(false)
})

test("uses the pre-PATCH neighbour snapshot and suppresses automatic tab navigation", async () => {
  const calls: string[] = []
  let current = { server: "s", sessionID: "a" }
  const sessions = [root("a"), root("b")]

  // SAFETY: This fixture supplies only the archive-transition dependencies exercised by this focused ordering test.
  const result = await runTimelineArchive({ target: current, session: root("a"), sessions }, {
    setArchive: async () => {
      calls.push("patch")
      sessions.splice(1)

      return true
    },
    isActive: () => true,
    currentRoute: () => current,
    navigate: async (landing: ArchiveLanding) => {
      calls.push(`navigate:${landing.type === "session" ? landing.sessionID : "draft"}`)
      current = { server: "s", sessionID: "b" }
    },
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The adapter payload is intentionally captured opaquely for its exact serialized assertion.
    removeTabs: (detail: unknown) => calls.push(`remove:${JSON.stringify(detail)}`),
    toast: () => calls.push("toast"),
  } as never)

  expect(result).toBe(true)
  expect(calls).toEqual([
    "patch",
    'remove:{"server":"s","directory":"/d","sessionIDs":["a"],"navigate":false}',
    "navigate:b",
  ])
})

test("completes the already-admitted landing after no-auto removal disposes the target owner", async () => {
  let active = true
  const calls: string[] = []
  // SAFETY: This fixture provides only the transition dependencies needed to assert the captured route server.
  await runTimelineArchive(
    { target: { server: "s", sessionID: "a" }, session: root("a"), sessions: [root("a"), root("b")] },
    {
      setArchive: async () => true,
      isActive: () => active,
      currentRoute: () => ({ server: "s", sessionID: "a" }),
      removeTabs: () => {
        active = false
        calls.push("remove")
      },
      navigate: async () => calls.push("navigate"),
      toast: () => calls.push("toast"),
    },
  )
  expect(calls).toEqual(["remove", "navigate"])
})

test("uses the exact route-server identity when deciding whether archive may navigate", async () => {
  const patches: unknown[] = []
  const calls: string[] = []

  // SAFETY: This fixture provides only the transition dependencies needed to assert the captured route server.
  await runTimelineArchive(
    { target: { server: "route-server", sessionID: "a" }, session: root("a"), sessions: [root("a"), root("b")] },
    {
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The request is intentionally captured opaquely for its exact assertion.
      setArchive: async (input: unknown) => {
        patches.push(input)

        return true
      },
      isActive: () => true,
      currentRoute: () => ({ server: "selected-server", sessionID: "a" }),
      removeTabs: () => calls.push("remove"),
      navigate: async () => calls.push("navigate"),
      toast: () => {},
    } as never,
  )
  expect(patches).toEqual([{ server: "route-server", sessionID: "a", archived: true }])
  expect(calls).toEqual(["remove"])
})

test("removes through the real tabs adapter with automatic navigation explicitly disabled", async () => {
  const module = await requireArchiveModel()
  expect(module.createArchiveLandingEffects).toBeTypeOf("function")
  const calls: unknown[][] = []

  // SAFETY: This adapter fixture supplies only the tab-removal and navigation dependencies asserted below.
  const effects = module.createArchiveLandingEffects({
    removeSessions: (...args: unknown[]) => calls.push(args),
    navigate: () => {},
  } as never)

  effects.removeTabs({ server: "s", directory: "/d", sessionIDs: ["a"], navigate: false })
  expect(calls).toEqual([[{ server: "s", directory: "/d", sessionIDs: ["a"] }, { navigate: false }]])
})

test("issues no-auto tab removal in the same completion turn before an asynchronous landing", async () => {
  const calls: string[] = []
  const landing = Promise.withResolvers<void>()

  const pending = runTimelineArchive(
    { target: { server: "s", sessionID: "a" }, session: root("a"), sessions: [root("a"), root("b")] },
    {
      setArchive: async () => true,
      isActive: () => true,
      currentRoute: () => ({ server: "s", sessionID: "a" }),
      removeTabs: () => calls.push("remove"),
      navigate: async () => {
        calls.push("navigate")
        await landing.promise
      },
      toast() {},
    },
  )

  await Promise.resolve()
  expect(calls).toEqual(["remove", "navigate"])
  landing.resolve()
  await pending
})

async function requireArchiveModel() {
  const module: unknown = await import("./archive-model")

  // SAFETY: This focused adapter test accesses only the declared landing-effects factory contract.
  return module as {
    createArchiveLandingEffects: (
      deps: Readonly<{ removeSessions: (...args: unknown[]) => void; navigate: (landing: ArchiveLanding) => void }>,
    ) => Readonly<{
      removeTabs: (detail: {
        server: string
        directory: string
        sessionIDs: readonly string[]
        navigate: false
      }) => void
    }>
  }
}
