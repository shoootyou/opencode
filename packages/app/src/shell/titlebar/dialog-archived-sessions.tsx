import { createEffect, createResource, onCleanup, Show } from "solid-js"
import type { SessionInfo } from "@opencode/client/promise"
import { useQueryClient } from "@tanstack/solid-query"
import { useDialog } from "@opencode/ui/context/dialog"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { List } from "@opencode/ui/list"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { useTabs } from "@/shell/tabs/tabs"
import { retainHomeSessions, HOME_SESSION_LIMIT } from "@/home/sessions/index"
import { getRelativeTime } from "@/shell/time"
import { loadArchivedSessionEntries, type ArchivedEntry } from "./browse-archived"

const loadingForever: Promise<ArchivedEntry[]> = new Promise(() => {})

export function DialogArchivedSessions(props: { server: ServerConnection.Any }) {
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const tabs = useTabs()
  const queryClient = useQueryClient()
  const ctx = global.ensureServerCtx(props.server)
  const state = { disposed: false, restoring: new Set<string>() }
  const [archived, { mutate, refetch }] = createResource(() =>
    loadArchivedSessionEntries((input) => ctx.sdk.api.session.list(input), language.t("command.session.new")),
  )

  let toastedError: unknown
  createEffect(() => {
    const error = archived.error
    if (!error) {
      toastedError = undefined
      return
    }
    if (toastedError === error) return
    toastedError = error
    showToast({
      title: language.t("common.requestFailed"),
      description: errorMessage(error, language.t("common.requestFailed")),
    })
  })

  onCleanup(() => {
    state.disposed = true
  })

  const items = () => {
    if (archived.loading) return loadingForever
    return archived.latest ?? []
  }

  const select = async (entry: ArchivedEntry | undefined) => {
    if (!entry || state.disposed || state.restoring.has(entry.id)) return
    state.restoring.add(entry.id)

    try {
      await ctx.sdk.api.session.update({ sessionID: entry.id, archive: null })
      if (state.disposed) return

      const canonical = entry.session
      const restored = { ...canonical, time: { ...canonical.time, archived: undefined } }
      ctx.data.session.remember(restored)
      queryClient.setQueryData<SessionInfo[]>(["home-sessions", props.server], (current) =>
        current
          ? retainHomeSessions(
              [...current.filter((session) => session.id !== restored.id), restored],
              HOME_SESSION_LIMIT,
              Date.now(),
            )
          : current,
      )
      mutate((current) => current?.filter((item) => item.id !== restored.id))

      const directory = restored.location.directory
      ctx.projects.open(directory)
      ctx.projects.touch(directory)
      const tab = tabs.addSessionTab({ server: ServerConnection.key(props.server), sessionId: restored.id })
      tabs.select(tab)
      dialog.close()
    } catch (error) {
      if (state.disposed) return
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      state.restoring.delete(entry.id)
    }
  }

  return (
    <Dialog class="pt-3 pb-0 !max-h-[480px]">
      <DialogHeader>
        <DialogTitle>{language.t("dialog.archivedSessions.title")}</DialogTitle>
      </DialogHeader>
      <Show
        when={!archived.error}
        fallback={
          <div class="flex flex-col items-center gap-3 px-3 py-10 text-center">
            <Icon name="bubble-5" size="small" class="text-icon-weak" />
            <span class="text-14-regular text-text-strong">{language.t("common.requestFailed")}</span>
            <Button variant="neutral" size="small" onClick={() => void refetch()}>
              {language.t("common.retry")}
            </Button>
          </div>
        }
      >
        <List
          class="px-3"
          search={{ placeholder: language.t("palette.search.placeholder"), autofocus: true, hideIcon: true }}
          emptyMessage={language.t("dialog.archivedSessions.empty")}
          loadingMessage={language.t("common.loading")}
          items={items}
          key={(entry) => entry.id}
          filterKeys={["title", "directory"]}
          onSelect={select}
        >
          {(entry) => {
            const home = ctx.sync.data.path.home
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
                <Show when={entry.archivedAt !== 0}>
                  <span class="text-12-regular text-text-weak whitespace-nowrap ml-2">
                    {getRelativeTime(new Date(entry.archivedAt).toISOString(), language.t)}
                  </span>
                </Show>
              </div>
            )
          }}
        </List>
      </Show>
    </Dialog>
  )
}
