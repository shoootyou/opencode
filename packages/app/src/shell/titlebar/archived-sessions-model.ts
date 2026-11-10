import { offlineResult, runBulk, skipId, type BulkResult } from "@/home/sessions/bulk"
import {
  isArchivedSession,
  type ArchiveAttempt,
  type ArchiveSession,
  type ArchiveTarget,
  type SetSessionArchive,
} from "@/session/archive"

// oxlint-disable anti-slop/require-readable-spacing -- Compact state transitions keep each cursor operation auditable as one unit.

export type ArchivedSessionsState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{
      status: "ready"
      rows: readonly ArchiveSession[]
      nextCursor?: string
      continuationPending: boolean
      continuationError?: unknown
    }>
  | Readonly<{ status: "error"; error: unknown }>

export type ArchivedSessionsModel = Readonly<{
  state: () => ArchivedSessionsState
  subscribe: (listener: () => void) => () => void
  load: () => Promise<void>
  loadMore: () => Promise<void>
  retryMore: () => Promise<void>
  search: (query: string) => readonly ArchiveSession[]
  restoringID: () => string | undefined
  restore: (sessionID: string) => Promise<boolean>
  bulkRunning: () => boolean
  restoreMany: (ids: readonly string[], options?: ManyOptions) => Promise<BulkResult | undefined>
  removeMany: (ids: readonly string[], options?: ManyOptions) => Promise<BulkResult | undefined>
  dispose: () => void
}>

type ManyOptions = Readonly<{ onProgress?: (done: number, total: number) => void }>

type ArchiveList = (
  input?: { archived?: boolean; parentID?: null; order?: "desc"; limit?: number; cursor?: string },
  options?: { signal?: AbortSignal },
) => Promise<{ data: ArchiveSession[]; cursor: { previous?: string | null; next?: string | null } }>

