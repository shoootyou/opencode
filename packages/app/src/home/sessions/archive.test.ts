/**
 * @spec-handoff
 * @interface archiveHomeSession(input, deps): Promise<boolean>
 * @behavior
 *   - Cleans Home only after a committed root-session archive while active.
 *   - Removes before issuing the captured-server tab notification.
 * @edge-cases
 *   - Pending, failure, child, archived, and disposed owners have no UI effects.
 * @see RFC 057 Addendum A.3
 */
import { expect, test } from "bun:test"
import { archiveHomeSession } from "./archive"

test("cleans an active root only after shared archive success and in order", async () => {
  const calls: string[] = []

  const result = await archiveHomeSession(
    { server: "remote", session: { id: "ses_1", location: { directory: "/workspace" }, time: {} } },
    {
      archiveSession: async () => true,
      remove: () => calls.push("remove"),
      notifyTabsRemoved: (x) => calls.push(`${x.server}:${x.sessionIDs[0]}`),
      isActive: () => true,
    },
  )

  expect(result).toBe(true)
  expect(calls).toEqual(["remove", "remote:ses_1"])
})

test("has no Home effects for false, child, archived, or disposed success", async () => {
  for (const session of [
    { id: "x", parentID: "p", location: { directory: "/x" }, time: {} },
    { id: "x", location: { directory: "/x" }, time: { archived: 0 } },
    { id: "x", location: { directory: "/x" }, time: {} },
  ]) {
    const calls: string[] = []
    await archiveHomeSession(
      { server: "s", session },
      {
        archiveSession: async () => false,
        remove: () => calls.push("remove"),
        notifyTabsRemoved: () => calls.push("notify"),
        isActive: () => false,
      },
    )
    expect(calls).toEqual([])
  }
})

test("does not evict or notify when the focused Home context changes while archive is pending", async () => {
  const calls: string[] = []
  const gate = Promise.withResolvers<boolean>()
  const capturedContext = {}
  let focusedContext = capturedContext

  const pending = archiveHomeSession(
    { server: "s", session: { id: "x", location: { directory: "/x" }, time: {} } },
    {
      archiveSession: async () => gate.promise,
      remove: () => calls.push("evict"),
      notifyTabsRemoved: () => calls.push("notify"),
      isActive: () => focusedContext === capturedContext,
    },
  )

  focusedContext = {}
  gate.resolve(true)
  expect(await pending).toBe(true)
  expect(calls).toEqual([])
})
