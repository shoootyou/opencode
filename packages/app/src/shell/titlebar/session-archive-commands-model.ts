import type { ArchiveSession, ArchiveTarget } from "@/session/archive"
import { isArchivedSession } from "@/session/archive"

export type ArchiveRoute =
  | Readonly<{ type: "session"; server: string; sessionID: string }>
  | Readonly<{ type: "draft"; server?: string }>
  | Readonly<{ type: "home" | "settings" | "connect" }>

export type ArchiveCommandInput = Readonly<{
  route: ArchiveRoute
  servers: readonly string[]
  selectedServer?: string
  session?: Readonly<{ server: string; info: ArchiveSession }>
  pending: boolean
}>

export type ArchiveCommandState = Readonly<{
  server?: string
  target?: ArchiveTarget
  canArchive: boolean
  canUnarchive: boolean
  canBrowse: boolean
}>

export type ArchiveCommandTextKey =
  | "command.category.session"
  | "command.session.archive"
  | "command.session.archive.description"
  | "command.session.unarchive"
  | "command.session.unarchive.description"
  | "command.session.archivedBrowse"
  | "command.session.archivedBrowse.description"

export type ArchiveCommandID = "session.archive" | "session.unarchive" | "session.archived.browse"

export type ArchiveCommandOption = Readonly<{
  id: ArchiveCommandID
  title: string
  description: string
  category: string
  keybind?: string
  featured?: boolean
  disabled: boolean
  onSelect: () => Promise<void>
}>

type ArchiveCommandRegistration = Readonly<{ key: "titlebar.session-archive"; options: () => ArchiveCommandOption[] }>

export function resolveArchiveServer(
  input: Pick<ArchiveCommandInput, "route" | "servers" | "selectedServer">,
): string | undefined {
  if (input.route.type === "session" || input.route.type === "draft")
    return input.route.server && input.servers.includes(input.route.server) ? input.route.server : undefined

  return input.selectedServer && input.servers.includes(input.selectedServer) ? input.selectedServer : input.servers[0]
}

export function getArchiveCommandState(input: ArchiveCommandInput): ArchiveCommandState {
  const server = resolveArchiveServer(input)
  const info = input.session?.info

  const target =
    server &&
    input.route.type === "session" &&
    input.session?.server === server &&
    info?.id === input.route.sessionID &&
    !info.parentID
      ? { server, sessionID: info.id }
      : undefined

  const pending = input.pending

  return {
    server,
    target,
    canArchive: !!target && !pending && !!info && !isArchivedSession(info),
    canUnarchive: !!target && !pending && !!info && isArchivedSession(info),
    canBrowse: !!server,
  }
}

export function createArchiveCommandRegistration(
  deps: Readonly<{
    read: () => ArchiveCommandInput
    t: (key: ArchiveCommandTextKey) => string
    archive?: (target: ArchiveTarget) => Promise<boolean>
    transition?: (target: ArchiveTarget) => Promise<boolean>
    unarchive: (target: ArchiveTarget) => Promise<boolean>
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Dialog opening is fire-and-forget; any framework-owned return value is intentionally ignored.
    browse: (server: string) => unknown
  }>,
): ArchiveCommandRegistration {
  const option = (id: ArchiveCommandID, action: "archive" | "unarchive" | "browse"): ArchiveCommandOption => {
    const input = deps.read()
    const state = getArchiveCommandState(input)
    // SAFETY: action is the closed command-action union, so this template produces a member of ArchiveCommandTextKey.
    const key = `command.session.${action === "browse" ? "archivedBrowse" : action}` as ArchiveCommandTextKey

    const eligible =
      // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- The closed action union selects a synchronous boolean and has no Effect result to match.
      action === "archive" ? state.canArchive : action === "unarchive" ? state.canUnarchive : state.canBrowse

    return {
      id,
      title: deps.t(key),
      // SAFETY: each command text key has a matching description key in the same closed key union.
      description: deps.t(`${key}.description` as ArchiveCommandTextKey),
      category: deps.t("command.category.session"),
      keybind: action === "archive" ? "mod+shift+backspace" : undefined,
      featured: action === "browse" || undefined,
      disabled: !eligible,
      onSelect: async () => {
        const current = getArchiveCommandState(deps.read())

        if (action === "archive" && current.canArchive && current.target && deps.transition)
          await deps.transition(current.target)

        if (action === "unarchive" && current.canUnarchive && current.target) await deps.unarchive(current.target)

        if (action === "browse" && current.canBrowse && current.server) await deps.browse(current.server)
      },
    }
  }

  return {
    key: "titlebar.session-archive",
    options: () => [
      option("session.archive", "archive"),
      option("session.unarchive", "unarchive"),
      option("session.archived.browse", "browse"),
    ],
  }
}
