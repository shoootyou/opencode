import { DialogArchivedSessions } from "./dialog-archived-sessions"
import { useDialog } from "@opencode/ui/context/dialog"
import { archiveHomeSession } from "@/home/sessions/archive"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { useCommand } from "@/shell/commands/command"
import { errorMessage } from "@/shell/layout/helpers"
import { useLayout } from "@/shell/state/layout"
import { showToast } from "@/shell/notifications/toast"
import { useTabs } from "@/shell/tabs/tabs"

export function useTitlebarArchiveCommands() {
  const command = useCommand()
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const layout = useLayout()
  const tabs = useTabs()

  const server = () => {
    const route = layout.route()
    const servers = global.servers.list()

    if (route.type === "session") return servers.find((item) => ServerConnection.key(item) === route.server)

    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return servers.find((item) => ServerConnection.key(item) === draft?.server)
    }

    const selection = layout.home.selection()
    return servers.find((item) => ServerConnection.key(item) === selection.server) ?? servers[0]
  }

  const session = () => {
    const route = layout.route()
    const conn = server()

    if (route.type !== "session" || !conn) return
    return global.ensureServerCtx(conn).data.session.get(route.sessionId)
  }

  const failed = (cause: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: errorMessage(cause, language.t("common.requestFailed")),
    })

  const archive = () => {
    const conn = server()
    const current = session()

    if (!conn || !current || current.parentID !== undefined || current.time.archived !== undefined) return
    const ctx = global.ensureServerCtx(conn)

    void archiveHomeSession({
      server: ServerConnection.key(conn),
      session: current,
      archive: (input) => ctx.sdk.api.session.update(input),
      commit: (archivedAt) => {
        const canonical = ctx.data.session.get(current.id) ?? current
        ctx.data.session.remember({ ...canonical, time: { ...canonical.time, archived: archivedAt } })
        ctx.data.session.invalidate(current.id)
      },
      onError: failed,
    })
  }

  const unarchive = () => {
    const conn = server()
    const current = session()

    if (!conn || !current || current.parentID !== undefined || current.time.archived === undefined) return
    const ctx = global.ensureServerCtx(conn)

    void ctx.sdk.api.session
      .update({ sessionID: current.id, archive: null })
      .then(() => {
        const canonical = ctx.data.session.get(current.id) ?? current
        const restored = { ...canonical, time: { ...canonical.time, archived: undefined } }
        ctx.data.session.remember(restored)
        ctx.projects.open(restored.location.directory)
        ctx.projects.touch(restored.location.directory)
        const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: restored.id })
        tabs.select(tab)
      })
      .catch(failed)
  }

  const browse = () => {
    const conn = server()

    if (!conn) return
    dialog.show(() => <DialogArchivedSessions server={conn} />)
  }

  command.register("titlebar.session-archive", () => {
    const conn = server()
    const current = session()
    const root = current?.parentID === undefined
    const archived = current?.time.archived !== undefined

    return [
      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !conn || !current || !root || archived,
        onSelect: archive,
      },
      {
        id: "session.unarchive",
        title: language.t("command.session.unarchive"),
        category: language.t("command.category.session"),
        disabled: !conn || !current || !root || !archived,
        onSelect: unarchive,
      },
      {
        id: "session.archived.browse",
        title: language.t("command.session.archivedBrowse"),
        category: language.t("command.category.session"),
        disabled: !conn,
        onSelect: browse,
      },
    ]
  })
}
