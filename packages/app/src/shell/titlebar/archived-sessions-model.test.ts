/**
 * @spec-handoff
 * @interface createArchivedSessionsModel(deps): { load(): Promise<void>; loadMore(): Promise<void>; retryMore(): Promise<void> }
 * @behavior
 *   - Loads one archived:true root batch of 50, then appends unique continuation rows in response order.
 *   - Guards concurrent continuation, retains rows on recoverable continuation failure, and retries its same cursor.
 *   - Ignores stale, disposed, reset, and restore-aborted append completions.
 *   - Keeps first row objects, terminates an empty root batch, and searches retained rows without fetching.
 * @edge-cases
 *   - Empty or cursorless batches exhaust; short nonempty batches with a cursor remain continuable; restore sends archived:false.
 *   - Repeated cursors and duplicate-only batches pause with a recoverable error rather than exhausting.
 * @see RFC 057 D.3.1-9, AP1, AP4-7
 */
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these controlled black-box fixtures deliberately capture the opaque SDK request and assert the proposed model contract before its typed API exists.
import { expect, test } from "bun:test"
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

const session = (id: string, archived = 1) => ({ id, title: id, location: { directory: `/${id}` }, time: { archived } })

function model(list: (input: unknown) => Promise<unknown>) {
  return createArchivedSessionsModel({
    server: "captured-server",
    list: async (input: unknown) => list(input) as never,
    setArchive: async () => true,
    openProject: () => {},
    touchProject: () => {},
    addTab: () => "tab",
    selectTab: () => {},
    close: () => {},
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
    openProject: () => calls.push("open"),
    touchProject: () => calls.push("touch"),
    addTab: () => {
      calls.push("tab")
      return "tab"
    },
    selectTab: () => calls.push("select"),
    close: () => calls.push("close"),
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
    openProject: () => calls.push("open"),
    touchProject: () => calls.push("touch"),
    addTab: () => {
      calls.push("tab")
      return "tab"
    },
    selectTab: () => calls.push("select"),
    close: () => calls.push("close"),
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
    openProject: () => {},
    touchProject: () => {},
    addTab: () => "tab",
    selectTab: () => {},
    close: () => {},
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
      openProject: () => {},
      touchProject: () => {},
      addTab: () => "tab",
      selectTab: () => {},
      close: () => {},
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
