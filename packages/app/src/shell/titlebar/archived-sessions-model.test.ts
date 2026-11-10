/**
 * @spec-handoff
 * @interface createArchivedSessionsModel(deps): { load(): Promise<void>; loadMore(): Promise<void>; retryMore(): Promise<void> }
 * @interface deps gains REQUIRED unarchive(target: { server; sessionID }): Promise<ArchiveAttempt>, remove(sessionID): Promise<void>,
 *   connected(): boolean, isBusy(sessionID): boolean, active(): boolean
 * @interface model gains bulkRunning(): boolean; restoreMany(ids, options?: { onProgress?(done, total) }) and
 *   removeMany(ids, options?): Promise<BulkResult | undefined>
 * @behavior
 *   - Loads one archived:true root batch of 50, then appends unique continuation rows in response order.
 *   - Guards concurrent continuation, retains rows on recoverable continuation failure, and retries its same cursor.
 *   - Ignores stale, disposed, reset, and restore-aborted append completions.
 *   - Keeps first row objects, terminates an empty root batch, and searches retained rows without fetching.
 *   - restoreMany/removeMany run runBulk over the deduped ids one at a time: ok and missing rows leave in ONE update, failed rows
 *     stay, nextCursor and continuationError are kept, onProgress fires per id. restoreMany sends deps.unarchive({ server, sessionID });
 *     removeMany sends deps.remove(sessionID). A failed attempt rethrows its error (404 -> missing); a pending attempt is failed.
 *   - Returns undefined when refused (disposed, restoring, bulk already running, state not ready, no ids after dedupe) and
 *     offlineResult(ids) when connected() is false at start. Per id, a busy session, a lost connection or active() false is failed.
 *   - While a batch runs, bulkRunning() is true; load, loadMore, retryMore and restore are no-ops; a held continuation is aborted.
 *   - dispose() mid-batch does not stop the batch: deps keep being called, the result is returned, and nothing notifies.
 *   - A batch never calls openProject, touchProject, addTab, selectTab or close.
 * @edge-cases
 *   - Empty or cursorless batches exhaust; short nonempty batches with a cursor remain continuable; restore sends archived:false.
 *   - Repeated cursors and duplicate-only batches pause with a recoverable error rather than exhausting.
 * @see RFC 057 D.3.1-9, AP1, AP4-7
 */
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these controlled black-box fixtures deliberately capture the opaque SDK request and assert the proposed model contract before its typed API exists.
import { expect, test } from "bun:test"
import { Data } from "effect"
import type { BulkResult } from "@/home/sessions/bulk"
import type { ArchiveAttempt } from "@/session/archive"
import { createArchivedSessionsModel, loadArchivedSessions, matchesArchivedSession } from "./archived-sessions-model"

type ContinuousModel = {
  state: () => { status: string; rows?: readonly { id: string }[]; nextCursor?: string; continuationError?: unknown }
  load: () => Promise<void>
  loadMore: () => Promise<void>
  retryMore: () => Promise<void>
  search: (query: string) => readonly { id: string }[]
  restore: (id: string) => Promise<boolean>
  dispose: () => void
}

// Harmless defaults for the bulk deps, so the single-restore fixtures below keep their meaning.
const bulkDeps = {
  unarchive: async (): Promise<ArchiveAttempt> => ({ status: "archived" }),
  remove: async () => {},
  connected: () => true,
  isBusy: () => false,
  active: () => true,
}

const session = (id: string, archived = 1) => ({ id, title: id, location: { directory: `/${id}` }, time: { archived } })

function model(list: (input: unknown) => Promise<unknown>) {
  return createArchivedSessionsModel({
    server: "captured-server",
    list: async (input: unknown) => list(input) as never,
    setArchive: async () => true,
    openProject: async () => {},
    touchProject: () => {},
    addTab: () => "tab",
    selectTab: () => {},
    close: () => {},
    ...bulkDeps,
  }) as unknown as ContinuousModel
}

test("loads one archived:true root batch with the fixed limit and searches loaded title or directory rows locally", async () => {
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    return { data: [session("zero", 0), session("directory-match")], cursor: { next: "after-root" } }
  })

  await archive.load()
  expect(requests).toEqual([{ archived: true, parentID: null, order: "desc", limit: 50 }])
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["zero", "directory-match"])
  expect(matchesArchivedSession(session("directory-match"), "directory")).toBe(true)
})

