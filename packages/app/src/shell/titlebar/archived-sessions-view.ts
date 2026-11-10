import type { ArchivedSessionsState } from "./archived-sessions-model"

export type ArchivedSessionsView = Readonly<{
  message: "loading" | "error" | "loaded-no-match" | "loaded-empty" | undefined
  loadMoreEnabled: boolean
  retryEnabled: boolean
}>

export function selectArchivedSessionsView(
  input: Readonly<{
    status: ArchivedSessionsState["status"]
    visibleSessionCount: number
    filter: string
    nextCursor?: string
    restoringID?: string
    continuationError?: unknown
    continuationPending?: boolean
    bulkRunning?: boolean
  }>,
): ArchivedSessionsView {
  const ready = input.status === "ready"

  const canContinue =
    ready && !!input.nextCursor && !input.restoringID && !input.bulkRunning && !input.continuationPending

  const message =
    input.status === "loading"
      ? "loading"
      : input.status === "error"
        ? "error"
        : ready && input.visibleSessionCount === 0
          ? input.filter.trim()
            ? "loaded-no-match"
            : "loaded-empty"
          : undefined

  return {
    message,
    loadMoreEnabled: canContinue && !input.continuationError,
    retryEnabled: input.status === "error" || (canContinue && !!input.continuationError),
  }
}

export type RowAria = Readonly<{ role?: "checkbox"; "aria-checked"?: "true" | "false"; "aria-disabled"?: "true" }>

export function rowAria(input: Readonly<{ on: boolean; selected: boolean; selectable: boolean }>): RowAria {
  if (!input.on) return {}

  return {
    role: "checkbox",
    "aria-checked": input.selected ? "true" : "false",
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- The attribute must be absent, not "false", on a selectable row.
    ...(input.selectable ? {} : { "aria-disabled": "true" as const }),
  }
}
