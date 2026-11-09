/**
 * @spec-handoff
 * @interface createSessionArchiveActions(deps): ArchiveActions; isArchivedSession(session): boolean
 * @interface ArchiveActions.archiveSessionQuiet(target: ArchiveTarget): Promise<ArchiveAttempt>
 * @interface type ArchiveAttempt = { status: "archived" } | { status: "pending" } | { status: "failed"; error: unknown }
 * @behavior
 *   - PATCHes a captured server/session with archived:boolean, then canonically hydrates it.
 *   - Always releases pending after request, hydration, or presentation failure so retry is possible.
 *   - Exposes pending transitions to the reactive shell bridge.
 *   - archiveSessionQuiet(target): Promise<ArchiveAttempt> archives like setSessionArchive but never toasts and reports
 *     { status: "archived" | "pending" | "failed" (with the same error object) } instead of a boolean.
 *   - Does not own retired archive-index reconnect scheduling.
 * @edge-cases
 *   - Epoch zero is archived; null and undefined are active; callers never send archive timestamps.
 *   - Quiet: pending target returns "pending" and sends nothing; a failed sync after a successful update is still "archived".
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

const target = { server: "s", sessionID: "x" }

test("archiveSessionQuiet archives once without toasting", async () => {
  const requests: unknown[] = []
  const toasts: unknown[] = []

  const actions = createSessionArchiveActions({
    update: async (x) => void requests.push(x),
    sync: async () => {},
    toast: (n) => toasts.push(n),
  })

  expect(await actions.archiveSessionQuiet(target)).toEqual({ status: "archived" })
  expect(requests).toEqual([{ ...target, archived: true }])
  expect(toasts).toEqual([])
})

test("archiveSessionQuiet returns pending without sending while the target is in flight, then releases", async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => (release = resolve))
  let updates = 0

  const actions = createSessionArchiveActions({
    update: async () => {
      updates++

      if (updates === 1) await wait
    },
    sync: async () => {},
    toast: () => {},
  })

  const first = actions.archiveSessionQuiet(target)
  expect(await actions.archiveSessionQuiet(target)).toEqual({ status: "pending" })
  expect(updates).toBe(1)
  release()
  expect(await first).toEqual({ status: "archived" })
  expect(await actions.archiveSessionQuiet(target)).toEqual({ status: "archived" })
  expect(updates).toBe(2)
})

test("archiveSessionQuiet shares the pending guard with setSessionArchive", async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => (release = resolve))
  let updates = 0

  const actions = createSessionArchiveActions({
    update: async () => {
      updates++

      await wait
    },
    sync: async () => {},
    toast: () => {},
  })

  const first = actions.setSessionArchive({ ...target, archived: false })
  expect(await actions.archiveSessionQuiet(target)).toEqual({ status: "pending" })
  expect(updates).toBe(1)
  release()
  expect(await first).toBe(true)
})

test("archiveSessionQuiet returns the same error object on update failure, without toast, and releases pending", async () => {
  const error = new Error("offline")
  const toasts: unknown[] = []
  let attempts = 0

  const actions = createSessionArchiveActions({
    update: async () => {
      attempts++

      if (attempts === 1) throw error
    },
    sync: async () => {
      throw new Error("sync must not run after a failed update")
    },
    toast: (n) => toasts.push(n),
  })

  const result = await actions.archiveSessionQuiet(target)

  expect(result.status).toBe("failed")
  expect(result.status === "failed" && result.error).toBe(error)
  expect(toasts).toEqual([])
  expect(actions.isPending(target)).toBe(false)
  expect(await actions.archiveSessionQuiet(target)).toEqual({ status: "archived" })
})

test("archiveSessionQuiet still reports archived when the refresh fails, without toast", async () => {
  const toasts: unknown[] = []
  let syncs = 0

  const actions = createSessionArchiveActions({
    update: async () => {},
    sync: async () => {
      syncs++

      throw new Error("refresh")
    },
    toast: (n) => toasts.push(n),
  })

  expect(await actions.archiveSessionQuiet(target)).toEqual({ status: "archived" })
  expect(syncs).toBe(1)
  expect(toasts).toEqual([])
  expect(actions.isPending(target)).toBe(false)
})

test("archiveSessionQuiet keeps error text only in the error field and out of toasts", async () => {
  const sentinel = "SECRET-7f3a91c2"
  const error = new Error(`request failed: ${sentinel}`)
  const toasts: unknown[] = []

  const actions = createSessionArchiveActions({
    update: async () => {
      throw error
    },
    sync: async () => {},
    toast: (n) => toasts.push(n),
  })

  const result = await actions.archiveSessionQuiet(target)

  expect(result).toMatchObject({ status: "failed", error })
  expect(JSON.stringify({ ...result, error: undefined })).not.toContain(sentinel)
  expect(JSON.stringify(toasts)).not.toContain(sentinel)
  expect(toasts).toEqual([])
})
