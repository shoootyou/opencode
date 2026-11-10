export type ArchiveTarget = Readonly<{ server: string; sessionID: string }>

export type ArchiveRequest = ArchiveTarget & Readonly<{ archived: boolean }>

export type ArchiveSession = Readonly<{
  id: string
  parentID?: string | null
  title?: string
  location: Readonly<{ directory: string }>
  time: Readonly<{ archived?: number | null; updated?: number }>
}>

export type ArchiveTabsRemoved = Readonly<{ server: string; directory: string; sessionIDs: readonly string[] }>

export type ArchiveNotice = Readonly<{ kind: "update" | "refresh" | "navigation"; error: unknown }>

export type ArchiveAttempt =
  | Readonly<{ status: "archived" }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "failed"; error: unknown }>

export type SetSessionArchive = (input: ArchiveRequest) => Promise<boolean>

export type ArchiveActions = Readonly<{
  setSessionArchive: SetSessionArchive
  archiveSession: (target: ArchiveTarget) => Promise<boolean>
  archiveSessionQuiet: (target: ArchiveTarget) => Promise<ArchiveAttempt>
  unarchiveSessionQuiet: (target: ArchiveTarget) => Promise<ArchiveAttempt>
  isPending: (target: ArchiveTarget) => boolean
}>

export function createSessionArchiveActions(
  deps: Readonly<{
    update: (input: ArchiveRequest) => Promise<void>
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- The refresh result is deliberately ignored; callers observe only whether it completes or throws.
    sync: (target: ArchiveTarget) => Promise<unknown>
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Toast renderers may return framework-owned values that this boundary intentionally ignores.
    toast: (notice: ArchiveNotice) => unknown
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Notification listeners may return framework-owned values that this boundary intentionally ignores.
    onPendingChange?: () => unknown
  }>,
): ArchiveActions {
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

  const run = async (input: ArchiveRequest, notifyRefresh = false): Promise<ArchiveAttempt> => {
    const target = { server: input.server, sessionID: input.sessionID }

    if (isPending(target)) return { status: "pending" }
    setPending(target, true)

    try {
      try {
        await deps.update(input)
      } catch (error) {
        return { status: "failed", error }
      }

      try {
        await deps.sync(target)
      } catch (error) {
        if (notifyRefresh) deps.toast({ kind: "refresh", error })
      }

      return { status: "archived" }
    } finally {
      setPending(target, false)
    }
  }

  const setSessionArchive: SetSessionArchive = async (input) => {
    const attempt = await run(input, true)

    if (attempt.status === "failed") deps.toast({ kind: "update", error: attempt.error })

    return attempt.status === "archived"
  }

  return {
    setSessionArchive,
    archiveSession: (target) => setSessionArchive({ ...target, archived: true }),
    archiveSessionQuiet: (target) => run({ ...target, archived: true }),
    unarchiveSessionQuiet: (target) => run({ ...target, archived: false }),
    isPending,
  }
}

export function isArchivedSession(session: ArchiveSession): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: server session payloads model archive timestamps as optional numbers; this predicate is the boundary that distinguishes archived records.
  return typeof session.time.archived === "number"
}

export function isSessionVisibleInPalette(session: ArchiveSession): boolean {
  return !isArchivedSession(session)
}

export function canOpenReferencedSession(session: ArchiveSession | undefined): session is ArchiveSession {
  return !!session && !isArchivedSession(session)
}
