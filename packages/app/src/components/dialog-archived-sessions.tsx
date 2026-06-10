import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { List } from "@opencode-ai/ui/list"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"
import { getRelativeTime } from "@/utils/time"
import { buildArchivedSessionEntries, type ArchivedEntry } from "./browse-archived"

// Discovery dialog for archived sessions. Archived sessions span every project, so the list is
// fetched GLOBALLY (no directory scope) and selecting a row unarchives it and navigates in one
// step via the shared `unarchiveSession` semantics passed from the layout.
export function DialogArchivedSessions(props: { onUnarchive: (session: Session) => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  const items = async () => {
    // `archived` lives on the experimental list endpoint (`/experimental/session`), which is the
    // GLOBAL cross-project list — exactly what discovery needs since archived sessions span every
    // project. The non-experimental `session.list` is project-scoped and omits the archived filter.
    const response = await serverSDK.client.experimental.session.list({ archived: true, roots: true })
    return buildArchivedSessionEntries(response.data ?? [], language.t("command.session.new"))
  }

  const handleSelect = (entry: ArchivedEntry | undefined) => {
    if (!entry) return
    dialog.close()
    // `unarchiveSession` clears the archived timestamp and navigates to the restored session on
    // success; it rejects on failure. Surface the error and stay put (no navigation) on failure,
    // mirroring the sibling unarchive call sites.
    props.onUnarchive(entry.session).catch((err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err, language.t("common.requestFailed")),
      })
    })
  }

  return (
    <Dialog title={language.t("dialog.archivedSessions.title")} class="pt-3 pb-0 !max-h-[480px]" transition>
      <List
        class="px-3"
        search={{ placeholder: language.t("palette.search.placeholder"), autofocus: true, hideIcon: true }}
        emptyMessage={language.t("dialog.archivedSessions.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(entry) => entry.id}
        filterKeys={["title", "directory"]}
        onSelect={handleSelect}
      >
        {(entry) => {
          const home = serverSync.data.path.home
          const directory = home ? entry.directory.replace(home, "~") : entry.directory
          return (
            <div class="w-full flex items-center justify-between rounded-md pl-1">
              <div class="flex items-center gap-x-3 grow min-w-0">
                <Icon name="bubble-5" size="small" class="shrink-0 text-icon-weak" />
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-14-regular text-text-strong truncate">{entry.title}</span>
                  <span class="text-14-regular text-text-weak truncate">{directory}</span>
                </div>
              </div>
              <span class="text-12-regular text-text-weak whitespace-nowrap ml-2">
                {getRelativeTime(new Date(entry.archivedAt).toISOString(), language.t)}
              </span>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
