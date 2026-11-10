/**
 * @spec-handoff
 * @interface runBulk(ids, op, options?: { isBusy?, proceed?, onProgress? }): Promise<BulkResult>
 * @interface rangeSelect(order, anchor, target, selectable): string[]
 * @interface isSelectable(session, busy): boolean
 * @interface isArchivedSelectable(session: ArchiveSession, busy: boolean): boolean
 * @interface openTabCount(ids: readonly string[], tree: (id: string) => readonly string[], hasTab: (id: string) => boolean): number
 * @interface bulkSummary(kind: "archive" | "delete" | "unarchive", result, language): { variant: "success" | "error"; title: string }
 * @interface skipId(connected: boolean, busy: boolean): boolean; offlineResult(ids: readonly string[]): BulkResult
 * @interface nextSelection(state, input): { ids: string[]; anchor?: string }; pruneSelection(ids, valid): string[]
 * @behavior
 *   - runBulk is sequential (concurrency 1), never throws, keeps input order, and never stores error text.
 *   - SessionNotFoundError -> missing; rate-kind SessionArchiveLimitError with retryAfterMillis -> wait min(ms, 60_000), retry once; anything else -> failed.
 *   - isBusy(id) at execution time -> failed without calling op; proceed() false -> that id and the rest failed without calling op.
 *   - onProgress(done, total) fires once per processed id (a retry does not add a call).
 *   - rangeSelect is inclusive in `order` (either direction), filtered by `selectable`; no usable anchor -> [target] when target is selectable, else [].
 *   - isSelectable = !busy && !parentID && not archived (epoch zero counts as archived).
 *   - isArchivedSelectable = !busy && !parentID && archived (epoch zero counts as archived); isSelectable is unchanged.
 *   - openTabCount = ids.filter(id => tree(id).some(hasTab)).length; tree(id) is expected to include id itself.
 *   - bulkSummary("unarchive") uses "Unarchived ..." copy (home.sessions.bulk.unarchive.*) with the same done/partial rules.
 *   - bulkSummary: ok+missing only -> success + plural title; any failed -> error + "<Verb> {{done}} of {{total}}, {{failed}} failed".
 *   - skipId(connected, busy) = !connected || busy: the per-id skip used as runBulk's isBusy; a skipped id is failed without op.
 *   - offlineResult(ids) = the all-failed result of a batch that never started: ok [], missing [], failed = fresh copy of ids in order.
 * @edge-cases
 *   - 429 with kind "retention" or without retryAfterMillis -> failed, no retry; a second 429 -> failed.
 *   - A synchronous throw or a non-Error rejection from op is a failure, not an exception.
 *   - Toggling a non-selectable id is a no-op; pruneSelection keeps order.
 * @see ./archive.ts
 * @testability No production seam: waits are real 5-20 ms with generous lower bounds; the 60 s cap is observed through a setTimeout spy.
 */
import { describe, expect, spyOn, test } from "bun:test"
import { Data } from "effect"
import en from "@/runtime/i18n/en"
import type { useLanguage } from "@/runtime/i18n/language"
import {
  bulkSummary,
  isArchivedSelectable,
  isSelectable,
  nextSelection,
  offlineResult,
  openTabCount,
  pruneSelection,
  rangeSelect,
  runBulk,
  skipId,
  type BulkResult,
} from "./bulk"

type Language = Pick<ReturnType<typeof useLanguage>, "plural" | "t">

const dictionary: Record<string, string> = en

const fill = (text: string, params: Record<string, string | number | boolean> = {}) =>
  text.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => String(params[key] ?? ""))

// Renders from the real English dictionary so the test reads the shipped strings.
const language: Language = {
  t: (key, params) => fill(dictionary[key] ?? `MISSING:${key}`, params),
  plural: (key, count, params) =>
    fill(dictionary[`${key}.${count === 1 ? "one" : "other"}`] ?? `MISSING:${key}`, { ...params, count }),
}

// Tagged error classes carry the `_tag` the client guards read, like the errors the client throws.
class SessionNotFoundError extends Data.TaggedError("SessionNotFoundError")<{
  readonly sessionID: string
  readonly message: string
}> {}

