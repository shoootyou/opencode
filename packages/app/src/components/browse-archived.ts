import { type Session } from "@opencode-ai/sdk/v2/client"

export type ArchivedEntry = {
  id: string
  title: string
  directory: string
  archivedAt: number
  session: Session
}

// Builds the rows for the "browse archived sessions" discovery dialog. Roots only (children carry
// a parentID), archived only, most-recently-archived first.
export function buildArchivedSessionEntries(sessions: Session[], fallbackTitle: string): ArchivedEntry[] {
  return sessions
    .filter((session) => !session.parentID)
    // Guard with `!= null` so an epoch-0 archived timestamp is retained as a valid archived
    // session; only `undefined`/`null` means "not archived".
    .filter((session) => session.time.archived != null)
    .map((session) => ({
      id: session.id,
      title: session.title || fallbackTitle,
      directory: session.directory,
      archivedAt: session.time.archived as number,
      session,
    }))
    .sort((a, b) => b.archivedAt - a.archivedAt)
}
