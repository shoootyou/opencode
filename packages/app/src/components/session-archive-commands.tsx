import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { onCleanup } from "solid-js"
import { produce } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { Session } from "@opencode-ai/sdk/v2/client"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { unarchivePatch } from "@/pages/layout/helpers"

// Shared archive/unarchive/browse-archived command registration. Extracted from `layout.tsx` so
// both `LegacyLayout` and `NewLayout` can register the same commands under the dedicated
// "session-archive" key — mounting from only one layout let the commands vanish entirely once a
// session force-redirected into the other layout (see plan 187-opencode-restore-archive-ui).
export function useSessionArchiveCommands() {
  const params = useParams()
  const navigate = useNavigate()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()

  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })

  async function archiveSession(session: Session) {
    const [store, setStore] = serverSync().child(session.directory)
    const sessions = store.session ?? []
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    await serverSDK().api.session.archive({ sessionID: session.id, directory: session.directory })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    if (session.id !== params.id) return
    if (nextSession) {
      navigate(`/${params.dir}/session/${nextSession.id}`)
      return
    }
    navigate(`/${params.dir}/session`)
  }

  async function unarchiveSession(session: Session) {
    const [, setStore] = serverSync().child(session.directory)

    await serverSDK().client.session.update({
      directory: session.directory,
      sessionID: session.id,
      time: unarchivePatch(),
    })

    const restored = { ...session, time: { ...session.time, archived: undefined } }
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) {
          draft.session[match.index] = restored
          return
        }
        draft.session.splice(match.index, 0, restored)
      }),
    )
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  function browseArchivedSessions() {
    const run = ++dialogRun
    void import("@/components/dialog-archived-sessions").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogArchivedSessions onUnarchive={unarchiveSession} />)
    })
  }

  // Re-derives the current session directly from the server-sync store rather than relying on
  // either layout's own internal (sidebar/workspace-filtered) session list, so this module works
  // identically regardless of which layout mounts it.
  function findCurrentSession() {
    const directory = decode64(params.dir)
    if (!directory) return
    const [store] = serverSync().child(directory, { bootstrap: false })
    return (store.session ?? []).find((s) => s.id === params.id)
  }

  command.register("session-archive", () => [
    {
      id: "session.archive",
      title: language.t("command.session.archive"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+backspace",
      disabled: !params.dir || !params.id,
      onSelect: () => {
        const session = findCurrentSession()
        if (session) void archiveSession(session)
      },
    },
    {
      id: "session.unarchive",
      title: language.t("command.session.unarchive"),
      category: language.t("command.category.session"),
      // Mirrors `session.archive`: gated only on having a current session, NOT on archived
      // state. Archiving splices the session out of the window list (`store.session`) and
      // navigates away, so the in-window store can't reliably report whether `params.id` is
      // archived — gating visibility on it would leave this command permanently disabled and
      // unreachable. Kept symmetric with `session.archive` instead.
      disabled: !params.dir || !params.id,
      onSelect: () => {
        const session = findCurrentSession()
        if (session) void unarchiveSession(session)
      },
    },
    {
      id: "session.archived.browse",
      title: language.t("command.session.archivedBrowse"),
      category: language.t("command.category.session"),
      // Discovery entry point: intentionally NOT disabled by `!params.id` — it must work from
      // anywhere to surface archived sessions across every project.
      onSelect: () => browseArchivedSessions(),
    },
  ])

  return { archiveSession, unarchiveSession, browseArchivedSessions }
}