class SessionArchiveLimitError extends Data.TaggedError("SessionArchiveLimitError")<{
  readonly sessionID: string
  readonly kind: "rate" | "retention"
  readonly retryAfterMillis?: number
  readonly message: string
}> {}

class ConflictError extends Data.TaggedError("ConflictError")<{ readonly message: string }> {}

const notFound = (sessionID: string) => new SessionNotFoundError({ sessionID, message: "Session not found" })

const limit = (sessionID: string, input: { kind: "rate" | "retention"; retryAfterMillis?: number; message?: string }) =>
  new SessionArchiveLimitError({ sessionID, ...input, message: input.message ?? "Archive limit" })

const conflict = () => new ConflictError({ message: "Conflict" })

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))

  return { promise, resolve }
}

const tick = () => Bun.sleep(10)

const result = (input: Partial<BulkResult>): BulkResult => ({ ok: [], missing: [], failed: [], ...input })

describe("runBulk ordering and concurrency", () => {
  test("runs one id at a time, starting the next only after the previous settles", async () => {
    const ids = ["ses_a", "ses_b", "ses_c"]
    const gates = new Map(ids.map((id) => [id, deferred()]))
    const started: string[] = []
    let active = 0
    let maxActive = 0

    const op = async (id: string) => {
      started.push(id)
      active++
      maxActive = Math.max(maxActive, active)
      await gates.get(id)?.promise
      active--
    }

    const running = runBulk(ids, op)
    await tick()
    expect(started).toEqual(["ses_a"])

    gates.get("ses_a")?.resolve()
    await tick()
    expect(started).toEqual(["ses_a", "ses_b"])

    gates.get("ses_b")?.resolve()
    gates.get("ses_c")?.resolve()
    const final = await running

    expect(started).toEqual(ids)
    expect(maxActive).toBe(1)
    expect(final).toEqual(result({ ok: ids }))
  })

  test("keeps input order inside ok, missing and failed", async () => {
    const outcomes = new Map<string, "ok" | "missing" | "failed">([
      ["ses_1", "failed"],
      ["ses_2", "ok"],
      ["ses_3", "missing"],
      ["ses_4", "failed"],
      ["ses_5", "ok"],
      ["ses_6", "missing"],
    ])

    const final = await runBulk([...outcomes.keys()], async (id) => {
      if (outcomes.get(id) === "missing") throw notFound(id)

      if (outcomes.get(id) === "failed") throw new Error("boom")
    })

    expect(final).toEqual({
      ok: ["ses_2", "ses_5"],
      missing: ["ses_3", "ses_6"],
      failed: ["ses_1", "ses_4"],
    })
  })

  test("returns an empty result without calling op or onProgress for no ids", async () => {
    const calls: string[] = []

    const final = await runBulk(
      [],
      async (id) => {
        calls.push(id)
      },
      { onProgress: () => calls.push("progress") },
    )

    expect(final).toEqual(result({}))
    expect(calls).toEqual([])
  })
})

describe("runBulk classification", () => {
  test("counts a not-found session as missing and keeps going", async () => {
    const final = await runBulk(["ses_a", "ses_gone", "ses_z"], async (id) => {
      if (id === "ses_gone") throw notFound(id)
    })

    expect(final).toEqual(result({ ok: ["ses_a", "ses_z"], missing: ["ses_gone"] }))
  })

  test("counts a conflict as failed with a single attempt", async () => {
    const calls: string[] = []

    const final = await runBulk(["ses_c", "ses_z"], async (id) => {
      calls.push(id)

      if (id === "ses_c") throw conflict()
    })

    expect(calls).toEqual(["ses_c", "ses_z"])
    expect(final).toEqual(result({ ok: ["ses_z"], failed: ["ses_c"] }))
  })

  test("counts a plain server error as failed with a single attempt", async () => {
    const calls: string[] = []

    const final = await runBulk(["ses_x", "ses_z"], async (id) => {
      calls.push(id)

      if (id === "ses_x") throw new Error("HTTP 500")
    })

    expect(calls).toEqual(["ses_x", "ses_z"])
    expect(final).toEqual(result({ ok: ["ses_z"], failed: ["ses_x"] }))
  })

  test("turns a synchronous throw and a non-Error rejection into failures instead of throwing", async () => {
    const final = await runBulk(["ses_sync", "ses_str", "ses_z"], (id) => {
      if (id === "ses_sync") throw new Error("sync boom")

      if (id === "ses_str") return Promise.reject("plain string")

      return Promise.resolve()
    })

    expect(final).toEqual(result({ ok: ["ses_z"], failed: ["ses_sync", "ses_str"] }))
  })

  test("never puts error text in the result", async () => {
    const secret = "LEAK_SENTINEL_5d41402a"

    const final = await runBulk(["ses_a", "ses_b", "ses_c", "ses_z"], async (id) => {
      if (id === "ses_a") throw new Error(secret)

      if (id === "ses_b") throw limit(id, { kind: "retention", message: secret })

      if (id === "ses_c") throw notFound(id)
    })

    expect(final.failed).toEqual(["ses_a", "ses_b"])
    expect(final.missing).toEqual(["ses_c"])
    expect(final.ok).toEqual(["ses_z"])
    expect(JSON.stringify(final)).not.toContain(secret)
  })
})

