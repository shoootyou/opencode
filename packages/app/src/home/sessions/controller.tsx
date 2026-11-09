import type { SessionInfo } from "@opencode/client/promise"
import { useDialog } from "@opencode/ui/context/dialog"
import { Button } from "@opencode/ui/button"
import { DialogFooter, DialogHeader, DialogTitleGroup, Dialog } from "@opencode/ui/dialog"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  Show,
  startTransition,
  untrack,
} from "solid-js"
import { notifySessionTabsRemoved } from "@/shell/titlebar/session-events"
import { useCommand } from "@/shell/commands/command"
import { HOME_SESSION_LIMIT, mergeHomeSessionIndex, retainHomeSessions } from "@/home/sessions/index"
import type { LocalProject } from "@/shell/state/layout"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { sessionHasOpenTab, sessionIDHasOpenTab, useTabs } from "@/shell/tabs/tabs"
import { errorMessage } from "@/shell/layout/helpers"
import { sessionBusy, useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { sessionTreeIDs } from "@/session/requests/session-request-tree"
import { pathKey } from "@/workspaces/path-key"
import { fetchSessionExport, saveSessionExport, sessionExportFilename } from "@/session/commands/export"
import { usePlatform } from "@/runtime/platform/platform"
import { sessionLabel, sessionTitle } from "@/session/title"
import { showToast } from "@/shell/notifications/toast"
import { archiveHomeSession } from "./archive"
import { bulkSummary, isSelectable, offlineResult, runBulk, skipId, type BulkResult } from "./bulk"
import { createSelection } from "./selection"
import { homeSessionsQuery } from "./queries"
import { useGlobal } from "@/runtime/server/runtime"
import type { HomeController } from "../model"
import { buildHomeSessionRecords, homeProjectForSession, homeSessionLocation, type HomeSessionRecord } from "./records"

export type { HomeSessionRecord } from "./records"

export type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

export type OpenSessionOptions = { background?: boolean }

export function createHomeSessionsController(home: HomeController) {
  const tabs = useTabs()
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const queryClient = useQueryClient()
  const global = useGlobal()

  const projectDirectories = createMemo(() => {
    const selected = home.selection.value().directory

    if (!selected) return
    const project = home.project.selected()

    return project ? directories(project) : [selected]
  })

  const sessionLoad = useQuery(() => {
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()

    return {
      ...homeSessionsQuery(conn, ctx),
      enabled: !!ctx && ctx.sdk.connection.status() === "connected",
    }
  })

  const indexedSessions = createMemo(() => {
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()

    if (!ctx || !conn) return []

    return retainHomeSessions(
      ctx.data.session.apply(
        mergeHomeSessionIndex(sessionLoad.isPending ? [] : (sessionLoad.data?.() ?? []), ctx.data.session.list()),
      ),
      HOME_SESSION_LIMIT,
      Date.now(),
    )
  })

  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sessions: indexedSessions,
      projectDirectories,
      projects: home.project.list,
      resolveProject: (session) => home.server.focusedContext()?.projects.forSession(session),
    }),
  )

  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const groups = createMemo(() => groupSessions(records(), language))
  const prefetched = new Set<string>()

  const location = (record: HomeSessionRecord) => {
    const branch = home.server.focusedContext()?.data.location.vcs.info(record.session.location)?.branch.current

    return homeSessionLocation(record.session.location.directory, branch)
  }

  const syncLocations = (record?: HomeSessionRecord) => {
    if (platform.platform !== "desktop") return
    const ctx = home.server.focusedContext()

    if (!ctx) return

    if (record) {
      if (!ctx.data.location.info(record.session.location)) return
      void ctx.data.location.vcs.sync(record.session.location).catch(() => undefined)

      return
    }

    const locations = new Map(
      records()
        .filter((record) => !!ctx.data.location.info(record.session.location))
        .map((record) => [pathKey(record.session.location.directory), record.session.location] as const),
    )

    void Promise.allSettled(Array.from(locations.values(), (location) => ctx.data.location.vcs.sync(location)))
  }

  createEffect(() => {
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()

    if (!ctx || !conn) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(conn)}\0${record.session.id}`

        if (prefetched.has(key)) return
        prefetched.add(key)
        void untrack(() => ctx.data.session.sync(record.session.id)).catch(() => {})
      })
  })

  command.register("palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const conn = home.server.focused()

        if (!conn) return
        const ctx = home.server.focusedContext()

        if (!ctx) return
        const { HomeCommandPalette } = await import("../start/command-palette")
        void dialog.show(() => (
          <HomeCommandPalette
            server={conn}
            onSelectSession={(entry) => {
              if (!entry.sessionID || !entry.directory || !entry.server) return
              const sessionID = entry.sessionID
              const server = entry.server
              const directory = entry.project?.worktree ?? entry.directory
              ctx.projects.touch(directory)
              void startTransition(() => {
                const tab = tabs.addSessionTab({ server, sessionId: sessionID })
                tabs.select(tab)
              })
            }}
          />
        ))
      },
    },
  ])

  const rename = async (server: ServerConnection.Key, session: SessionInfo, title: string) => {
    const conn = home.server.list().find((item) => ServerConnection.key(item) === server)
    const ctx = conn ? home.server.context(conn) : undefined

    if (!conn || !ctx) return false
    const next = title.trim()

    if (!next || next === sessionLabel(session)) return true

    return ctx.sdk.api.session
      .update({ sessionID: session.id, title: next })
      .then(() => {
        ctx.data.session.remember({ ...(ctx.data.session.get(session.id) ?? session), title: next })
        // Rename advances time.updated server-side; re-sync the canonical
        // record so date grouping and ordering do not go stale.
        ctx.data.session.invalidate(session.id)
        void ctx.data.session.sync(session.id).catch(() => {})
        queryClient.setQueryData<SessionInfo[]>(["home-sessions", conn], (current) =>
          current?.map((item) => (item.id === session.id ? { ...item, title: next } : item)),
        )

        return true
      })
      .catch((cause) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(cause, language.t("common.requestFailed")),
        })

        return false
      })
  }

  const exportSession = async (server: ServerConnection.Key, session: SessionInfo) => {
    const conn = home.server.list().find((item) => ServerConnection.key(item) === server)
    const ctx = conn ? home.server.context(conn) : undefined

    if (!ctx) return

    try {
      const data = await fetchSessionExport({ sessionID: session.id, api: ctx.sdk.api })
      const filename = sessionExportFilename(data.info)

      if (!(await saveSessionExport(filename, data, platform))) return
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("toast.session.export.success.title"),
        description: language.t("toast.session.export.success.description", { filename }),
      })
    } catch (cause) {
      showToast({
        variant: "error",
        title: language.t("toast.session.export.failed.title"),
        description: cause instanceof Error ? cause.message : language.t("toast.session.export.failed.description"),
      })
    }
  }

  const remove = async (server: ServerConnection.Key, session: SessionInfo) => {
    const conn = home.server.list().find((item) => ServerConnection.key(item) === server)
    const ctx = conn ? home.server.context(conn) : undefined

    if (!conn || !ctx) return false
    const ids = sessionTreeIDs(ctx.data.session.list(), session.id)
    const rows = homeRowTops()
    // session.deleted clears the local hide mutation before the refetch lands,
    // so the cached index must drop the row now or it briefly reappears.
    queryClient.setQueryData<SessionInfo[]>(["home-sessions", conn], (current) =>
      current?.filter((item) => item.id !== session.id),
    )
    const request = ctx.data.session.remove(session.id)
    animateHomeRowsUp(rows)

    return request
      .then(() => {
        notifySessionTabsRemoved({
          server: ServerConnection.key(conn),
          directory: session.location.directory,
          sessionIDs: ids,
        })

        return true
      })
      .catch((cause) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(cause, language.t("session.delete.failed.title")),
        })

        return false
      })
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: ["home-sessions", conn], exact: true })
      })
  }

  const selection = createSelection()
  const [bulkProgress, setBulkProgress] = createSignal<{ done: number; total: number }>()
  // A batch the user confirmed still runs after Home unmounts, but it must not write to the disposed view.
  let alive = true
  onCleanup(() => (alive = false))

  // Busy state is local; on a stale connection a session started elsewhere reads idle, so bulk ops need a live one.
  const connected = (ctx: { sdk: { connection: { status: () => string } } }) =>
    ctx.sdk.connection.status() === "connected"

  const isBusy = (id: string) => {
    const ctx = home.server.focusedContext()

    return !!ctx && [id, ...ctx.data.session.family(id)].some((item) => sessionBusy(ctx.data, item))
  }

  const selectable = createMemo(
    () =>
      new Set(
        records()
          .filter((record) => isSelectable(record.session, isBusy(record.session.id)))
          .map((record) => record.session.id),
      ),
  )

  const order = () => records().map((record) => record.session.id)

  // Rows that vanish or start working leave the selection; a running batch owns it until it ends.
  createEffect(() => {
    const valid = selectable()

    if (bulkProgress()) return

    untrack(() => {
      if (selection.store.ids.some((id) => !valid.has(id))) selection.prune(valid)
    })
  })

  createEffect(
    on(
      () => home.server.focused(),
      () => selection.exit(),
      { defer: true },
    ),
  )

  // Exactly one toast per batch; server error text never reaches it.
  const showBulkSummary = (kind: "archive" | "delete", result: BulkResult) => {
    const summary = bulkSummary(kind, result, language)

    showToast({ variant: summary.variant, title: summary.title })
  }

  const showBulkOffline = (kind: "archive" | "delete", ids: string[]) => showBulkSummary(kind, offlineResult(ids))

  const finishBulk = (result: BulkResult) => {
    // Failures stay selected so a retry is one click away; the bar closes only when everything worked.
    if (result.failed.length === 0) selection.exit()

    if (result.failed.length > 0) selection.selectAll(result.failed)
  }

  const bulkArchive = async (ids: string[]) => {
    const conn = home.server.focused()
    const ctx = home.server.focusedContext()

    if (!conn || !ctx || ids.length === 0 || bulkProgress()) return
    const server = ServerConnection.key(conn)
    const directory = records().find((record) => record.session.id === ids[0])?.session.location.directory ?? ""

    if (!connected(ctx)) return showBulkOffline("archive", ids)
    setBulkProgress({ done: 0, total: ids.length })

    try {
      const result = await runBulk(
        ids,
        async (id) => {
          const attempt = await global.sessionArchive.archiveSessionQuiet({ server, sessionID: id })

          if (attempt.status === "failed") throw attempt.error

          if (attempt.status === "pending") throw new Error("Archive already in progress")
          ctx.data.session.evict(id)
        },
        {
          isBusy: (id) => skipId(connected(ctx), isBusy(id)),
          proceed: () => home.server.focusedContext() === ctx,
          onProgress: (done, total) => setBulkProgress({ done, total }),
        },
      )

      void queryClient.invalidateQueries({ queryKey: ["home-sessions", conn], exact: true })
      notifySessionTabsRemoved({ server, directory, sessionIDs: [...result.ok, ...result.missing] })
      showBulkSummary("archive", result)

      // Only the selection belongs to the view; the toast and tab cleanup report a batch that already ran.
      if (alive) finishBulk(result)
    } finally {
      setBulkProgress(undefined)
    }
  }

  const bulkDelete = async (ids: string[], expected: ReturnType<typeof home.server.focusedContext>) => {
    const conn = home.server.focused()
    const ctx = home.server.focusedContext()

    // The dialog was opened for another server; confirming must not aim its ids at this one.
    if (!conn || !ctx || ctx !== expected || ids.length === 0 || bulkProgress()) return
    const server = ServerConnection.key(conn)
    const directory = records().find((record) => record.session.id === ids[0])?.session.location.directory ?? ""
    // The list hides a session once it is removed, so the trees are read before the first remove.
    const trees = new Map(ids.map((id) => [id, sessionTreeIDs(ctx.data.session.list(), id)]))

    // Re-checked per id right before its remove: a session that started working after it was selected is never deleted.
    const busy = (id: string) =>
      skipId(
        connected(ctx),
        [id, ...ctx.data.session.family(id)].some((item) => sessionBusy(ctx.data, item)),
      )

    if (!connected(ctx)) return showBulkOffline("delete", ids)
    setBulkProgress({ done: 0, total: ids.length })

    try {
      const result = await runBulk(
        ids,
        async (id) => {
          await ctx.data.session.remove(id)
        },
        {
          isBusy: busy,
          proceed: () => home.server.focusedContext() === ctx,
          onProgress: (done, total) => setBulkProgress({ done, total }),
        },
      )

      const gone = new Set([...result.ok, ...result.missing])
      queryClient.setQueryData<SessionInfo[]>(["home-sessions", conn], (current) =>
        current?.filter((item) => !gone.has(item.id)),
      )
      void queryClient.invalidateQueries({ queryKey: ["home-sessions", conn], exact: true })
      notifySessionTabsRemoved({ server, directory, sessionIDs: [...gone].flatMap((id) => trees.get(id) ?? [id]) })
      showBulkSummary("delete", result)

      if (alive) finishBulk(result)
    } finally {
      setBulkProgress(undefined)
    }
  }

  function BulkDeleteDialog(props: {
    ids: string[]
    tabs: number
    ctx: ReturnType<typeof home.server.focusedContext>
  }) {
    // The dialog stays mounted through its exit animation, so a second activation must not rerun the batch.
    const [confirmed, setConfirmed] = createSignal(false)

    const confirm = async () => {
      if (confirmed()) return
      setConfirmed(true)
      dialog.close()
      await bulkDelete(props.ids, props.ctx)
    }

    return (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.plural("home.sessions.bulk.delete.title", props.ids.length)}
            description={
              <>
                <span class="block">{language.plural("home.sessions.bulk.delete.description", props.ids.length)}</span>
                <Show when={props.tabs > 0}>
                  <span class="block">{language.plural("home.sessions.bulk.delete.tabs", props.tabs)}</span>
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
            {language.plural("home.sessions.bulk.delete.button", props.ids.length)}
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  const showBulkDelete = (ids: string[]) => {
    const conn = home.server.focused()
    const ctx = home.server.focusedContext()

    if (!conn || !ctx || ids.length === 0) return
    const server = ServerConnection.key(conn)
    const sessions = ctx.data.session.list()

    // Snapshot at open: the count describes the selection the user is confirming.
    const open = ids.filter((id) =>
      sessionTreeIDs(sessions, id).some((item) => sessionIDHasOpenTab(tabs.store, server, item)),
    ).length

    return dialog.show(() => <BulkDeleteDialog ids={ids} tabs={open} ctx={ctx} />)
  }

  function DeleteDialog(props: { server: ServerConnection.Key; session: SessionInfo }) {
    const name = () => sessionTitle(props.session.title) ?? language.t("command.session.new")

    const confirm = async () => {
      dialog.close()
      await remove(props.server, props.session)
    }

    return (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.delete.title")}
            description={language.t("session.delete.confirm", { name: name() })}
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" autofocus onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="danger" onClick={confirm}>
            {language.t("session.delete.button")}
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  return {
    copy: {
      language,
    },
    data: {
      records,
      groups,
      loading: () => sessionLoad.isPending,
      searchRecords: allRecords,
    },
    platform: {
      desktop: platform.platform === "desktop",
    },
    location: {
      value: location,
      sync: syncLocations,
    },
    session: {
      showProjectName: () => !home.project.selected(),
      server: () => home.selection.value().server,
      canCreate: () => !!home.project.newSession(),
      lookup: async (sessionID: string) => {
        const ctx = home.server.focusedContext()

        if (!ctx) return
        const result = await ctx.sdk.api.session.get({ sessionID })

        if (result.time.archived !== undefined) return

        return buildHomeSessionRecords({
          sessions: () => [result],
          projectDirectories,
          projects: home.project.list,
          resolveProject: ctx.projects.forSession,
        })[0]
      },
      create: home.project.openNewSession,
      open: (session: SessionInfo, options?: OpenSessionOptions) => {
        const project = homeProjectForSession(session, home.project.list())
        const conn = home.server.focused()

        if (!conn) return
        const connKey = ServerConnection.key(conn)
        const directory = project?.worktree ?? session.location.directory
        const ctx = home.server.focusedContext()

        if (!ctx) return

        if (!options?.background) void ctx.data.session.message.sync(session.id).catch(() => undefined)
        // Commit cache/project changes with navigation instead of rebuilding
        // the outgoing Home list before leaving it.
        void startTransition(() => {
          const tab = tabs.addSessionTab({ server: connKey, sessionId: session.id })

          if (!options?.background) tabs.select(tab)
          ctx.data.session.remember(session)

          if (!options?.background) ctx.projects.touch(directory)
        })
      },
      archive: async (session: SessionInfo) => {
        const conn = home.server.focused()
        const ctx = home.server.focusedContext()

        if (!conn || !ctx) return
        await archiveHomeSession(
          { server: ServerConnection.key(conn), session },
          {
            archiveSession: global.sessionArchive.archiveSession,
            remove: () => ctx.data.session.evict(session.id),
            notifyTabsRemoved: (detail) =>
              notifySessionTabsRemoved({
                ...detail,
                server: detail.server as ServerConnection.Key,
                sessionIDs: [...detail.sessionIDs],
              }),
            isActive: () => home.server.focusedContext() === ctx,
          },
        )
      },
      rename,
      export: exportSession,
      showDelete: (server: ServerConnection.Key, session: SessionInfo) =>
        dialog.show(() => <DeleteDialog server={server} session={session} />),
    },
    bulk: {
      on: () => selection.store.on,
      count: () => selection.store.ids.length,
      total: () => selectable().size,
      progress: bulkProgress,
      isSelected: (id: string) => selection.store.ids.includes(id),
      isSelectable: (id: string) => selectable().has(id),
      enter: selection.enter,
      exit: selection.exit,
      toggle: (id: string, shift: boolean) => selection.toggle(id, shift, order(), (item) => selectable().has(item)),
      selectAll: () => selection.selectAll([...selectable()]),
      archive: () => bulkArchive([...selection.store.ids]),
      showDelete: () => showBulkDelete([...selection.store.ids]),
    },
    tab: {
      isOpen: (record: HomeSessionRecord) => {
        const server = home.selection.value().server

        return !!server && sessionHasOpenTab(tabs.store, server, record.session)
      },
    },
  }
}

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

const HOME_ROW_SELECTOR = '[data-component="home-session-row-container"]'

function homeRowTops() {
  return new Map(
    Array.from(document.querySelectorAll<HTMLElement>(HOME_ROW_SELECTOR), (row) => {
      return [row.dataset.sessionId, row.getBoundingClientRect().top] as const
    }),
  )
}

// FLIP: rows below a removed row jump up in layout; play the difference back as a short transform.
function animateHomeRowsUp(tops: Map<string | undefined, number>) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return

  document.querySelectorAll<HTMLElement>(HOME_ROW_SELECTOR).forEach((row) => {
    const before = tops.get(row.dataset.sessionId)
    const delta = before === undefined ? 0 : before - row.getBoundingClientRect().top
    if (delta === 0) return
    row.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
      duration: 180,
      easing: "cubic-bezier(0.645, 0.045, 0.355, 1)",
    })
  })
}

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.location.directory)}:${record.session.id}`
}

// Calendar day in the local time zone, comparable as a number.
function localDay(date: Date) {
  return date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate()
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = new Date()
  const today = localDay(now)
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const day = (record: HomeSessionRecord) =>
    localDay(new Date(record.session.time.updated ?? record.session.time.created))
  const todaySessions = records.filter((record) => day(record) === today)
  const yesterdaySessions = records.filter((record) => day(record) === yesterday)
  const olderSessions = records.filter((record) => day(record) !== today && day(record) !== yesterday)

  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")

  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

export type HomeSessionsController = ReturnType<typeof createHomeSessionsController>

export function HomeSessionStatusController(props: {
  server: ServerConnection.Key
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  render: (state: { unread: Accessor<boolean>; loading: Accessor<boolean>; open: Accessor<boolean> }) => JSX.Element
}) {
  const avatar = useSessionTabAvatarState(
    () => props.server,
    () => props.record.session.id,
    () => true,
    // Home rows can come from the fetched index before the session is loaded.
    () => props.record.session,
  )

  return props.render({
    unread: avatar.unread,
    loading: avatar.loading,
    open: () => props.isOpenTab(props.record),
  })
}
