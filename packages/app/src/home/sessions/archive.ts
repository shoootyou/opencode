import { notifySessionTabsRemoved } from "@/shell/titlebar/session-events"
import type { ServerConnection } from "@/runtime/server/registry"
import type { SessionInfo } from "@opencode/client/promise"

type HomeSession = Pick<SessionInfo, "id" | "location">

export async function archiveHomeSession(input: {
  server: ServerConnection.Key
  session: HomeSession
  archive: (input: { sessionID: string; archive: number }) => Promise<unknown>
  commit: (archivedAt: number) => void
  onError?: (error: unknown) => void
}) {
  const archivedAt = Date.now()

  try {
    await input.archive({ sessionID: input.session.id, archive: archivedAt })
    input.commit(archivedAt)
    notifySessionTabsRemoved({
      server: input.server,
      directory: input.session.location.directory,
      sessionIDs: [input.session.id],
    })

    return true
  } catch (error) {
    input.onError?.(error)

    return false
  }
}
