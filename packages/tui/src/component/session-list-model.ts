import { nextArchivedAt } from "../util/session"

export function createSessionListQuery(input: { showArchived: boolean }) {
  return input.showArchived ? { archived: true as const } : {}
}

export function sessionListItem(session: { time: { archived?: number | null } }) {
  return { archived: session.time.archived != null }
}

export function toggleArchivedVisibility(showArchived: boolean) {
  return !showArchived
}

export async function toggleSessionArchive(input: {
  sessionID: string
  archivedAt?: number | null
  now: number
  update(input: { sessionID: string; archive: number | null }): Promise<void>
  refresh(): Promise<void>
}) {
  await input.update({
    sessionID: input.sessionID,
    archive: nextArchivedAt(input.archivedAt, input.now),
  })
  await input.refresh()
}