test("appends unseen continuation rows in response order without treating a short cursor-bearing batch as exhausted", async () => {
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    return requests.length === 1
      ? { data: [session("newest"), session("overlap")], cursor: { next: "cursor-2" } }
      : { data: [session("overlap", 999), session("older")], cursor: { next: "cursor-3" } }
  })

  await archive.load()
  await archive.loadMore()
  expect(requests).toEqual([
    { archived: true, parentID: null, order: "desc", limit: 50 },
    { archived: true, parentID: null, order: "desc", limit: 50, cursor: "cursor-2" },
  ])
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["newest", "overlap", "older"])
  expect(archive.state().nextCursor).toBe("cursor-3")
})

test("deduplicates each root and continuation batch while retaining first objects and loaded row references", async () => {
  const initial = session("first")
  const duplicateInitial = { ...initial, title: "ignored initial duplicate" }
  const duplicateAppend = session("second")
  const archive = model(async (input) => {
    if (!(input as { cursor?: string }).cursor)
      return { data: [initial, duplicateInitial], cursor: { next: "cursor-2" } }
    return {
      data: [{ ...initial, title: "ignored overlap" }, duplicateAppend, { ...duplicateAppend }, session("third")],
      cursor: {},
    }
  })

  await archive.load()
  const retained = archive.state().rows?.[0]
  await archive.loadMore()

  expect(archive.state().rows?.map((row) => row.id)).toEqual(["first", "second", "third"])
  expect(archive.state().rows?.[0]).toBe(retained)
  expect(archive.state().rows?.[0]).toBe(initial)
  expect(archive.state().rows?.[1]).toBe(duplicateAppend)
})

test("sets the continuation in-flight guard before awaiting and does not completion-chain another request", async () => {
  const held = Promise.withResolvers<unknown>()
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    if (requests.length === 1) return { data: [session("first")], cursor: { next: "cursor-2" } }
    return held.promise
  })

  await archive.load()
  const first = archive.loadMore()
  const duplicate = archive.loadMore()
  expect(requests).toHaveLength(2)
  held.resolve({ data: [session("second")], cursor: { next: "cursor-3" } })
  await Promise.all([first, duplicate])
  expect(requests).toHaveLength(2)
})

test("keeps rows and the failed cursor for retry after duplicate-only or repeated-cursor continuation", async () => {
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    if (requests.length === 1) return { data: [session("first")], cursor: { next: "cursor-2" } }
    if (requests.length === 2) return { data: [session("first")], cursor: { next: "cursor-2" } }
    return { data: [session("second")], cursor: {} }
  })

  await archive.load()
  await archive.loadMore()
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["first"])
  expect(archive.state().nextCursor).toBe("cursor-2")
  expect(archive.state().continuationError).toBeDefined()
  await archive.retryMore()
  expect(requests[2]).toEqual({ archived: true, parentID: null, order: "desc", limit: 50, cursor: "cursor-2" })
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["first", "second"])
})

test("exhausts only on an empty batch or an absent cursor, never a short cursor-bearing batch", async () => {
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    if (requests.length === 1) return { data: [session("first")], cursor: { next: "cursor-2" } }
    if (requests.length === 2) return { data: [session("short")], cursor: { next: "cursor-3" } }
    return { data: [], cursor: { next: "bogus" } }
  })
  const cursorless = model(async () => ({ data: [session("final")], cursor: {} }))

  await archive.load()
  await archive.loadMore()
  expect(archive.state().nextCursor).toBe("cursor-3")
  await archive.loadMore()
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["first", "short"])
  expect(archive.state().nextCursor).toBeUndefined()
  await archive.loadMore()
  expect(requests).toHaveLength(3)

  await cursorless.load()
  expect(cursorless.state().rows?.map((row) => row.id)).toEqual(["final"])
  expect(cursorless.state().nextCursor).toBeUndefined()
})

test("treats an empty root batch as terminal despite a bogus continuation cursor", async () => {
  let requests = 0
  const archive = model(async () => {
    requests++
    return { data: [], cursor: { next: "bogus" } }
  })

  await archive.load()
  await archive.loadMore()

  expect(archive.state()).toMatchObject({ status: "ready", rows: [], nextCursor: undefined })
  expect(requests).toBe(1)
})

test("pauses when a later continuation returns an already consumed cursor other than its requested cursor", async () => {
  const archive = model(async (input) => {
    const cursor = (input as { cursor?: string }).cursor
    if (!cursor) return { data: [session("first")], cursor: { next: "cursor-2" } }
    if (cursor === "cursor-2") return { data: [session("second")], cursor: { next: "cursor-3" } }
    return { data: [session("third")], cursor: { next: "cursor-2" } }
  })

  await archive.load()
  await archive.loadMore()
  await archive.loadMore()
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["first", "second"])
  expect(archive.state().nextCursor).toBe("cursor-3")
  expect(archive.state().continuationError).toBeDefined()
})

