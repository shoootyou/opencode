import type { SessionInfo, SessionListInput, SessionListOutput } from "@opencode/client"

export type ArchivedEntry<T extends SessionInfo = SessionInfo> = {
  id: string
  title: string
  directory: string
  archivedAt: number
  session: T
}

export function buildArchivedSessionEntries<T extends SessionInfo>(
  sessions: T[],
  fallbackTitle: string,
): ArchivedEntry<T>[] {
  return (
    sessions
      .filter((session) => session.parentID == null)
      .filter(
        (session): session is T & { time: T["time"] & { archived: number } } =>
          typeof session.time.archived === "number",
      )
      .map((session) => ({
        id: session.id,
        title: session.title || fallbackTitle,
        directory: session.location?.directory ?? "",
        archivedAt: session.time.archived,
        session,
      }))
      .sort((a, b) => b.archivedAt - a.archivedAt || a.id.localeCompare(b.id))
  )
}

export async function loadArchivedSessionEntries(
  list: (input: SessionListInput) => Promise<SessionListOutput>,
  fallbackTitle: string,
): Promise<ArchivedEntry[]> {
  const sessions: SessionInfo[] = []
  const seen = new Set<string>()
  let input: SessionListInput = { archived: true, parentID: null }

  while (true) {
    const page = await list(input)
    sessions.push(...page.data)

    const cursor = page.cursor.next
    if (cursor == null) return buildArchivedSessionEntries(sessions, fallbackTitle)
    if (seen.has(cursor)) throw new Error(`Repeated archived-session cursor: ${JSON.stringify(cursor)}`)

    seen.add(cursor)
    input = { archived: true, parentID: null, cursor }
  }
}
