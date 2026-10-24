import { createSignal, onCleanup, Show } from "solid-js"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { List } from "@opencode/ui/list"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { useDialog } from "@opencode/ui/context/dialog"
import { useGlobal } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { useTabs } from "@/shell/tabs/tabs"
import { getRelativeTime } from "@/shell/time"
import { createArchivedSessionsModel } from "./archived-sessions-model"
import { selectArchivedSessionsView } from "./archived-sessions-view"

export function showArchivedSessionsDialog(dialog: Pick<ReturnType<typeof useDialog>, "show">, server: string) {
  dialog.show(() => <ArchivedSessionsDialog server={server} />)
}

function ArchivedSessionsDialog(props: { server: string }) {
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const tabs = useTabs()
  const [version, setVersion] = createSignal(0)
  const [filter, setFilter] = createSignal("")
  // SAFETY: the dialog is opened only from the registered archive command with a current server key.
  const ctx = global.serverCtx(props.server as never)

  if (!ctx) return null

  const model = createArchivedSessionsModel({
    server: props.server,
    list: ctx.sdk.api.session.list,
    setArchive: global.sessionArchive.setSessionArchive,
    openProject: ({ directory }) => ctx.projects.open(directory),
    touchProject: ({ directory }) => ctx.projects.touch(directory),
    // SAFETY: archived-session rows retain the server key used to resolve the current context.
    addTab: ({ server, sessionId }) => tabs.addSessionTab({ server: server as never, sessionId }),
    selectTab: tabs.select,
    close: () => dialog.close(),
  })

  model.subscribe(() => setVersion((value) => value + 1))
  void model.load()
  onCleanup(model.dispose)

  const state = () => {
    version()

    return model.state()
  }

  const restoringID = () => {
    version()

    return model.restoringID()
  }

  const page = () => {
    const current = state()

    return current.status === "ready" ? current.page : undefined
  }

  const view = () =>
    selectArchivedSessionsView({
      status: state().status,
      visibleSessionCount: model.search(filter()).length,
      filter: filter(),
      previousCursor: page()?.cursor.previous,
      nextCursor: page()?.cursor.next,
      restoringID: restoringID(),
    })

  const emptyMessage = () =>
    language.t(view().message === "no-match" ? "dialog.archivedSessions.noMatches" : "dialog.archivedSessions.empty")

  const listMessage = () => {
    if (view().message === "loading") return language.t("dialog.archivedSessions.loading")

    if (view().message === "error") return language.t("dialog.archivedSessions.error")

    return emptyMessage()
  }

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("dialog.archivedSessions.title")}
          description={language.t("dialog.archivedSessions.description")}
        />
      </DialogHeader>
      <DialogBody>
        <List
          class="px-3"
          items={(filter) => {
            version()

            return [...model.search(filter)]
          }}
          key={(session) => session.id}
          filterKeys={["title", "location.directory"]}
          search={{ placeholder: language.t("dialog.archivedSessions.search.placeholder"), autofocus: true }}
          emptyMessage={listMessage()}
          onFilter={setFilter}
          onSelect={(session) => {
            if (session) void model.restore(session.id)
          }}
        >
          {(session) => {
            const archived = session.time.archived ?? 0

            return (
              <span class="flex w-full min-w-0 items-center gap-2 text-start">
                <Icon name="bubble-5" size="small" class="shrink-0 text-v2-text-text-muted" aria-hidden="true" />
                <span class="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-2">
                  <span class="min-w-0 shrink truncate leading-4 text-v2-text-text-base [font-weight:530] md:max-w-[50%]">
                    {session.title || language.t("command.session.new")}
                  </span>
                  <span class="min-w-0 flex-1 truncate leading-4 text-v2-text-text-muted [font-weight:440]" dir="ltr">
                    {session.location.directory}
                  </span>
                </span>
                <Show when={Number.isFinite(archived) && archived !== 0 ? archived : undefined}>
                  {(archived) => (
                    <span class="shrink-0 whitespace-nowrap text-end text-v2-text-text-muted [font-weight:440]">
                      {getRelativeTime(new Date(archived()).toISOString(), language.t)}
                    </span>
                  )}
                </Show>
              </span>
            )
          }}
        </List>
        <Show when={view().message === "error"}>
          <button type="button" onClick={() => void model.load()}>
            {language.t("common.retry")}
          </button>
        </Show>
        <Show when={state().status === "ready"}>
          <div class="mt-3 flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={!view().previousEnabled}
              onClick={() => {
                if (view().previousEnabled) void model.previous()
              }}
            >
              {language.t("dialog.archivedSessions.previousPage")}
            </Button>
            <Button
              variant="ghost"
              disabled={!view().nextEnabled}
              onClick={() => {
                if (view().nextEnabled) void model.next()
              }}
            >
              {language.t("dialog.archivedSessions.nextPage")}
            </Button>
            <Button
              variant="ghost"
              disabled={!view().resetEnabled}
              onClick={() => {
                if (view().resetEnabled) void model.load()
              }}
            >
              {language.t("common.reset")}
            </Button>
          </div>
        </Show>
      </DialogBody>
    </Dialog>
  )
}