test("retries an initial failure from the first batch", async () => {
  const requests: unknown[] = []
  const archive = model(async (input) => {
    requests.push(input)
    if (requests.length === 1) throw new Error("offline")
    return { data: [session("recovered")], cursor: {} }
  })

  await archive.load()
  await archive.retryMore()
  expect(requests).toEqual([
    { archived: true, parentID: null, order: "desc", limit: 50 },
    { archived: true, parentID: null, order: "desc", limit: 50 },
  ])
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["recovered"])
})

test("commits final nonempty rows, exhausts only on empty or missing cursor, and ignores stale append after disposal", async () => {
  const held = Promise.withResolvers<unknown>()
  let calls = 0
  const archive = model(async () => {
    calls++
    if (calls === 1) return { data: [session("first")], cursor: { next: "cursor-2" } }
    return held.promise
  })

  await archive.load()
  const append = archive.loadMore()
  archive.dispose()
  held.resolve({ data: [session("stale")], cursor: {} })
  await append
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["first"])
})

for (const outcome of ["resolve", "reject"] as const) {
  test(`ignores an abort-ignored ${outcome} from a continuation after load resets its generation`, async () => {
    const held = Promise.withResolvers<unknown>()
    let calls = 0
    const archive = model(async () => {
      calls++
      if (calls === 1) return { data: [session("first")], cursor: { next: "cursor-2" } }
      if (calls === 2) return held.promise
      return { data: [session("replacement")], cursor: {} }
    })

    await archive.load()
    const append = archive.loadMore()
    await archive.load()
    if (outcome === "resolve") held.resolve({ data: [session("stale")], cursor: {} })
    else held.reject(new Error("ignored abort"))
    await append
    expect(archive.state().rows?.map((row) => row.id)).toEqual(["replacement"])
  })
}

test("restore aborts a held continuation, keeps displayed rows, and prevents its late result from appending", async () => {
  const continuation = Promise.withResolvers<unknown>()
  const restore = Promise.withResolvers<boolean>()
  const calls: string[] = []
  let requests = 0
  const archive = createArchivedSessionsModel({
    server: "captured-server",
    list: async () => {
      requests++
      if (requests === 1) return { data: [session("shown")], cursor: { next: "cursor-2" } } as never
      return continuation.promise as never
    },
    setArchive: async () => restore.promise,
    openProject: async () => void calls.push("open"),
    touchProject: () => calls.push("touch"),
    addTab: () => {
      calls.push("tab")
      return "tab"
    },
    selectTab: () => calls.push("select"),
    close: () => calls.push("close"),
    ...bulkDeps,
  }) as unknown as ContinuousModel

  await archive.load()
  const append = archive.loadMore()
  const restoring = archive.restore("shown")
  await archive.loadMore()
  expect(requests).toBe(2)
  continuation.resolve({ data: [session("stale")], cursor: {} })
  restore.resolve(true)
  await Promise.all([append, restoring])
  expect(archive.state().rows?.map((row) => row.id)).not.toContain("stale")
  expect(calls).toEqual(["open", "touch", "tab", "select", "close"])
})

test("restores a captured displayed row through the existing success-only tab sequence", async () => {
  const calls: string[] = []
  const archiveCalls: unknown[] = []
  const archive = createArchivedSessionsModel({
    server: "captured-server",
    list: async () => ({ data: [session("restorable")], cursor: {} }) as never,
    setArchive: async (input) => {
      archiveCalls.push(input)
      return true
    },
    openProject: async () => void calls.push("open"),
    touchProject: () => calls.push("touch"),
    addTab: () => {
      calls.push("tab")
      return "tab"
    },
    selectTab: () => calls.push("select"),
    close: () => calls.push("close"),
    ...bulkDeps,
  })

  await archive.load()
  expect(await archive.restore("restorable")).toBe(true)
  expect(archiveCalls).toEqual([{ server: "captured-server", sessionID: "restorable", archived: false }])
  expect(calls).toEqual(["open", "touch", "tab", "select", "close"])
})