export async function loadArchivedSessions(
  api: Readonly<{ list: ArchiveList }>,
  input: Readonly<{ signal: AbortSignal; cursor?: string }>,
): Promise<Readonly<{ sessions: readonly ArchiveSession[]; cursor: Readonly<{ next?: string }> }>> {
  const response = await api.list(
    {
      archived: true,
      parentID: null,
      order: "desc",
      limit: 50,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve the API's existing omission of cursor when it is absent.
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
    { signal: input.signal },
  )

  if (response.data.length > 50 || response.data.some((session) => session.parentID || !isArchivedSession(session)))
    throw new Error("Invalid archived session page")

  return {
    sessions: response.data,
    cursor: {
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve the API's optional cursor contract.
      ...(response.cursor.next ? { next: response.cursor.next } : {}),
    },
  }
}

export function matchesArchivedSession(session: ArchiveSession, query: string): boolean {
  if (session.parentID || !isArchivedSession(session)) return false
  const search = query.trim().toLowerCase()

  return (
    !search ||
    (session.title ?? "").toLowerCase().includes(search) ||
    session.location.directory.toLowerCase().includes(search)
  )
}

export function createArchivedSessionsModel<Tab>(
  deps: Readonly<{
    server: string
    list: ArchiveList
    setArchive: SetSessionArchive
    openProject: (input: Readonly<{ server: string; directory: string }>) => Promise<unknown>
    touchProject: (input: Readonly<{ server: string; directory: string }>) => void
    addTab: (input: Readonly<{ server: string; sessionId: string }>) => Tab
    selectTab: (tab: Tab) => void
    close: () => void
    unarchive: (target: ArchiveTarget) => Promise<ArchiveAttempt>
    remove: (sessionID: string) => Promise<void>
    connected: () => boolean
    isBusy: (sessionID: string) => boolean
    active: () => boolean
  }>,
): ArchivedSessionsModel {
  let value: ArchivedSessionsState = { status: "idle" }
  let restoring: string | undefined
  let bulk = false
  let controller: AbortController | undefined
  let generation = 0
  let disposed = false
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const state = () => value
  const busy = () => restoring !== undefined || bulk

  const load = async () => {
    if (disposed || busy()) return
    controller?.abort()
    const current = new AbortController()
    controller = current
    const version = ++generation
    consumed.clear()
    value = { status: "loading" }
    notify()

    try {
      const page = await loadArchivedSessions({ list: deps.list }, { signal: current.signal })

      if (disposed || version !== generation) return
      const seen = new Set<string>()
      const rows = page.sessions.filter((session) => {
        if (seen.has(session.id)) return false
        seen.add(session.id)
        return true
      })
      value = {
        status: "ready",
        rows,
        nextCursor: rows.length ? page.cursor.next : undefined,
        continuationPending: false,
      }
      notify()
    } catch (error) {
      if (disposed || version !== generation || current.signal.aborted) return
      value = { status: "error", error }
      notify()
    }
  }

  const loadMore = async () => {
    if (disposed || busy() || value.status !== "ready" || value.continuationPending || !value.nextCursor) return

    const cursor = value.nextCursor
    const current = new AbortController()
    controller?.abort()
    controller = current
    const version = ++generation
    value = { ...value, continuationPending: true, continuationError: undefined }
    notify()

    try {
      const page = await loadArchivedSessions({ list: deps.list }, { signal: current.signal, cursor })

      if (disposed || version !== generation) return

      if (page.sessions.length === 0) {
        value = { ...value, nextCursor: undefined, continuationPending: false, continuationError: undefined }
        notify()

        return
      }

      const rows = value.rows
      const existing = new Set(rows.map((session) => session.id))
      const appended = page.sessions.filter((session) => {
        if (existing.has(session.id)) return false
        existing.add(session.id)
        return true
      })
      const repeatedCursor = page.cursor.next === cursor || (page.cursor.next && consumed.has(page.cursor.next))

      if (appended.length === 0 || repeatedCursor) {
        value = {
          ...value,
          continuationPending: false,
          continuationError: new Error("Archived session continuation made no progress"),
        }
        notify()

        return
      }

      consumed.add(cursor)
      value = {
        status: "ready",
        rows: [...rows, ...appended],
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Keep the cursor absent once the backend exhausts the archive.
        ...(page.cursor.next ? { nextCursor: page.cursor.next } : {}),
        continuationPending: false,
      }
      notify()
    } catch (error) {
      if (disposed || version !== generation || current.signal.aborted) return
      value = { ...value, continuationPending: false, continuationError: error }
      notify()
    }
  }

  const consumed = new Set<string>()

  // Aborting the continuation and bumping `generation` keeps a late page from re-adding rows the batch removes.
  const runMany = async (
    input: readonly string[],
    op: (id: string) => Promise<void>,
    options: ManyOptions = {},
  ): Promise<BulkResult | undefined> => {
    const ids = [...new Set(input)]

    if (disposed || busy() || value.status !== "ready" || ids.length === 0) return undefined
    if (!deps.connected()) return offlineResult(ids)
    bulk = true
    controller?.abort()
    ++generation
    value = { ...value, continuationPending: false }
    notify()

    try {
      const result = await runBulk(ids, op, {
        isBusy: (id) => skipId(deps.connected(), deps.isBusy(id)),
        proceed: deps.active,
        onProgress: options.onProgress,
      })
      const gone = new Set([...result.ok, ...result.missing])

      if (value.status === "ready") value = { ...value, rows: value.rows.filter((row) => !gone.has(row.id)) }

      return result
    } finally {
      bulk = false

      if (!disposed) notify()
    }
  }

  return {
    state,
    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    load,
    loadMore: () => loadMore(),
    retryMore: () => (value.status === "error" ? load() : loadMore()),
    search(query) {
      return value.status === "ready" ? value.rows.filter((session) => matchesArchivedSession(session, query)) : []
    },
    restoringID: () => restoring,
    bulkRunning: () => bulk,
    restoreMany: (ids, options) =>
      runMany(
        ids,
        async (sessionID) => {
          const attempt = await deps.unarchive({ server: deps.server, sessionID })

          if (attempt.status === "failed") throw attempt.error

          if (attempt.status === "pending") throw new Error("Archive already in progress")
        },
        options,
      ),
    removeMany: (ids, options) => runMany(ids, (sessionID) => deps.remove(sessionID), options),
    async restore(sessionID) {
      if (disposed || busy() || value.status !== "ready") return false
      const session = value.rows.find((item) => item.id === sessionID)

      if (!session || !isArchivedSession(session)) return false
      controller?.abort()
      const version = ++generation
      restoring = sessionID
      value = { ...value, continuationPending: false }
      notify()

      try {
        const committed = await deps.setArchive({ server: deps.server, sessionID, archived: false })

        if (!committed) return false

        if (disposed || version !== generation) return true
        value = {
          status: "ready",
          rows: value.rows.filter((item) => item.id !== sessionID),
          nextCursor: value.nextCursor,
          continuationPending: false,
          continuationError: value.continuationError,
        }
        await deps.openProject({ server: deps.server, directory: session.location.directory })
        if (disposed || version !== generation) return true
        deps.touchProject({ server: deps.server, directory: session.location.directory })
        const tab = deps.addTab({ server: deps.server, sessionId: sessionID })
        deps.selectTab(tab)
        deps.close()

        return true
      } finally {
        restoring = undefined

        if (!disposed) notify()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      ++generation
      controller?.abort()
      listeners.clear()
    },
  }
}
