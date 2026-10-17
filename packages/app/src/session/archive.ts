export type ArchiveTarget = Readonly<{ server: string; sessionID: string }>
export type ArchiveRequest = ArchiveTarget & Readonly<{ archive: number | null }>
export type ArchiveSession = Readonly<{ id: string; parentID?: string | null; title?: string; location: Readonly<{ directory: string }>; time: Readonly<{ archived?: number | null; updated?: number }> }>
export type ArchiveTabsRemoved = Readonly<{ server: string; directory: string; sessionIDs: readonly string[] }>
export type ArchiveNotice = Readonly<{ kind: "update" | "refresh" | "navigation"; error: unknown }>
export type SetSessionArchive = (input: ArchiveRequest) => Promise<boolean>
export type ArchiveActions = Readonly<{ setSessionArchive: SetSessionArchive; archiveSession: (target: ArchiveTarget) => Promise<boolean>; isPending: (target: ArchiveTarget) => boolean }>
export function createSessionArchiveActions(deps: Readonly<{ update: (input: ArchiveRequest) => Promise<void>; sync: (target: ArchiveTarget) => Promise<unknown>; toast: (notice: ArchiveNotice) => unknown; now: () => number; onPendingChange?: () => unknown }>): ArchiveActions {
  const pending = new Map<string, Set<string>>()

  const isPending = (target: ArchiveTarget) => pending.get(target.server)?.has(target.sessionID) ?? false
  const setPending = (target: ArchiveTarget, value: boolean) => {
    const sessions = pending.get(target.server) ?? new Set<string>()
    if (value) {
      sessions.add(target.sessionID)
      pending.set(target.server, sessions)
    } else {
      sessions.delete(target.sessionID)
      if (sessions.size === 0) pending.delete(target.server)
    }
    deps.onPendingChange?.()
  }
  const setSessionArchive: SetSessionArchive = async (input) => {
    const target = { server: input.server, sessionID: input.sessionID }
    if (isPending(target)) return false
    setPending(target, true)
    try {
      await deps.update(input)
    } catch (error) {
      deps.toast({ kind: "update", error })
      return false
    }
    try {
      await deps.sync(target)
    } catch (error) {
      deps.toast({ kind: "refresh", error })
    } finally {
      setPending(target, false)
    }
    return true
  }

  return { setSessionArchive, archiveSession: (target) => setSessionArchive({ ...target, archive: deps.now() }), isPending }
}

export function isArchivedSession(session: ArchiveSession): boolean {
  return typeof session.time.archived === "number"
}

export function isSessionVisibleInPalette(session: ArchiveSession): boolean {
  return !isArchivedSession(session)
}

export function canOpenReferencedSession(session: ArchiveSession | undefined): session is ArchiveSession {
  return !!session && !isArchivedSession(session)
}
