import { useCommand } from "@/shell/commands/command"
import { useLayout } from "@/shell/state/layout"
import { useGlobal } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { useTabs } from "@/shell/tabs/tabs"
import { ServerConnection } from "@/runtime/server/registry"
import { createArchiveCommandRegistration } from "./session-archive-commands-model"
import { showArchivedSessionsDialog } from "./dialog-archived-sessions"
import { useDialog } from "@opencode/ui/context/dialog"
import { createArchiveLandingEffects, runTimelineArchive } from "@/session/timeline/archive-model"
import { onCleanup } from "solid-js"

export function useTitlebarArchiveCommands(): void {
  let alive = true
  onCleanup(() => (alive = false))
  const command = useCommand()
  const layout = useLayout()
  const global = useGlobal()
  const language = useLanguage()
  const tabs = useTabs()
  const dialog = useDialog()

  const registration = createArchiveCommandRegistration({
    read: () => {
      const route = layout.route()
      const servers = global.servers.list().map(ServerConnection.key)
      const selectedServer = layout.home.selection().server

      const normalized =
        // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- The route discriminant is a synchronous UI state, not an Effect result.
        route.type === "session"
          ? { type: "session" as const, server: route.server, sessionID: route.sessionId }
          : route.type === "draft"
            ? (() => {
                const draft = tabs.store.find((tab) => tab.type === "draft" && tab.draftID === route.draftID)

                return draft ? { type: "draft" as const, server: draft.server } : { type: "draft" as const }
              })()
            : route

      if (route.type !== "session") return { route: normalized, servers, selectedServer, pending: false }
      const session = global.serverCtx(route.server)?.data.session.get(route.sessionId)

      return {
        route: normalized,
        servers,
        selectedServer,
        session: session ? { server: route.server, info: session } : undefined,
        pending: session ? global.sessionArchive.isPending({ server: route.server, sessionID: session.id }) : false,
      }
    },
    t: language.t,
    transition: async (target) => {
      if (!alive) return false
      // SAFETY: archive command targets are created from ServerConnection.key values in this registration.
      const key = target.server as ServerConnection.Key
      const ctx = global.serverCtx(key)
      const route = layout.route()
      const session = ctx?.data.session.get(target.sessionID)

      if (!ctx || !session || route.type !== "session") return false
      let mutationStarted = false

      const effects = createArchiveLandingEffects({
        removeSessions: (detail, options) =>
          // SAFETY: archive tab removals are created for the current server context.
          tabs.removeSessions(
            { ...detail, server: detail.server as ServerConnection.Key, sessionIDs: [...detail.sessionIDs] },
            options,
          ),
        navigate: async (landing) => {
          if (landing.type === "session") {
            // SAFETY: session landing servers originate from the currently connected tab server.
            tabs.select({
              type: "session",
              server: landing.server as ServerConnection.Key,
              sessionId: landing.sessionID,
            })

            return
          }

          // SAFETY: draft landing servers originate from the currently connected tab server.
          await tabs.newDraft({ server: landing.server as ServerConnection.Key, directory: landing.directory })
        },
      })

      return runTimelineArchive(
        { target, session, sessions: ctx.data.session.list() },
        {
          setArchive: async (input) => {
            mutationStarted = true

            return global.sessionArchive.setSessionArchive(input)
          },
          isActive: () => !mutationStarted || (alive && global.serverCtx(key) === ctx),
          currentRoute: () => {
            const current = layout.route()

            return current.type === "session" ? { server: current.server, sessionID: current.sessionId } : undefined
          },
          removeTabs: effects.removeTabs,
          navigate: effects.navigate,
          toast: () => {},
        },
      )
    },
    unarchive: (target) => global.sessionArchive.setSessionArchive({ ...target, archived: false }),
    browse: (server) => showArchivedSessionsDialog(dialog, server),
  })

  command.register(registration.key, registration.options)
}
