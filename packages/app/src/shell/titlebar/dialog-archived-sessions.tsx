import { createSignal, onCleanup, Show } from "solid-js"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { List } from "@opencode/ui/list"
import { useDialog } from "@opencode/ui/context/dialog"
import { useGlobal } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { useTabs } from "@/shell/tabs/tabs"
import { createArchivedSessionsModel } from "./archived-sessions-model"

export function showArchivedSessionsDialog(server: string) {
  const dialog = useDialog()
  dialog.show(() => <ArchivedSessionsDialog server={server} />)
}

function ArchivedSessionsDialog(props: { server: string }) {
  const global = useGlobal()
  const language = useLanguage()
  const tabs = useTabs()
  const [version, setVersion] = createSignal(0)
  const ctx = global.serverCtx(props.server as never)
  if (!ctx) return null
  const model = createArchivedSessionsModel({
    server: props.server,
    list: ctx.sdk.api.session.list,
    setArchive: global.sessionArchive.setSessionArchive,
    openProject: ({ directory }) => ctx.projects.open(directory),
    touchProject: ({ directory }) => ctx.projects.touch(directory),
    addTab: ({ server, sessionId }) => tabs.addSessionTab({ server: server as never, sessionId }),
    selectTab: tabs.select,
    close: () => useDialog().close(),
  })
  model.subscribe(() => setVersion((value) => value + 1))
  void model.load()
  onCleanup(model.dispose)
  const state = () => { version(); return model.state() }
  return <Dialog size="large"><DialogHeader><DialogTitleGroup title={language.t("dialog.archivedSessions.title")} /></DialogHeader><DialogBody><Show when={state().status === "ready"} fallback={<div>{state().status === "loading" ? language.t("dialog.archivedSessions.loading") : state().status === "error" ? language.t("dialog.archivedSessions.error") : ""}</div>}><List items={(filter) => [...model.search(filter)]} key={(session) => session.id} filterKeys={["title", "location.directory"]} search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }} emptyMessage={language.t("dialog.archivedSessions.empty")}>{(session) => <button type="button" disabled={model.restoringID() === session.id} onClick={() => void model.restore(session.id)}>{session.title ?? session.location.directory}</button>}</List></Show></DialogBody></Dialog>
}
