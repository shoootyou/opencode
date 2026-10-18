import { isArchivedSession, type ArchiveSession, type SetSessionArchive } from "@/session/archive"

export type ArchivedPage = Readonly<{ sessions: readonly ArchiveSession[]; cursor: Readonly<{ previous?: string; next?: string }> }>
export type ArchivedSessionsState = Readonly<{ status: "idle" }> | Readonly<{ status: "loading" }> | Readonly<{ status: "ready"; page: ArchivedPage }> | Readonly<{ status: "error"; error: unknown }>
export type ArchivedSessionsModel = Readonly<{ state: () => ArchivedSessionsState; subscribe: (listener: () => void) => () => void; load: () => Promise<void>; next: () => Promise<void>; previous: () => Promise<void>; search: (query: string) => readonly ArchiveSession[]; restoringID: () => string | undefined; restore: (sessionID: string) => Promise<boolean>; dispose: () => void }>
type ArchiveList = (input?: { archived?: "only"; parentID?: null; order?: "desc"; limit?: number; cursor?: string }, options?: { signal?: AbortSignal }) => Promise<{ data: ArchiveSession[]; cursor: { previous?: string | null; next?: string | null } }>

export async function loadArchivedSessions(api: Readonly<{ list: ArchiveList }>, input: Readonly<{ signal: AbortSignal; cursor?: string }>): Promise<ArchivedPage> {
  const response = await api.list({ archived: "only", parentID: null, order: "desc", limit: 50, ...(input.cursor ? { cursor: input.cursor } : {}) }, { signal: input.signal })
  if (response.data.length > 50 || response.data.some((session) => session.parentID || !isArchivedSession(session)))
    throw new Error("Invalid archived session page")
  return { sessions: response.data, cursor: { ...(response.cursor.previous ? { previous: response.cursor.previous } : {}), ...(response.cursor.next ? { next: response.cursor.next } : {}) } }
}

export function matchesArchivedSession(session: ArchiveSession, query: string): boolean {
  if (session.parentID || !isArchivedSession(session)) return false
  const search = query.trim().toLowerCase()
  return !search || (session.title ?? "").toLowerCase().includes(search) || session.location.directory.toLowerCase().includes(search)
}

export function createArchivedSessionsModel<Tab>(deps: Readonly<{ server: string; list: ArchiveList; setArchive: SetSessionArchive; openProject: (input: Readonly<{ server: string; directory: string }>) => void; touchProject: (input: Readonly<{ server: string; directory: string }>) => void; addTab: (input: Readonly<{ server: string; sessionId: string }>) => Tab; selectTab: (tab: Tab) => void; close: () => void }>): ArchivedSessionsModel {
  let value: ArchivedSessionsState = { status: "idle" }
  let restoring: string | undefined
  let controller: AbortController | undefined
  let generation = 0
  let disposed = false
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const state = () => value
  const load = async (cursor?: string) => {
    if (disposed) return
    controller?.abort()
    const current = new AbortController()
    controller = current
    const version = ++generation
    value = { status: "loading" }
    notify()
    try {
      const page = await loadArchivedSessions({ list: deps.list }, { signal: current.signal, cursor })
      if (disposed || version !== generation) return
      value = { status: "ready", page }
      notify()
    } catch (error) {
      if (disposed || version !== generation || current.signal.aborted) return
      value = { status: "error", error }
      notify()
    }
  }
  return {
    state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    load,
    next: () => value.status === "ready" && value.page.cursor.next ? load(value.page.cursor.next) : Promise.resolve(),
    previous: () => value.status === "ready" && value.page.cursor.previous ? load(value.page.cursor.previous) : Promise.resolve(),
    search(query) { return value.status === "ready" ? value.page.sessions.filter((session) => matchesArchivedSession(session, query)) : [] },
    restoringID: () => restoring,
    async restore(sessionID) {
      if (disposed || restoring || value.status !== "ready") return false
      const session = value.page.sessions.find((item) => item.id === sessionID)
      if (!session || !isArchivedSession(session)) return false
      const version = generation
      restoring = sessionID
      notify()
      const committed = await deps.setArchive({ server: deps.server, sessionID, archive: null })
      if (!committed) { restoring = undefined; notify(); return false }
      if (disposed || version !== generation) return true
      restoring = undefined
      value = { status: "ready", page: { ...value.page, sessions: value.page.sessions.filter((item) => item.id !== sessionID) } }
      notify()
      deps.openProject({ server: deps.server, directory: session.location.directory })
      deps.touchProject({ server: deps.server, directory: session.location.directory })
      const tab = deps.addTab({ server: deps.server, sessionId: sessionID })
      deps.selectTab(tab)
      deps.close()
      return true
    },
    dispose() { if (disposed) return; disposed = true; ++generation; controller?.abort(); listeners.clear() },
  }
}
