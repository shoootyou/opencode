import type { ArchivedSessionsState } from "./archived-sessions-model"

export type ArchivedSessionsView = Readonly<{
  message: "loading" | "error" | "no-match" | "page-empty" | undefined
  previousEnabled: boolean
  nextEnabled: boolean
  resetEnabled: boolean
}>

export function selectArchivedSessionsView(input: Readonly<{
  status: ArchivedSessionsState["status"]
  visibleSessionCount: number
  filter: string
  previousCursor?: string
  nextCursor?: string
  restoringID?: string
}>): ArchivedSessionsView {
  const ready = input.status === "ready"
  const canChangePage = ready && !input.restoringID
  const message = input.status === "loading"
    ? "loading"
    : input.status === "error"
      ? "error"
      : ready && input.visibleSessionCount === 0
        ? input.filter.trim() ? "no-match" : "page-empty"
        : undefined

  return {
    message,
    previousEnabled: canChangePage && !!input.previousCursor,
    nextEnabled: canChangePage && !!input.nextCursor,
    resetEnabled: canChangePage,
  }
}