describe("runBulk rate limit retry", () => {
  test("waits retryAfterMillis, retries that id once and counts it ok", async () => {
    const stamps: number[] = []

    const final = await runBulk(["ses_r", "ses_z"], async (id) => {
      if (id !== "ses_r") return
      stamps.push(performance.now())

      if (stamps.length === 1) throw limit(id, { kind: "rate", retryAfterMillis: 20 })
    })

    expect(stamps).toHaveLength(2)
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(15)
    expect(final).toEqual(result({ ok: ["ses_r", "ses_z"] }))
  })

  test("fails an id whose retry is rate limited again, after exactly two calls", async () => {
    const calls: string[] = []

    const final = await runBulk(["ses_r", "ses_z"], async (id) => {
      calls.push(id)

      if (id === "ses_r") throw limit(id, { kind: "rate", retryAfterMillis: 5 })
    })

    expect(calls).toEqual(["ses_r", "ses_r", "ses_z"])
    expect(final).toEqual(result({ ok: ["ses_z"], failed: ["ses_r"] }))
  })

  test("fails a retention limit without waiting or retrying", async () => {
    const calls: string[] = []

    const final = await runBulk(["ses_r", "ses_z"], async (id) => {
      calls.push(id)

      if (id === "ses_r") throw limit(id, { kind: "retention", retryAfterMillis: 5 })
    })

    expect(calls).toEqual(["ses_r", "ses_z"])
    expect(final).toEqual(result({ ok: ["ses_z"], failed: ["ses_r"] }))
  })

  test("fails a rate limit that carries no retryAfterMillis without retrying", async () => {
    const calls: string[] = []

    const final = await runBulk(["ses_r", "ses_z"], async (id) => {
      calls.push(id)

      if (id === "ses_r") throw limit(id, { kind: "rate" })
    })

    expect(calls).toEqual(["ses_r", "ses_z"])
    expect(final).toEqual(result({ ok: ["ses_z"], failed: ["ses_r"] }))
  })

  test("caps the wait at 60 seconds", async () => {
    const realSetTimeout = globalThis.setTimeout
    const delays: number[] = []

    // Long waits run immediately so the test stays fast; shorter timers keep their delay.
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(
      Object.assign((handler: () => void, ms?: number) => {
        if (ms !== undefined && ms >= 1000) {
          delays.push(ms)

          return realSetTimeout(handler, 0)
        }

        return realSetTimeout(handler, ms)
      }, realSetTimeout),
    )

    let attempts = 0

    try {
      const final = await runBulk(["ses_r"], async (id) => {
        attempts++

        if (attempts === 1) throw limit(id, { kind: "rate", retryAfterMillis: 3_600_000 })
      })

      expect(delays).toEqual([60_000])
      expect(final).toEqual(result({ ok: ["ses_r"] }))
    } finally {
      spy.mockRestore()
    }
  })
})

