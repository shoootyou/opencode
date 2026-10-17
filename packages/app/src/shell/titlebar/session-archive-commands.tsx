import { createEffect, createSignal } from "solid-js"
import { useCommand } from "@/shell/commands/command"
import { useLayout } from "@/shell/state/layout"
import { useGlobal } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { useTabs } from "@/shell/tabs/tabs"
import { ServerConnection } from "@/runtime/server/registry"
import { createArchiveCommandRegistration } from "./session-archive-commands-model"
import { showArchivedSessionsDialog } from "./dialog-archived-sessions"

export function useTitlebarArchiveCommands(): void {
  const command = useCommand()
  const layout = useLayout()
  const global = useGlobal()
  const language = useLanguage()
  const tabs = useTabs()
  const [version, setVersion] = createSignal(0)
  const registration = createArchiveCommandRegistration({
    read: () => {
      version()
      const route = layout.route()
      const servers = global.servers.list().map(ServerConnection.key)
      const selectedServer = layout.home.selection().server
      const normalized = route.type === "session"
        ? { type: "session" as const, server: route.server, sessionID: route.sessionId }
        : route.type === "draft"
          ? (() => { const draft = tabs.store.find((tab) => tab.type === "draft" && tab.draftID === route.draftID); return draft ? { type: "draft" as const, server: draft.server } : { type: "draft" as const } })()
          : route
      if (route.type !== "session") return { route: normalized, servers, selectedServer, pending: false }
      const session = global.serverCtx(route.server)?.data.session.get(route.sessionId)
      return { route: normalized, servers, selectedServer, session: session ? { server: route.server, info: session } : undefined, pending: session ? global.sessionArchive.isPending({ server: route.server, sessionID: session.id }) : false }
    },
    t: language.t,
    archive: (target) => global.sessionArchive.archiveSession(target),
    unarchive: (target) => global.sessionArchive.setSessionArchive({ ...target, archive: null }),
    browse: (server) => showArchivedSessionsDialog(server),
  })
  createEffect(() => global.sessionArchive.isPending({ server: "", sessionID: "" }) || setVersion((value) => value + 1))
  command.register(registration.key, registration.options)
}
