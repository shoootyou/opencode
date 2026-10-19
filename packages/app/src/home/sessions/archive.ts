import { isArchivedSession, type ArchiveActions, type ArchiveSession, type ArchiveTabsRemoved } from "@/session/archive"

export async function archiveHomeSession(
  input: Readonly<{ server: string; session: ArchiveSession }>,
  deps: Readonly<{
    archiveSession: ArchiveActions["archiveSession"]
    remove: () => void
    notifyTabsRemoved: (detail: ArchiveTabsRemoved) => void
    isActive: () => boolean
  }>,
): Promise<boolean> {
  if (input.session.parentID || isArchivedSession(input.session) || !deps.isActive()) return false
  const sessionID = input.session.id
  const directory = input.session.location.directory
  const server = input.server
  const committed = await deps.archiveSession({ server, sessionID })

  if (!committed || !deps.isActive()) return committed
  deps.remove()
  deps.notifyTabsRemoved({ server, directory, sessionIDs: [sessionID] })

  return true
}