describe("runBulk guards", () => {
  test("fails a busy id without calling op and still processes the others", async () => {
    const calls: string[] = []

    const final = await runBulk(
      ["ses_a", "ses_busy", "ses_z"],
      async (id) => {
        calls.push(id)
      },
      { isBusy: (id) => id === "ses_busy" },
    )

    expect(calls).toEqual(["ses_a", "ses_z"])
    expect(final).toEqual(result({ ok: ["ses_a", "ses_z"], failed: ["ses_busy"] }))
  })

  test("checks busy at execution time, not up front", async () => {
    const busy = new Set<string>()
    const calls: string[] = []

    const final = await runBulk(
      ["ses_a", "ses_b", "ses_c"],
      async (id) => {
        calls.push(id)

        if (id === "ses_a") busy.add("ses_b")
      },
      { isBusy: (id) => busy.has(id) },
    )

    expect(calls).toEqual(["ses_a", "ses_c"])
    expect(final).toEqual(result({ ok: ["ses_a", "ses_c"], failed: ["ses_b"] }))
  })

  test("fails the current and remaining ids without calling op once proceed turns false", async () => {
    const calls: string[] = []
    let allowed = true

    const final = await runBulk(
      ["ses_a", "ses_b", "ses_c"],
      async (id) => {
        calls.push(id)
        allowed = false
      },
      { proceed: () => allowed },
    )

    expect(calls).toEqual(["ses_a"])
    expect(final).toEqual(result({ ok: ["ses_a"], failed: ["ses_b", "ses_c"] }))
  })

  test("fails every id when proceed is false from the start", async () => {
    const calls: string[] = []

    const final = await runBulk(
      ["ses_a", "ses_b"],
      async (id) => {
        calls.push(id)
      },
      { proceed: () => false },
    )

    expect(calls).toEqual([])
    expect(final).toEqual(result({ failed: ["ses_a", "ses_b"] }))
  })
})

describe("runBulk progress", () => {
  test("reports done and total after each id whatever its outcome", async () => {
    const progress: Array<[number, number]> = []

    await runBulk(
      ["ses_ok", "ses_gone", "ses_bad", "ses_busy"],
      async (id) => {
        if (id === "ses_gone") throw notFound(id)

        if (id === "ses_bad") throw new Error("boom")
      },
      {
        isBusy: (id) => id === "ses_busy",
        onProgress: (done, total) => progress.push([done, total]),
      },
    )

    expect(progress).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ])
  })

  test("counts a retried id once", async () => {
    const progress: Array<[number, number]> = []
    let attempts = 0

    await runBulk(
      ["ses_r", "ses_z"],
      async (id) => {
        if (id !== "ses_r") return
        attempts++

        if (attempts === 1) throw limit(id, { kind: "rate", retryAfterMillis: 5 })
      },
      { onProgress: (done, total) => progress.push([done, total]) },
    )

    expect(attempts).toBe(2)
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  test("counts ids skipped by proceed", async () => {
    const progress: Array<[number, number]> = []

    await runBulk(["ses_a", "ses_b"], async () => {}, {
      proceed: () => false,
      onProgress: (done, total) => progress.push([done, total]),
    })

    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ])
  })
})

describe("rangeSelect", () => {
  const order = ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"]

  const all = () => true

  test("selects the inclusive range forward", () => {
    expect(rangeSelect(order, "ses_b", "ses_d", all)).toEqual(["ses_b", "ses_c", "ses_d"])
  })

  test("selects the same range backward, in list order", () => {
    expect(rangeSelect(order, "ses_d", "ses_b", all)).toEqual(["ses_b", "ses_c", "ses_d"])
  })

  test("returns only the target when anchor and target are the same row", () => {
    expect(rangeSelect(order, "ses_c", "ses_c", all)).toEqual(["ses_c"])
  })

  test("returns only the target when there is no anchor", () => {
    expect(rangeSelect(order, undefined, "ses_c", all)).toEqual(["ses_c"])
  })

  test("returns only the target when the anchor is not in the list", () => {
    expect(rangeSelect(order, "ses_gone", "ses_c", all)).toEqual(["ses_c"])
  })

  test("returns only the target when the target is not in the list", () => {
    expect(rangeSelect(order, "ses_b", "ses_gone", () => true)).toEqual(["ses_gone"])
  })

  test("skips rows that are not selectable inside the range", () => {
    const busy = new Set(["ses_c"])

    expect(rangeSelect(order, "ses_a", "ses_e", (id) => !busy.has(id))).toEqual(["ses_a", "ses_b", "ses_d", "ses_e"])
  })

  test("leaves the target out when it is not selectable, keeping the selectable rows before it", () => {
    expect(rangeSelect(order, "ses_a", "ses_c", (id) => id !== "ses_c")).toEqual(["ses_a", "ses_b"])
  })

  test("returns nothing when there is no usable anchor and the target is not selectable", () => {
    expect(rangeSelect(order, undefined, "ses_c", () => false)).toEqual([])
  })
})

