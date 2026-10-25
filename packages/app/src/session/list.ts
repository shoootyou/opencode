import type { SessionApi, SessionInfo, SessionListInput } from "@opencode/client/promise"

export async function listAllSessions(
  api: Pick<SessionApi, "list">,
  input: Omit<SessionListInput, "cursor">,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<SessionInfo[]> {
  const throwIfAborted = () => {
    if (options?.signal?.aborted) {
      const error = new Error("AbortError")
      error.name = "AbortError"
      throw error
    }
  }

  const sessions: SessionInfo[] = []
  const seenIDs = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    throwIfAborted()

    if (cursor && seenCursors.has(cursor)) throw new Error("Repeated session list cursor")

    if (cursor) seenCursors.add(cursor)
    const result = await api.list({ ...input, limit: input.limit ?? 100, cursor }, { signal: options?.signal })
    throwIfAborted()

    for (const session of result.data)
      if (!seenIDs.has(session.id)) {
        seenIDs.add(session.id)
        sessions.push(session)
      }

    if (result.data.length === 0) return sessions
    cursor = result.cursor.next ?? undefined
  } while (cursor)

  return sessions
}
