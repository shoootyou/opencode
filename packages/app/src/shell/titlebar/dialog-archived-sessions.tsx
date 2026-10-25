import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { List } from "@opencode/ui/list"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { useDialog } from "@opencode/ui/context/dialog"
import { useGlobal } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { useTabs } from "@/shell/tabs/tabs"
import { getRelativeTime } from "@/shell/time"
import { type ArchiveSession } from "@/session/archive"
import { createArchivedSessionsModel } from "./archived-sessions-model"
import { selectArchivedSessionsView } from "./archived-sessions-view"

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

  const actionPending = () => continueLoading() || restoringID() !== undefined
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
      restoringID() ||
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
          description={language.t("dialog.archivedSessions.loadedDescription")}
        />
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col">
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
            search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
            emptyMessage={listMessage()}
            onFilter={(value) => {
              clearKeyboardDemand()
              setFilter(value)
            }}
            onScroll={onScroll}
            preserveActiveKey
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