describe("isSelectable", () => {
  const session = (time: { archived?: number | null } = {}, parentID?: string) => ({
    id: "ses_x",
    parentID,
    location: { directory: "/repo" },
    time,
  })

  test("accepts an idle, root, active session", () => {
    expect(isSelectable(session(), false)).toBe(true)
  })

  test("rejects a busy session", () => {
    expect(isSelectable(session(), true)).toBe(false)
  })

  test("rejects a child session", () => {
    expect(isSelectable(session({}, "ses_parent"), false)).toBe(false)
  })

  test("rejects an archived session", () => {
    expect(isSelectable(session({ archived: 1_700_000_000_000 }), false)).toBe(false)
  })

  test("rejects an epoch-zero archive timestamp", () => {
    expect(isSelectable(session({ archived: 0 }), false)).toBe(false)
  })

  test("treats a null or undefined archive timestamp as active", () => {
    expect(isSelectable(session({ archived: null }), false)).toBe(true)
    expect(isSelectable(session({ archived: undefined }), false)).toBe(true)
  })
})

describe("isArchivedSelectable", () => {
  const session = (time: { archived?: number | null }, parentID?: string | null) => ({
    id: "ses_x",
    parentID,
    location: { directory: "/repo" },
    time,
  })

  test("accepts an idle, root, archived session", () => {
    expect(isArchivedSelectable(session({ archived: 1_700_000_000_000 }), false)).toBe(true)
  })

  test("accepts an epoch-zero archive timestamp", () => {
    expect(isArchivedSelectable(session({ archived: 0 }), false)).toBe(true)
  })

  test("rejects a busy session", () => {
    expect(isArchivedSelectable(session({ archived: 1_700_000_000_000 }), true)).toBe(false)
  })

  test("rejects a child session", () => {
    expect(isArchivedSelectable(session({ archived: 1_700_000_000_000 }, "ses_parent"), false)).toBe(false)
  })

  test("rejects a session that is not archived", () => {
    expect(isArchivedSelectable(session({}), false)).toBe(false)
    expect(isArchivedSelectable(session({ archived: null }), false)).toBe(false)
    expect(isArchivedSelectable(session({ archived: undefined }), false)).toBe(false)
  })

  test("treats a null, undefined or empty parent as a root", () => {
    for (const parentID of [null, undefined, ""]) {
      expect(isArchivedSelectable(session({ archived: 1 }, parentID), false)).toBe(true)
    }
  })

  test("is the archived counterpart of isSelectable for an idle root", () => {
    const archived = session({ archived: 1 })
    const active = session({})

    expect(isArchivedSelectable(archived, false)).toBe(!isSelectable(archived, false))
    expect(isArchivedSelectable(active, false)).toBe(!isSelectable(active, false))
  })
})

