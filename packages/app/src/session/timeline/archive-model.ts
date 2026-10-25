import {
  isArchivedSession,
  type ArchiveNotice,
  type ArchiveSession,
  type ArchiveTabsRemoved,
  type ArchiveTarget,
  type SetSessionArchive,
} from "@/session/archive"

export type ArchiveLanding =
  | Readonly<{ type: "session"; server: string; sessionID: string }>
  | Readonly<{ type: "draft"; server: string; directory: string }>

export function archiveLabelKey(session: ArchiveSession | undefined): "common.archive" | "common.unarchive" {
  return session && isArchivedSession(session) ? "common.unarchive" : "common.archive"
}

export function snapshotArchiveNeighbour(
  input: Readonly<{ target: ArchiveTarget; directory: string; sessions: readonly ArchiveSession[] }>,
): ArchiveLanding {
  const sessions = input.sessions.filter((session) => !session.parentID && !isArchivedSession(session))
  const index = sessions.findIndex((session) => session.id === input.target.sessionID)
  const neighbour = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

  return neighbour
    ? { type: "session", server: input.target.server, sessionID: neighbour.id }
    : { type: "draft", server: input.target.server, directory: input.directory }
}

export function isArchiveRouteCurrent(
  target: ArchiveTarget,
  current: Readonly<{ server: string; sessionID: string }> | undefined,
): boolean {
  return current?.server === target.server && current.sessionID === target.sessionID
}

export function createArchiveLandingEffects(
  deps: Readonly<{
    removeSessions: (detail: ArchiveTabsRemoved, options: Readonly<{ navigate: false }>) => void
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Navigation completion matters here; router-owned fulfillment values do not.
    navigate: (landing: ArchiveLanding) => void | Promise<unknown>
  }>,
) {
  return {
    removeTabs(detail: ArchiveTabsRemoved & Readonly<{ navigate: false }>) {
      const { navigate: _, ...removed } = detail
      deps.removeSessions(removed, { navigate: false })
    },
    navigate: deps.navigate,
  }
}

export async function runTimelineArchive(
  input: Readonly<{ target: ArchiveTarget; session: ArchiveSession; sessions: readonly ArchiveSession[] }>,
  deps: Readonly<{
    setArchive: SetSessionArchive
    now: () => number
    isActive: () => boolean
    currentRoute: () => Readonly<{ server: string; sessionID: string }> | undefined
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Navigation completion matters here; router-owned fulfillment values do not.
    navigate: (landing: ArchiveLanding) => void | Promise<unknown>
    removeTabs: (detail: ArchiveTabsRemoved & Readonly<{ navigate: false }>) => void
    toast: (notice: ArchiveNotice) => void
  }>,
): Promise<boolean> {
  if (input.session.id !== input.target.sessionID || input.session.parentID || !deps.isActive()) return false

  if (isArchivedSession(input.session)) return deps.setArchive({ ...input.target, archive: null })

  const landing = snapshotArchiveNeighbour({
    target: input.target,
    directory: input.session.location.directory,
    sessions: input.sessions,
  })

  const committed = await deps.setArchive({ ...input.target, archive: deps.now() })

  if (!committed || !deps.isActive()) return committed
  const current = isArchiveRouteCurrent(input.target, deps.currentRoute())
  deps.removeTabs({
    server: input.target.server,
    directory: input.session.location.directory,
    sessionIDs: [input.target.sessionID],
    navigate: false,
  })

  if (current) {
    try {
      await deps.navigate(landing)
    } catch (error) {
      deps.toast({ kind: "navigation", error })
    }
  }

  return true
}
