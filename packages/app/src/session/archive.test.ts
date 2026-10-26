/**
 * @spec-handoff
 * @interface createSessionArchiveActions(deps): ArchiveActions; isArchivedSession(session): boolean
 * @behavior
 *   - PATCHes a captured server/session with archived:boolean, then canonically hydrates it.
 *   - Always releases pending after request, hydration, or presentation failure so retry is possible.
 *   - Exposes pending transitions to the reactive shell bridge.
 *   - Does not own retired archive-index reconnect scheduling.
 * @edge-cases
 *   - Epoch zero is archived; null and undefined are active; callers never send archive timestamps.
 * @see RFC 057 Addendum A.2
 */
import { expect, test } from "bun:test"
import {
  canOpenReferencedSession,
  createSessionArchiveActions,
  isArchivedSession,
  isSessionVisibleInPalette,
} from "./archive"

const session = (archived?: number | null) => ({ id: "a", location: { directory: "/a" }, time: { archived } })

test("archives once per captured server/session, hydrates, and releases pending", async () => {
  const calls: string[] = []
  let release!: () => void
  const wait = new Promise<void>((resolve) => (release = resolve))

  const actions = createSessionArchiveActions({
    update: async (x) => {
      calls.push(`update:${x.server}:${x.archived}`)
      await wait
    },
    sync: async (x) => calls.push(`sync:${x.server}`),
    toast: () => calls.push("toast"),
    onPendingChange: () => calls.push("pending"),
  })

  const first = actions.archiveSession({ server: "a:b", sessionID: "c" })
  expect(actions.isPending({ server: "a:b", sessionID: "c" })).toBe(true)
  expect(await actions.archiveSession({ server: "a:b", sessionID: "c" })).toBe(false)
  release()
  expect(await first).toBe(true)
  expect(calls).toEqual(["pending", "update:a:b:true", "sync:a:b", "pending"])
})

test("reports update failure without sync but treats refresh failure as committed", async () => {
  const update = new Error("update")
  const refresh = new Error("refresh")
  const notices: string[] = []
  expect(
    await createSessionArchiveActions({
      update: async () => {
        throw update
      },
      sync: async () => {},
      toast: (n) => notices.push(n.kind),
    }).archiveSession({ server: "s", sessionID: "x" }),
  ).toBe(false)
  expect(
    await createSessionArchiveActions({
      update: async () => {},
      sync: async () => {
        throw refresh
      },
      toast: (n) => notices.push(n.kind),
    }).setSessionArchive({ server: "s", sessionID: "x", archived: false }),
  ).toBe(true)
  expect(notices).toEqual(["update", "refresh"])
})

test("releases pending after a failed PATCH so the same target can retry", async () => {
  const pending: boolean[] = []
  let attempts = 0

  const actions = createSessionArchiveActions({
    update: async () => {
      attempts++

      if (attempts === 1) throw new Error("offline")
    },
    sync: async () => {},
    toast: () => {},
    onPendingChange: () => pending.push(actions.isPending({ server: "s", sessionID: "x" })),
  })

  expect(await actions.archiveSession({ server: "s", sessionID: "x" })).toBe(false)
  expect(actions.isPending({ server: "s", sessionID: "x" })).toBe(false)
  expect(await actions.archiveSession({ server: "s", sessionID: "x" })).toBe(true)
  expect(attempts).toBe(2)
  expect(pending).toEqual([true, false, true, false])
})

test("leaves archive index refresh scheduling to the existing Home and dialog query lifecycles", async () => {
  const module = await import("./archive")
  expect("createArchiveIndexRefresh" in module).toBe(false)
})

test("uses numeric archive presence, including epoch zero", () => {
  expect(isArchivedSession(session(0))).toBe(true)
  expect(isArchivedSession(session(null))).toBe(false)
  expect(isArchivedSession(session())).toBe(false)
  expect(isSessionVisibleInPalette(session(0))).toBe(false)
  expect(canOpenReferencedSession(session(0))).toBe(false)
})