describe("openTabCount", () => {
  const trees = new Map([
    ["ses_a", ["ses_a", "ses_a_child"]],
    ["ses_b", ["ses_b", "ses_b_child"]],
    ["ses_c", ["ses_c"]],
  ])

  const tree = (id: string) => trees.get(id) ?? []

  test("is zero for no ids", () => {
    expect(openTabCount([], tree, () => true)).toBe(0)
  })

  test("is zero when no tree has a tab", () => {
    expect(openTabCount(["ses_a", "ses_b"], tree, () => false)).toBe(0)
  })

  test("counts a root whose tab is on the root itself", () => {
    expect(openTabCount(["ses_c"], tree, (id) => id === "ses_c")).toBe(1)
  })

  test("counts a root whose tab is only on a child", () => {
    expect(openTabCount(["ses_a"], tree, (id) => id === "ses_a_child")).toBe(1)
  })

  test("counts only the roots that have a tab", () => {
    expect(openTabCount(["ses_a", "ses_b"], tree, (id) => id === "ses_b_child")).toBe(1)
  })

  test("counts a root once however many tabs its tree has", () => {
    expect(openTabCount(["ses_a"], tree, () => true)).toBe(1)
  })

  test("never counts a root whose tree function lacks the id", () => {
    expect(openTabCount(["ses_unknown"], tree, () => true)).toBe(0)
    expect(
      openTabCount(
        ["ses_a"],
        () => ["ses_other"],
        (id) => id === "ses_a",
      ),
    ).toBe(0)
  })

  test("asks hasTab about tree members only", () => {
    const asked: string[] = []

    openTabCount(["ses_c"], tree, (id) => (asked.push(id), false))
    expect(asked).toEqual(["ses_c"])
  })
})

describe("bulkSummary", () => {
  test("reports one archived session in the singular", () => {
    expect(bulkSummary("archive", result({ ok: ["ses_a"] }), language)).toEqual({
      variant: "success",
      title: "Archived 1 session",
    })
  })

  test("reports several archived sessions in the plural", () => {
    expect(bulkSummary("archive", result({ ok: ["ses_a", "ses_b", "ses_c"] }), language)).toEqual({
      variant: "success",
      title: "Archived 3 sessions",
    })
  })

  test("counts missing sessions as done when nothing failed", () => {
    expect(bulkSummary("archive", result({ ok: ["ses_a"], missing: ["ses_b"] }), language)).toEqual({
      variant: "success",
      title: "Archived 2 sessions",
    })
  })

  test("reports deleted sessions with the delete copy", () => {
    expect(bulkSummary("delete", result({ ok: ["ses_a"] }), language)).toEqual({
      variant: "success",
      title: "Deleted 1 session",
    })
    expect(bulkSummary("delete", result({ ok: ["ses_a", "ses_b"], missing: ["ses_c"] }), language)).toEqual({
      variant: "success",
      title: "Deleted 3 sessions",
    })
  })

  test("reports a partial archive as an error with done of total and the failed count", () => {
    const ok = Array.from({ length: 37 }, (_, index) => `ses_ok_${index}`)

    expect(
      bulkSummary("archive", result({ ok, missing: ["ses_gone"], failed: ["ses_f1", "ses_f2"] }), language),
    ).toEqual({ variant: "error", title: "Archived 38 of 40, 2 failed" })
  })

  test("reports a partial delete as an error with done of total and the failed count", () => {
    expect(bulkSummary("delete", result({ ok: ["ses_a"], failed: ["ses_b", "ses_c"] }), language)).toEqual({
      variant: "error",
      title: "Deleted 1 of 3, 2 failed",
    })
  })

  test("reports a fully failed batch as an error with zero done", () => {
    expect(bulkSummary("archive", result({ failed: ["ses_a", "ses_b"] }), language)).toEqual({
      variant: "error",
      title: "Archived 0 of 2, 2 failed",
    })
  })

  test("reports one unarchived session in the singular", () => {
    expect(bulkSummary("unarchive", result({ ok: ["ses_a"] }), language)).toEqual({
      variant: "success",
      title: "Unarchived 1 session",
    })
  })

  test("reports several unarchived sessions in the plural", () => {
    expect(bulkSummary("unarchive", result({ ok: ["ses_a", "ses_b", "ses_c"] }), language)).toEqual({
      variant: "success",
      title: "Unarchived 3 sessions",
    })
  })

  test("counts missing sessions as done for an unarchive when nothing failed", () => {
    expect(bulkSummary("unarchive", result({ ok: ["ses_a"], missing: ["ses_b"] }), language)).toEqual({
      variant: "success",
      title: "Unarchived 2 sessions",
    })
    expect(bulkSummary("unarchive", result({ missing: ["ses_b"] }), language)).toEqual({
      variant: "success",
      title: "Unarchived 1 session",
    })
  })

  test("reports a partial unarchive as an error with exact counts", () => {
    const ok = Array.from({ length: 5 }, (_, index) => `ses_ok_${index}`)

    expect(
      bulkSummary("unarchive", result({ ok, missing: ["ses_gone"], failed: ["ses_f1", "ses_f2"] }), language),
    ).toEqual({ variant: "error", title: "Unarchived 6 of 8, 2 failed" })
  })

  test("reports a fully failed or offline unarchive as an error with zero done", () => {
    const ids = ["ses_a", "ses_b", "ses_c"]

    expect(ids.length).toBeGreaterThan(0)
    expect(bulkSummary("unarchive", offlineResult(ids), language)).toEqual({
      variant: "error",
      title: "Unarchived 0 of 3, 3 failed",
    })
  })

  test("keeps the archive and delete copy distinct from unarchive for the same result", () => {
    const same = result({ ok: ["ses_a", "ses_b"] })
    const titles = (["archive", "delete", "unarchive"] as const).map((kind) => bulkSummary(kind, same, language).title)

    expect(titles).toEqual(["Archived 2 sessions", "Deleted 2 sessions", "Unarchived 2 sessions"])
  })
})