test("keeps continuation available after a failed restore without replaying the aborted request", async () => {
  let requests = 0
  const archiveCalls: unknown[] = []
  const archive = createArchivedSessionsModel({
    server: "captured-server",
    list: async () => {
      requests++
      return requests === 1
        ? ({ data: [session("shown")], cursor: { next: "cursor-2" } } as never)
        : ({ data: [session("later")], cursor: {} } as never)
    },
    setArchive: async (input) => {
      archiveCalls.push(input)
      return false
    },
    openProject: async () => {},
    touchProject: () => {},
    addTab: () => "tab",
    selectTab: () => {},
    close: () => {},
    ...bulkDeps,
  }) as unknown as ContinuousModel

  await archive.load()
  expect(await archive.restore("shown")).toBe(false)
  expect(archiveCalls).toEqual([{ server: "captured-server", sessionID: "shown", archived: false }])
  await archive.loadMore()
  expect(archive.state().rows?.map((row) => row.id)).toEqual(["shown", "later"])
})

for (const lateOutcome of ["resolve", "reject"] as const) {
  test(`clears a restore-aborted held append before its late ${lateOutcome} and permits an explicit same-cursor retry`, async () => {
    const held = Promise.withResolvers<unknown>()
    let requests = 0
    const archive = createArchivedSessionsModel({
      server: "captured-server",
      list: async () => {
        requests++
        if (requests === 1) return { data: [session("shown")], cursor: { next: "cursor-2" } } as never
        if (requests === 2) return held.promise as never
        return { data: [session("later")], cursor: {} } as never
      },
      setArchive: async () => false,
      openProject: async () => {},
      touchProject: () => {},
      addTab: () => "tab",
      selectTab: () => {},
      close: () => {},
      ...bulkDeps,
    }) as unknown as ContinuousModel

    await archive.load()
    const retained = archive.state().rows?.[0]
    const append = archive.loadMore()
    expect(await archive.restore("shown")).toBe(false)
    expect(archive.state()).toMatchObject({ status: "ready", nextCursor: "cursor-2", continuationPending: false })
    expect(archive.state().rows?.[0]).toBe(retained)
    if (lateOutcome === "resolve") held.resolve({ data: [session("stale")], cursor: {} })
    else held.reject(new Error("ignored abort"))
    await append
    expect(archive.state().rows?.map((row) => row.id)).toEqual(["shown"])

    await archive.loadMore()
    expect(requests).toBe(3)
    expect(archive.state().rows?.map((row) => row.id)).toEqual(["shown", "later"])
  })
}

test("filters loaded title and directory rows locally without issuing another archive request", async () => {
  let requests = 0
  const archive = model(async () => {
    requests++
    return { data: [session("title-match"), session("directory-match")], cursor: {} }
  })

  await archive.load()
  expect(archive.search("title").map((row) => row.id)).toEqual(["title-match"])
  expect(archive.search("/directory").map((row) => row.id)).toEqual(["directory-match"])
  expect(archive.search("").map((row) => row.id)).toEqual(["title-match", "directory-match"])
  expect(requests).toBe(1)
})

test("loadArchivedSessions preserves one-request validation and terminal cursor normalization", async () => {
  const page = await loadArchivedSessions(
    { list: async () => ({ data: [session("final")], cursor: {} }) as never },
    { signal: new AbortController().signal },
  )
  expect(page.sessions.map((row) => row.id)).toEqual(["final"])
  expect(page.cursor.next).toBeUndefined()
})

type ManyOptions = { onProgress?: (done: number, total: number) => void }

type BulkModel = ContinuousModel & {
  subscribe: (listener: () => void) => () => void
  bulkRunning: () => boolean
  restoringID: () => string | undefined
  restoreMany: (ids: readonly string[], options?: ManyOptions) => Promise<BulkResult | undefined>
  removeMany: (ids: readonly string[], options?: ManyOptions) => Promise<BulkResult | undefined>
}

type Kind = "restore" | "remove"

// A tagged error carries the `_tag` the client guard reads, like the 404 the client throws.
class SessionNotFoundError extends Data.TaggedError("SessionNotFoundError")<{
  readonly sessionID: string
  readonly message: string
}> {}

