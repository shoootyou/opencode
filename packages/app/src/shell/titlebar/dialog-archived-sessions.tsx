import { createEffect, createMemo, createSignal, onCleanup, Show, untrack, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useQueryClient } from "@tanstack/solid-query"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { List } from "@opencode/ui/list"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { useDialog } from "@opencode/ui/context/dialog"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { sessionIDHasOpenTab, useTabs } from "@/shell/tabs/tabs"
import { getRelativeTime } from "@/shell/time"
import { isArchivedSession, type ArchiveSession } from "@/session/archive"
import { sessionBusy } from "@/shell/layout/project-avatar-state"
import { showToast } from "@/shell/notifications/toast"
import { bulkSummary, isArchivedSelectable, openTabCount, tabIdsToClose, type BulkResult } from "@/home/sessions/bulk"
import { createSelection, SelectionBar, SelectionBox } from "@/home/sessions/selection"
import { notifySessionTabsRemoved } from "./session-events"
import { createArchivedSessionsModel } from "./archived-sessions-model"
import { rowAria, selectArchivedSessionsView } from "./archived-sessions-view"

// oxlint-disable anti-slop/require-readable-spacing -- Adjacent native-event guards define one demand-token transition.

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
  let scroller: HTMLDivElement | undefined
  let demand = false
  let keyboardDemandFrame: number | undefined
  let keyboardDemandGeneration = 0
  let previousScrollTop = 0
  let underfillFrame: number | undefined
  let underfillProbed = false
  let underfillEligible = false
  let underfillDecided = false
  let removeWheel: (() => void) | undefined
  let listRoot: HTMLDivElement | undefined
  let actionButton: HTMLButtonElement | undefined
  let restoreSearchFocus = false
  let focusGeneration = 0
  // SAFETY: the dialog is opened only from the registered archive command with a current server key.
  const ctx = global.serverCtx(props.server as never)

  if (!ctx) return null

  const model = createArchivedSessionsModel({
    server: props.server,
    list: ctx.sdk.api.session.list,
    setArchive: global.sessionArchive.setSessionArchive,
    openProject: ({ directory }) => ctx.projects.add(directory),
    touchProject: ({ directory }) => ctx.projects.touch(directory),
    // SAFETY: archived-session rows retain the server key used to resolve the current context.
    addTab: ({ server, sessionId }) => tabs.addSessionTab({ server: server as never, sessionId }),
    selectTab: tabs.select,
    close: () => dialog.close(),
    unarchive: global.sessionArchive.unarchiveSessionQuiet,
    remove: (sessionID) => ctx.data.session.remove(sessionID),
    connected: () => ctx.sdk.connection.status() === "connected",
    isBusy: (sessionID) => [sessionID, ...ctx.data.session.family(sessionID)].some((id) => sessionBusy(ctx.data, id)),
    // Only a session the store positively knows is active counts; an unsynced one is still treated as archived.
    unarchivedElsewhere: (sessionID) => {
      const info = ctx.data.session.get(sessionID)

      return info !== undefined && !isArchivedSession(info)
    },
    // SAFETY: same captured key as above; a replaced context makes the batch fail closed.
    active: () => global.serverCtx(props.server as never) === ctx,
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

  const bulkRunning = () => {
    version()

    return model.bulkRunning()
  }

  // A single restore and a batch exclude each other and every load.
  const busy = () => restoringID() !== undefined || bulkRunning()

  const queryClient = useQueryClient()
  // SAFETY: same registered server key the context above was resolved with.
  const server = props.server as ServerConnection.Key
  const selection = createSelection()
  const [bulk, setBulk] = createStore<{ progress?: { done: number; total: number } }>({})
  // The rows List actually renders: model.search and List disagree on some filters, and only rendered rows are selectable.
  const [rendered, setRendered] = createStore<Record<string, ArchiveSession>>({})
  // A batch the user confirmed still runs after the dialog closes, but it must not write to the disposed selection.
  let alive = true
  onCleanup(() => (alive = false))

  const isBusy = (id: string) => [id, ...ctx.data.session.family(id)].some((item) => sessionBusy(ctx.data, item))

  const selectable = createMemo(
    () =>
      new Set(
        Object.values(rendered)
          .filter((session) => isArchivedSelectable(session, isBusy(session.id)))
          .map((session) => session.id),
      ),
  )

  // Rows that leave, get filtered out or start working drop out of the selection; a running batch owns it.
  createEffect(() => {
    const valid = selectable()

    if (bulk.progress) return

    untrack(() => {
      if (selection.store.ids.some((id) => !valid.has(id))) selection.prune(valid)
    })
  })

  const focusSearch = () =>
    queueMicrotask(() => listRoot?.querySelector<HTMLInputElement>('[data-slot="list-search"] input')?.focus())

  const enterSelection = () => {
    selection.enter()
    focusSearch()
  }

  const exitSelection = () => {
    selection.exit()
    focusSearch()
  }

  const finish = (result: BulkResult) => {
    // Failures stay selected so a retry is one click away; the mode closes only when everything worked.
    if (result.failed.length === 0) exitSelection()
    else {
      selection.selectAll(result.failed)
      // The confirm layer and the disabled bar leave focus on the body otherwise.
      focusSearch()
    }
  }

  // Exactly one toast per batch; server error text never reaches it.
  const showSummary = (kind: "unarchive" | "delete", result: BulkResult) => {
    const summary = bulkSummary(kind, result, language)

    showToast({ variant: summary.variant, title: summary.title })
  }

  const onProgress = (done: number, total: number) => setBulk("progress", { done, total })

  const bulkUnarchive = async (ids: string[]) => {
    if (ids.length === 0 || bulk.progress) return
    setBulk("progress", { done: 0, total: ids.length })

    try {
      const result = await model.restoreMany(ids, { onProgress })

      if (!result) return
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === server)

      // Home merges the store, but a swallowed sync failure would leave its cached index without the row.
      if (result.ok.length > 0 && conn)
        void queryClient.invalidateQueries({ queryKey: ["home-sessions", conn], exact: true })
      showSummary("unarchive", result)

      // Only the selection belongs to the view; the toast and cache update report a batch that already ran.
      if (alive) finish(result)
    } finally {
      setBulk("progress", undefined)
    }
  }

  // The tree always includes the root; children are known only if they were synced, and no sync is forced here.
  const treeOf = (id: string) => [id, ...ctx.data.session.family(id)]

  const bulkDelete = async (ids: string[], expected: NonNullable<ReturnType<typeof global.serverCtx>>) => {
    // The dialog was opened for another server context; confirming must not aim its ids at this one.
    if (ids.length === 0 || bulk.progress || global.serverCtx(server) !== expected) return
    // The list hides a session once it is removed, so the trees are read before the first remove.
    const trees = new Map(ids.map((id) => [id, treeOf(id)]))
    const directory = model.search("").find((row) => row.id === ids[0])?.location.directory ?? ""
    setBulk("progress", { done: 0, total: ids.length })

    try {
      const result = await model.removeMany(ids, { onProgress })

      if (!result) return

      notifySessionTabsRemoved({ server, directory, sessionIDs: tabIdsToClose(result, trees) })
      showSummary("delete", result)

      if (alive) finish(result)
    } finally {
      setBulk("progress", undefined)
    }
  }

  function ArchivedDeleteDialog(deleting: {
    ids: string[]
    tabs: number
    expected: NonNullable<ReturnType<typeof global.serverCtx>>
  }) {
    // The dialog stays mounted through its exit animation, so a second activation must not rerun the batch.
    const [confirmed, setConfirmed] = createSignal(false)

    const confirm = async () => {
      if (confirmed()) return
      setConfirmed(true)
      dialog.close()
      await bulkDelete(deleting.ids, deleting.expected)
    }

    return (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.plural("home.sessions.bulk.delete.title", deleting.ids.length)}
            description={
              <>
                <span class="block">
                  {language.plural("home.sessions.bulk.delete.description", deleting.ids.length)}
                </span>
                <Show when={deleting.tabs > 0}>
                  <span class="block">{language.plural("home.sessions.bulk.delete.tabs", deleting.tabs)}</span>
                </Show>
              </>
            }
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" autofocus onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={confirmed()} onClick={confirm}>
            {language.plural("home.sessions.bulk.delete.button", deleting.ids.length)}
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  const showDelete = () => {
    const ids = [...selection.store.ids]

    if (ids.length === 0 || busy()) return
    // Snapshot at open: the count describes the selection the user is confirming.
    const tabsOpen = openTabCount(ids, treeOf, (item) => sessionIDHasOpenTab(tabs.store, server, item))

    // push keeps this dialog and its model mounted; show would dispose the whole stack.
    void dialog.push(() => <ArchivedDeleteDialog ids={ids} tabs={tabsOpen} expected={ctx} />)
  }

  const selectButton = (
    <Show
      when={(() => {
        const current = state()

        return !selection.store.on && current.status === "ready" && current.rows.length > 0
      })()}
    >
      <Button variant="ghost" data-action="archived-select" onClick={enterSelection}>
        {language.t("home.sessions.select")}
      </Button>
    </Show>
  )

  const view = () => {
    const current = state()

    return selectArchivedSessionsView({
      status: current.status,
      visibleSessionCount: model.search(filter()).length,
      filter: filter(),
      nextCursor: current.status === "ready" ? current.nextCursor : undefined,
      continuationError: current.status === "ready" ? current.continuationError : undefined,
      continuationPending: current.status === "ready" ? current.continuationPending : false,
      restoringID: restoringID(),
      bulkRunning: bulkRunning(),
    })
  }

  const emptyMessage = () =>
    language.t(
      view().message === "loaded-no-match"
        ? "dialog.archivedSessions.loadedNoMatches"
        : "dialog.archivedSessions.loadedEmpty",
    )

  const listMessage = () => {
    if (view().message === "loading") return language.t("dialog.archivedSessions.loading")

    if (view().message === "error") return language.t("dialog.archivedSessions.error")

    return emptyMessage()
  }

  const continueLoading = () => {
    const current = state()

    return current.status === "ready" && current.continuationPending
  }

  const canLoadMore = () => view().loadMoreEnabled
  const canRetry = () => view().retryEnabled

  const clearKeyboardDemand = () => {
    demand = false
    keyboardDemandGeneration++
    if (keyboardDemandFrame !== undefined) cancelAnimationFrame(keyboardDemandFrame)
    keyboardDemandFrame = undefined
  }

  const setKeyboardDemand = () => {
    demand = true
    keyboardDemandGeneration++
    if (keyboardDemandFrame !== undefined) cancelAnimationFrame(keyboardDemandFrame)
    const generation = keyboardDemandGeneration
    keyboardDemandFrame = requestAnimationFrame(() => {
      keyboardDemandFrame = requestAnimationFrame(() => {
        if (keyboardDemandGeneration !== generation) return
        clearKeyboardDemand()
      })
    })
  }

  const loadMore = () => {
    if (canLoadMore()) void model.loadMore()
  }

  const retry = () => {
    restoreSearchFocus = document.activeElement === actionButton
    focusGeneration++

    if (canRetry()) void model.retryMore()
  }

  const onScroll: JSX.EventHandler<HTMLDivElement, Event> = (event) => {
    const current = event.currentTarget

    scroller = current
    const movedDown = current.scrollTop > previousScrollTop
    previousScrollTop = current.scrollTop

    if (!demand) return
    clearKeyboardDemand()
    if (!movedDown || current.clientHeight <= 0) return
    if (current.scrollHeight - current.clientHeight - current.scrollTop > 96) return

    loadMore()
  }

  const onWheel = (event: WheelEvent) => {
    clearKeyboardDemand()
    if (event.deltaY <= 0) return

    if (!scroller || scroller.clientHeight <= 0) return

    if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 96) return

    loadMore()
  }

  const hasContinuationAction = () => {
    const current = state()

    return current.status === "error" || (current.status === "ready" && !!current.nextCursor)
  }

  const actionPending = () => continueLoading() || busy()
  const continuationError = () => {
    const current = state()
    return current.status === "ready" ? current.continuationError : undefined
  }

  const activateContinuation = () => {
    if (actionPending()) return

    restoreSearchFocus = document.activeElement === actionButton
    focusGeneration++

    const current = state()

    if (current.status === "error" || (current.status === "ready" && current.continuationError)) {
      retry()

      return
    }

    loadMore()
  }

  createEffect(() => {
    const current = state()

    if (current.status === "loading") {
      clearKeyboardDemand()
      underfillProbed = false
      underfillEligible = false
      underfillDecided = false
      underfillFrame = undefined
    }

    if (current.status === "ready" && !underfillDecided) {
      underfillDecided = true
      underfillEligible = !filter().trim()
    }

    if (
      current.status !== "ready" ||
      underfillProbed ||
      !underfillEligible ||
      !current.nextCursor ||
      current.continuationPending ||
      current.continuationError ||
      busy() ||
      !scroller
    )
      return

    underfillProbed = true
    underfillFrame = requestAnimationFrame(() => {
      underfillFrame = undefined
      if (
        state().status !== "ready" ||
        filter().trim() ||
        !scroller ||
        scroller.clientHeight <= 0 ||
        scroller.scrollHeight - scroller.clientHeight > 1
      )
        return
      loadMore()
    })
  })

  createEffect(() => {
    const current = state()

    if (current.status !== "ready" || current.nextCursor || !restoreSearchFocus) return

    const action = actionButton
    const generation = focusGeneration

    queueMicrotask(() => {
      if (
        !restoreSearchFocus ||
        focusGeneration !== generation ||
        !listRoot?.isConnected ||
        !action ||
        action.isConnected ||
        hasContinuationAction()
      )
        return
      restoreSearchFocus = false
      listRoot.querySelector<HTMLInputElement>('[data-slot="list-search"] input')?.focus()
    })
  })

  onCleanup(() => {
    if (underfillFrame !== undefined) cancelAnimationFrame(underfillFrame)
    clearKeyboardDemand()
    removeWheel?.()
  })

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("dialog.archivedSessions.title")}
          description={language.t(
            selection.store.on
              ? "dialog.archivedSessions.bulk.description"
              : "dialog.archivedSessions.loadedDescription",
          )}
        />
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col">
        {/* First in DOM and tab order, drawn last. */}
        <Show when={selection.store.on}>
          <div class="order-last">
            <SelectionBar
              language={language}
              selected={selection.store.ids.length}
              total={selectable().size}
              progress={bulk.progress}
              primaryLabel={language.t("common.unarchive")}
              onSelectAll={() => selection.selectAll([...selectable()])}
              onArchive={() => void bulkUnarchive([...selection.store.ids])}
              onDelete={showDelete}
              onDone={exitSelection}
            />
          </div>
        </Show>
        <div
          class="flex min-h-0 flex-1 flex-col"
          ref={(element) => {
            listRoot = element
            queueMicrotask(() => {
              scroller = element.querySelector<HTMLDivElement>('[data-slot="list-scroll"]') ?? undefined
              previousScrollTop = scroller?.scrollTop ?? 0
              scroller?.addEventListener("wheel", onWheel, { passive: true })
              removeWheel = () => scroller?.removeEventListener("wheel", onWheel)
            })
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End") {
              setKeyboardDemand()
              return
            }
            clearKeyboardDemand()
          }}
        >
          <List<ArchiveSession>
            class="flex min-h-0 flex-1 flex-col px-3"
            items={(filter) => {
              version()

              return [...model.search(filter)]
            }}
            key={(session) => session.id}
            filterKeys={["title", "location.directory"]}
            search={{ placeholder: language.t("common.search.placeholder"), autofocus: true, action: selectButton }}
            emptyMessage={listMessage()}
            onFilter={(value) => {
              clearKeyboardDemand()
              setFilter(value)
            }}
            onScroll={onScroll}
            preserveActiveKey
            itemWrapper={(session, node) => {
              setRendered(session.id, session)
              onCleanup(() => setRendered(produce((rows) => void delete rows[session.id])))

              if (node instanceof HTMLElement)
                createEffect(() => {
                  const aria = rowAria({
                    on: selection.store.on,
                    selected: selection.store.ids.includes(session.id),
                    selectable: selectable().has(session.id),
                  })

                  for (const name of ["role", "aria-checked", "aria-disabled"] as const)
                    if (aria[name] === undefined) node.removeAttribute(name)
                    else node.setAttribute(name, aria[name])
                })

              return node
            }}
            onSelect={(session) => {
              if (!session) return

              if (!selection.store.on) return void model.restore(session.id)
              if (bulk.progress) return
              selection.toggle(session.id, false, Object.keys(rendered), (id) => selectable().has(id))
            }}
          >
            {(session) => {
              const archived = session.time.archived ?? 0

              return (
                <span
                  class="flex w-full min-w-0 items-center gap-2 text-start"
                  classList={{ "opacity-50": selection.store.on && !selectable().has(session.id) }}
                  title={
                    selection.store.on && !selectable().has(session.id)
                      ? language.t("home.sessions.bulk.busy")
                      : undefined
                  }
                >
                  <Show when={selection.store.on}>
                    <SelectionBox checked={selection.store.ids.includes(session.id)} />
                  </Show>
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
        </div>
      </DialogBody>
      <DialogFooter>
        <div class="flex w-full items-center justify-end gap-2">
          <Show when={continueLoading()}>
            <span aria-live="polite">{language.t("dialog.archivedSessions.loading")}</span>
          </Show>
          <Show when={continuationError()}>
            <span role="status">{language.t("dialog.archivedSessions.error")}</span>
          </Show>
          <Show when={hasContinuationAction()}>
            <Button
              variant="ghost"
              ref={(element: HTMLButtonElement) => {
                actionButton = element
              }}
              aria-disabled={actionPending() ? "true" : undefined}
              onBlur={(event: FocusEvent & { currentTarget: HTMLButtonElement }) => {
                if (
                  !event.currentTarget.isConnected ||
                  event.currentTarget !== actionButton ||
                  !hasContinuationAction()
                )
                  return
                restoreSearchFocus = false
                focusGeneration++
              }}
              onClick={activateContinuation}
            >
              {continueLoading()
                ? language.t("dialog.archivedSessions.loading")
                : view().message === "error" || canRetry()
                  ? language.t("common.retry")
                  : language.t("common.loadMore")}
            </Button>
          </Show>
        </div>
      </DialogFooter>
    </Dialog>
  )
}