describe("nextSelection", () => {
  const order = ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"]

  const input = (id: string, shift: boolean, selectable: (id: string) => boolean = () => true) => ({
    id,
    shift,
    order,
    selectable,
  })

  test("a plain click selects the row and makes it the anchor", () => {
    expect(nextSelection({ ids: [] }, input("ses_b", false))).toEqual({ ids: ["ses_b"], anchor: "ses_b" })
  })

  test("a plain click on a selected row deselects it and keeps the other rows", () => {
    expect(nextSelection({ ids: ["ses_a", "ses_b"], anchor: "ses_b" }, input("ses_b", false)).ids).toEqual(["ses_a"])
  })

  test("a plain click on another row adds it and moves the anchor", () => {
    expect(nextSelection({ ids: ["ses_a"], anchor: "ses_a" }, input("ses_d", false))).toEqual({
      ids: ["ses_a", "ses_d"],
      anchor: "ses_d",
    })
  })

  test("shift extends from the anchor to the target", () => {
    const next = nextSelection({ ids: ["ses_b"], anchor: "ses_b" }, input("ses_d", true))

    expect([...next.ids].sort()).toEqual(["ses_b", "ses_c", "ses_d"])
  })

  test("shift extends backward from the anchor", () => {
    const next = nextSelection({ ids: ["ses_d"], anchor: "ses_d" }, input("ses_b", true))

    expect([...next.ids].sort()).toEqual(["ses_b", "ses_c", "ses_d"])
  })

  test("shift keeps rows selected earlier outside the range", () => {
    const next = nextSelection({ ids: ["ses_a", "ses_c"], anchor: "ses_c" }, input("ses_e", true))

    expect([...next.ids].sort()).toEqual(["ses_a", "ses_c", "ses_d", "ses_e"])
  })

  test("shift without an anchor selects only the target", () => {
    expect(nextSelection({ ids: [] }, input("ses_c", true)).ids).toEqual(["ses_c"])
  })

  test("shift skips rows that are not selectable", () => {
    const next = nextSelection(
      { ids: ["ses_a"], anchor: "ses_a" },
      input("ses_d", true, (id) => id !== "ses_c"),
    )

    expect([...next.ids].sort()).toEqual(["ses_a", "ses_b", "ses_d"])
  })

  test("toggling a row that is not selectable changes nothing", () => {
    const state = { ids: ["ses_a"], anchor: "ses_a" }

    expect(
      nextSelection(
        state,
        input("ses_c", false, (id) => id !== "ses_c"),
      ),
    ).toEqual({
      ids: ["ses_a"],
      anchor: "ses_a",
    })
  })

  test("does not mutate the previous state", () => {
    const ids = Object.freeze(["ses_a"])

    const next = nextSelection({ ids, anchor: "ses_a" }, input("ses_c", true))

    expect(ids).toEqual(["ses_a"])
    expect(next.ids).not.toBe(ids)
  })
})