const notFound = () => new SessionNotFoundError({ sessionID: "ses_gone", message: "gone" })

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// One fixture drives restoreMany (through deps.unarchive) and removeMany (through deps.remove) with the same behaviour.
function bulkFixture(
  kind: Kind,
  options: {
    behave?: (id: string, archive: BulkModel) => Promise<void> | void
    attempt?: (id: string) => ArchiveAttempt
    connected?: () => boolean
    isBusy?: (id: string) => boolean
    active?: () => boolean
    list?: (call: number) => Promise<unknown>
    setArchive?: () => Promise<boolean>
  } = {},
) {
  const ran: string[] = []
  const wrong: string[] = []
  const targets: unknown[] = []
  const calls: string[] = []
  const lists: unknown[] = []
  const signals: (AbortSignal | undefined)[] = []

  const archive = createArchivedSessionsModel({
    server: "captured-server",
    list: async (input, listOptions) => {
      lists.push(input)
      signals.push(listOptions?.signal)

      if (options.list) return (await options.list(lists.length)) as never

      return lists.length === 1
        ? ({ data: ["a", "b", "c", "d"].map((id) => session(id)), cursor: { next: "cursor-2" } } as never)
        : ({ data: [session("later")], cursor: {} } as never)
    },
    setArchive: async () => {
      calls.push("setArchive")

      return options.setArchive ? options.setArchive() : true
    },
    openProject: async () => void calls.push("open"),
    touchProject: () => calls.push("touch"),
    addTab: () => {
      calls.push("tab")

      return "tab"
    },
    selectTab: () => calls.push("select"),
    close: () => calls.push("close"),
    unarchive: async (target: { server: string; sessionID: string }): Promise<ArchiveAttempt> => {
      if (kind === "remove") {
        wrong.push(target.sessionID)

        return { status: "archived" }
      }

      targets.push(target)
      ran.push(target.sessionID)

      if (options.attempt) return options.attempt(target.sessionID)

      try {
        await options.behave?.(target.sessionID, archive)

        return { status: "archived" }
      } catch (error) {
        return { status: "failed", error }
      }
    },
    remove: async (sessionID: string) => {
      if (kind === "restore") {
        wrong.push(sessionID)

        return
      }

      ran.push(sessionID)
      await options.behave?.(sessionID, archive)
    },
    connected: options.connected ?? (() => true),
    isBusy: options.isBusy ?? (() => false),
    active: options.active ?? (() => true),
  }) as unknown as BulkModel

  const run = (ids: readonly string[], manyOptions?: ManyOptions) =>
    kind === "restore" ? archive.restoreMany(ids, manyOptions) : archive.removeMany(ids, manyOptions)

  const rows = () => archive.state().rows?.map((row) => row.id)

  return { archive, run, rows, ran, wrong, targets, calls, lists, signals }
}

for (const kind of ["restore", "remove"] as const) {
  const method = kind === "restore" ? "restoreMany" : "removeMany"

  test(`${method} runs the ids one at a time in the given order and keeps the rows until the batch ends`, async () => {
    let running = 0
    let peak = 0
    const during: (string[] | undefined)[] = []

    const fixture = bulkFixture(kind, {
      behave: async (_id, archive) => {
        running++
        peak = Math.max(peak, running)
        during.push(archive.state().rows?.map((row) => row.id))
        await tick()
        running--
      },
    })

    await fixture.archive.load()
    const result = await fixture.run(["c", "a", "d"])

    expect(fixture.ran).toEqual(["c", "a", "d"])
    expect(peak).toBe(1)
    expect(during).toEqual([
      ["a", "b", "c", "d"],
      ["a", "b", "c", "d"],
      ["a", "b", "c", "d"],
    ])
    expect(result).toEqual({ ok: ["c", "a", "d"], missing: [], failed: [] })
    expect(fixture.wrong).toEqual([])
  })

  test(`${method} notifies once when it starts and once when the rows leave, in one update`, async () => {
    const fixture = bulkFixture(kind)

    await fixture.archive.load()
    const seen: (string[] | undefined)[] = []
    fixture.archive.subscribe(() => seen.push(fixture.rows()))
    await fixture.run(["a", "b"])

    expect(seen).toEqual([
      ["a", "b", "c", "d"],
      ["c", "d"],
    ])
  })

  test(`${method} drops ok and missing rows and keeps failed rows`, async () => {
    const fixture = bulkFixture(kind, {
      behave: (id) => {
        if (id === "b") throw notFound()

        if (id === "c") throw new Error("boom")
      },
    })

    await fixture.archive.load()
    const result = await fixture.run(["a", "b", "c", "d"])

    expect(result).toEqual({ ok: ["a", "d"], missing: ["b"], failed: ["c"] })
    expect(fixture.rows()).toEqual(["c"])
  })

  test(`${method} keeps the continuation cursor and error while removing rows`, async () => {
    let call = 0

    const fixture = bulkFixture(kind, {
      list: async () => {
        call++

        return call === 1
          ? { data: [session("a"), session("b"), session("c")], cursor: { next: "cursor-2" } }
          : { data: [session("a")], cursor: { next: "cursor-2" } }
      },
    })

    await fixture.archive.load()
    await fixture.archive.loadMore()
    const before = fixture.archive.state()

    expect(before.continuationError).toBeDefined()
    await fixture.run(["a", "b"])

    expect(fixture.rows()).toEqual(["c"])
    expect(fixture.archive.state().nextCursor).toBe("cursor-2")
    expect(fixture.archive.state().continuationError).toBe(before.continuationError)
  })

  test(`${method} reports progress as (done, total) once per id`, async () => {
    const fixture = bulkFixture(kind, {
      behave: (id) => {
        if (id === "b") throw new Error("boom")
      },
    })
    const progress: [number, number][] = []

    await fixture.archive.load()
    await fixture.run(["a", "b", "c"], { onProgress: (done, total) => progress.push([done, total]) })

    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  test(`${method} runs each repeated id once, in first-seen order`, async () => {
    const fixture = bulkFixture(kind)
    const progress: [number, number][] = []

    await fixture.archive.load()
    const result = await fixture.run(["b", "a", "b", "a", "c"], {
      onProgress: (done, total) => progress.push([done, total]),
    })

    expect(fixture.ran).toEqual(["b", "a", "c"])
    expect(result).toEqual({ ok: ["b", "a", "c"], missing: [], failed: [] })
    expect(progress.at(-1)).toEqual([3, 3])
  })

  test(`${method} refuses an empty list without running or notifying`, async () => {
    const fixture = bulkFixture(kind)

    await fixture.archive.load()
    let notices = 0
    fixture.archive.subscribe(() => notices++)

    expect(await fixture.run([])).toBeUndefined()
    expect(fixture.ran).toEqual([])
    expect(notices).toBe(0)
    expect(fixture.archive.bulkRunning()).toBe(false)
  })

  test(`${method} refuses to start before the list is ready`, async () => {
    const fixture = bulkFixture(kind)

    expect(fixture.archive.state().status).toBe("idle")
    expect(await fixture.run(["a"])).toBeUndefined()
    expect(fixture.ran).toEqual([])
  })

  test(`${method} sends an id that is not a loaded row and counts a 404 as missing`, async () => {
    const fixture = bulkFixture(kind, {
      behave: (id) => {
        if (id === "gone") throw notFound()
      },
    })

    await fixture.archive.load()
    const result = await fixture.run(["unloaded", "gone"])

    expect(fixture.ran).toEqual(["unloaded", "gone"])
    expect(result).toEqual({ ok: ["unloaded"], missing: ["gone"], failed: [] })
    expect(fixture.rows()).toEqual(["a", "b", "c", "d"])
  })

  test(`${method} fails a busy id without calling the server, reading busy at call time`, async () => {
    const busy = new Set(["b"])

    const fixture = bulkFixture(kind, {
      isBusy: (id) => busy.has(id),
      behave: (id) => void (id === "a" && busy.add("c")),
    })

    await fixture.archive.load()
    const result = await fixture.run(["a", "b", "c", "d"])

    expect(fixture.ran).toEqual(["a", "d"])
    expect(result).toEqual({ ok: ["a", "d"], missing: [], failed: ["b", "c"] })
    expect(fixture.rows()).toEqual(["b", "c"])
  })

  test(`${method} returns every id failed when offline at the start, without running or touching rows`, async () => {
    let online = false
    const fixture = bulkFixture(kind, { connected: () => online })

    await fixture.archive.load()
    let notices = 0
    fixture.archive.subscribe(() => notices++)
    const result = await fixture.run(["a", "b", "c"])

    expect(result).toEqual({ ok: [], missing: [], failed: ["a", "b", "c"] })
    expect(fixture.ran).toEqual([])
    expect(fixture.rows()).toEqual(["a", "b", "c", "d"])
    expect(fixture.archive.bulkRunning()).toBe(false)
    expect(notices).toBe(0)

    online = true
    expect(await fixture.run(["a"])).toEqual({ ok: ["a"], missing: [], failed: [] })
  })

  test(`${method} fails the rest of the batch when the connection drops mid-batch`, async () => {
    let online = true

    const fixture = bulkFixture(kind, {
      connected: () => online,
      behave: (id) => void (id === "a" && (online = false)),
    })

    await fixture.archive.load()
    const result = await fixture.run(["a", "b", "c"])

    expect(fixture.ran).toEqual(["a"])
    expect(result).toEqual({ ok: ["a"], missing: [], failed: ["b", "c"] })
    expect(fixture.rows()).toEqual(["b", "c", "d"])
  })

  test(`${method} fails the rest of the batch when the server context is replaced mid-batch`, async () => {
    let current = true

    const fixture = bulkFixture(kind, {
      active: () => current,
      behave: (id) => void (id === "a" && (current = false)),
    })

    await fixture.archive.load()
    const result = await fixture.run(["a", "b", "c"])

    expect(fixture.ran).toEqual(["a"])
    expect(result).toEqual({ ok: ["a"], missing: [], failed: ["b", "c"] })
  })

  test(`${method} fails every id without running when the server context is already replaced`, async () => {
    const fixture = bulkFixture(kind, { active: () => false })

    await fixture.archive.load()

    expect(await fixture.run(["a", "b"])).toEqual({ ok: [], missing: [], failed: ["a", "b"] })
    expect(fixture.ran).toEqual([])
    expect(fixture.rows()).toEqual(["a", "b", "c", "d"])
  })

  test(`${method} is refused while a single restore is in flight`, async () => {
    const held = Promise.withResolvers<boolean>()
    const fixture = bulkFixture(kind, { setArchive: () => held.promise })

    await fixture.archive.load()
    const restoring = fixture.archive.restore("a")
    await tick()

    expect(fixture.archive.restoringID()).toBe("a")
    expect(await fixture.run(["b"])).toBeUndefined()
    expect(fixture.ran).toEqual([])
    held.resolve(true)
    await restoring

    expect(await fixture.run(["b"])).toEqual({ ok: ["b"], missing: [], failed: [] })
  })

  test(`${method} is refused while another batch runs, and the running batch finishes`, async () => {
    const hold = Promise.withResolvers<void>()
    const fixture = bulkFixture(kind, { behave: async (id) => void (id === "a" && (await hold.promise)) })

    await fixture.archive.load()
    const first = fixture.run(["a", "b"])
    await tick()

    expect(await fixture.run(["c"])).toBeUndefined()
    expect(fixture.ran).toEqual(["a"])
    hold.resolve()

    expect(await first).toEqual({ ok: ["a", "b"], missing: [], failed: [] })
    expect(fixture.ran).toEqual(["a", "b"])
    expect(fixture.rows()).toEqual(["c", "d"])
  })

  test(`${method} blocks restore, load, loadMore and retryMore while it runs`, async () => {
    const hold = Promise.withResolvers<void>()
    const fixture = bulkFixture(kind, { behave: async () => hold.promise })

    await fixture.archive.load()
    const batch = fixture.run(["a"])
    await tick()

    expect(fixture.archive.bulkRunning()).toBe(true)
    expect(await fixture.archive.restore("c")).toBe(false)
    expect(fixture.archive.restoringID()).toBeUndefined()
    await fixture.archive.load()
    await fixture.archive.loadMore()
    await fixture.archive.retryMore()

    expect(fixture.lists).toHaveLength(1)
    expect(fixture.calls).not.toContain("setArchive")
    expect(fixture.archive.state().status).toBe("ready")
    hold.resolve()
    await batch

    await fixture.archive.loadMore()
    expect(fixture.lists).toHaveLength(2)
    expect(fixture.rows()).toEqual(["b", "c", "d", "later"])
  })

  test(`${method} aborts a held continuation so its late page cannot append rows`, async () => {
    const continuation = Promise.withResolvers<unknown>()
    const hold = Promise.withResolvers<void>()

    const fixture = bulkFixture(kind, {
      list: async (call) =>
        call === 1 ? { data: [session("a"), session("b")], cursor: { next: "cursor-2" } } : continuation.promise,
      behave: async () => hold.promise,
    })

    await fixture.archive.load()
    const append = fixture.archive.loadMore()
    expect(fixture.archive.state()).toMatchObject({ continuationPending: true })

    const batch = fixture.run(["a"])
    await tick()

    expect(fixture.signals[1]?.aborted).toBe(true)
    expect(fixture.archive.state()).toMatchObject({ continuationPending: false })
    hold.resolve()
    await batch
    continuation.resolve({ data: [session("a"), session("late")], cursor: {} })
    await append

    expect(fixture.rows()).toEqual(["b"])
    expect(fixture.archive.state().nextCursor).toBe("cursor-2")
  })

  test(`${method} reports bulkRunning while it runs and releases it afterwards`, async () => {
    const inside: boolean[] = []
    const fixture = bulkFixture(kind, { behave: (_id, archive) => void inside.push(archive.bulkRunning()) })

    await fixture.archive.load()
    expect(fixture.archive.bulkRunning()).toBe(false)
    await fixture.run(["a", "b"])

    expect(inside).toEqual([true, true])
    expect(fixture.archive.bulkRunning()).toBe(false)
  })

  test(`${method} releases bulkRunning when the dependency throws`, async () => {
    const fixture = bulkFixture(kind, {
      behave: () => {
        throw new Error("boom")
      },
    })

    await fixture.archive.load()
    expect(await fixture.run(["a"])).toEqual({ ok: [], missing: [], failed: ["a"] })
    expect(fixture.archive.bulkRunning()).toBe(false)
  })

  test(`${method} keeps calling the server after dispose, returns its result and notifies nobody`, async () => {
    const hold = Promise.withResolvers<void>()
    const fixture = bulkFixture(kind, { behave: async (id) => void (id === "a" && (await hold.promise)) })

    await fixture.archive.load()
    const batch = fixture.run(["a", "b", "c"])
    await tick()
    fixture.archive.dispose()
    // dispose clears the listeners, so a listener added afterwards observes any notify the batch still makes.
    let notices = 0
    fixture.archive.subscribe(() => notices++)
    hold.resolve()

    expect(await batch).toEqual({ ok: ["a", "b", "c"], missing: [], failed: [] })
    expect(fixture.ran).toEqual(["a", "b", "c"])
    expect(notices).toBe(0)
  })

  test(`${method} is refused after dispose`, async () => {
    const fixture = bulkFixture(kind)

    await fixture.archive.load()
    fixture.archive.dispose()

    expect(await fixture.run(["a"])).toBeUndefined()
    expect(fixture.ran).toEqual([])
  })

  test(`${method} never opens a project or a tab and never closes the dialog`, async () => {
    const fixture = bulkFixture(kind)

    await fixture.archive.load()
    await fixture.run(["a", "b"])

    expect(fixture.calls).toEqual([])
  })
}

test("restoreMany sends each id to unarchive for the captured server and never to remove", async () => {
  const fixture = bulkFixture("restore")

  await fixture.archive.load()
  await fixture.archive.restoreMany(["a", "b"])

  expect(fixture.targets).toEqual([
    { server: "captured-server", sessionID: "a" },
    { server: "captured-server", sessionID: "b" },
  ])
  expect(fixture.wrong).toEqual([])
})

test("removeMany sends each id to remove and never to unarchive", async () => {
  const fixture = bulkFixture("remove")

  await fixture.archive.load()
  await fixture.archive.removeMany(["a", "b"])

  expect(fixture.ran).toEqual(["a", "b"])
  expect(fixture.wrong).toEqual([])
})

test("restoreMany counts a pending attempt as failed and keeps its row", async () => {
  const fixture = bulkFixture("restore", {
    attempt: (id) => (id === "a" ? { status: "pending" } : { status: "archived" }),
  })

  await fixture.archive.load()
  const result = await fixture.archive.restoreMany(["a", "b"])

  expect(result).toEqual({ ok: ["b"], missing: [], failed: ["a"] })
  expect(fixture.rows()).toEqual(["a", "c", "d"])
})

test("restoreMany counts a failed attempt as failed and rethrows its not-found error as missing", async () => {
  const fixture = bulkFixture("restore", {
    attempt: (id) =>
      id === "a" ? { status: "failed", error: new Error("boom") } : { status: "failed", error: notFound() },
  })

  await fixture.archive.load()
  const result = await fixture.archive.restoreMany(["a", "b"])

  expect(result).toEqual({ ok: [], missing: ["b"], failed: ["a"] })
  expect(fixture.rows()).toEqual(["a", "c", "d"])
})

test("removeMany is refused while a restoreMany batch runs, and the other way round", async () => {
  const hold = Promise.withResolvers<void>()
  const fixture = bulkFixture("restore", { behave: async () => hold.promise })

  await fixture.archive.load()
  const batch = fixture.archive.restoreMany(["a"])
  await tick()

  expect(await fixture.archive.removeMany(["b"])).toBeUndefined()
  expect(fixture.wrong).toEqual([])
  hold.resolve()
  await batch

  expect(await fixture.archive.removeMany(["b"])).toMatchObject({ ok: ["b"] })
  expect(fixture.wrong).toEqual(["b"])
})