describe("pruneSelection", () => {
  test("drops ids that are no longer valid and keeps the order", () => {
    expect(pruneSelection(["ses_a", "ses_b", "ses_c", "ses_d"], new Set(["ses_d", "ses_a", "ses_c"]))).toEqual([
      "ses_a",
      "ses_c",
      "ses_d",
    ])
  })

  test("keeps every id when all are still valid", () => {
    expect(pruneSelection(["ses_a", "ses_b"], new Set(["ses_a", "ses_b", "ses_z"]))).toEqual(["ses_a", "ses_b"])
  })

  test("returns nothing when no id is valid", () => {
    expect(pruneSelection(["ses_a", "ses_b"], new Set<string>())).toEqual([])
  })
})

describe("skipId", () => {
  test("skips when the connection is down and the id is idle", () => {
    expect(skipId(false, false)).toBe(true)
  })

  test("skips when the connection is up and the id is busy", () => {
    expect(skipId(true, true)).toBe(true)
  })

  test("skips when the connection is down and the id is busy", () => {
    expect(skipId(false, true)).toBe(true)
  })

  test("does not skip a connected idle id", () => {
    expect(skipId(true, false)).toBe(false)
  })

  test("runBulk never calls op and fails every id while disconnected", async () => {
    const ids = ["ses_a", "ses_b", "ses_c"]
    const calls: string[] = []

    expect(ids.length).toBeGreaterThan(0)

    const final = await runBulk(
      ids,
      async (id) => {
        calls.push(id)
      },
      { isBusy: () => skipId(false, false) },
    )

    expect(calls).toEqual([])
    expect(final).toEqual(result({ failed: ids }))
  })

  test("runBulk fails only the busy id when connected and still runs the others", async () => {
    const calls: string[] = []

    const final = await runBulk(
      ["ses_a", "ses_busy", "ses_z"],
      async (id) => {
        calls.push(id)
      },
      { isBusy: (id) => skipId(true, id === "ses_busy") },
    )

    expect(calls).toEqual(["ses_a", "ses_z"])
    expect(final).toEqual(result({ ok: ["ses_a", "ses_z"], failed: ["ses_busy"] }))
  })

  test("runBulk stops running ops once the connection drops mid-batch", async () => {
    let connected = true
    const calls: string[] = []

    const final = await runBulk(
      ["ses_a", "ses_b", "ses_c"],
      async (id) => {
        calls.push(id)
        connected = false
      },
      { isBusy: () => skipId(connected, false) },
    )

    expect(calls).toEqual(["ses_a"])
    expect(final).toEqual(result({ ok: ["ses_a"], failed: ["ses_b", "ses_c"] }))
  })
})

describe("offlineResult", () => {
  test("fails every id in order and reports nothing ok or missing", () => {
    const ids = ["ses_c", "ses_a", "ses_b"]

    expect(ids.length).toBeGreaterThan(0)
    expect(offlineResult(ids)).toEqual({ ok: [], missing: [], failed: ["ses_c", "ses_a", "ses_b"] })
  })

  test("returns a fresh failed array that does not alias the input", () => {
    const ids = ["ses_a", "ses_b"]

    const offline = offlineResult(ids)

    expect(offline.failed).not.toBe(ids)
    ids.push("ses_late")
    expect(offline.failed).toEqual(["ses_a", "ses_b"])
  })

  test("returns empty arrays for no ids", () => {
    expect(offlineResult([])).toEqual({ ok: [], missing: [], failed: [] })
  })

  test("matches what runBulk returns when every id is skipped", async () => {
    const ids = ["ses_a", "ses_b"]

    expect(ids.length).toBeGreaterThan(0)
    expect(offlineResult(ids)).toEqual(await runBulk(ids, async () => {}, { isBusy: () => true }))
  })

  test("summarizes an offline archive as an error with zero done", () => {
    const ids = ["ses_a", "ses_b", "ses_c"]

    expect(ids.length).toBeGreaterThan(0)
    expect(bulkSummary("archive", offlineResult(ids), language)).toEqual({
      variant: "error",
      title: "Archived 0 of 3, 3 failed",
    })
  })

  test("summarizes an offline delete as an error with zero done", () => {
    const ids = ["ses_a", "ses_b"]

    expect(ids.length).toBeGreaterThan(0)
    expect(bulkSummary("delete", offlineResult(ids), language)).toEqual({
      variant: "error",
      title: "Deleted 0 of 2, 2 failed",
    })
  })
})
