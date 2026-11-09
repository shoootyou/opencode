import { isSessionArchiveLimitError, isSessionNotFoundError } from "@opencode/client/promise"
import type { useLanguage } from "@/runtime/i18n/language"
import { isArchivedSession, type ArchiveSession } from "@/session/archive"

export type BulkResult = { ok: string[]; missing: string[]; failed: string[] }

export type BulkOptions = {
  isBusy?: (id: string) => boolean
  proceed?: () => boolean
  onProgress?: (done: number, total: number) => void
}

export type Selected = { ids: string[]; anchor?: string }

export type BulkSummary = { variant: "success" | "error"; title: string }

type Language = Pick<ReturnType<typeof useLanguage>, "plural" | "t">

const MAX_RETRY_WAIT_MS = 60_000

async function attempt(op: (id: string) => Promise<void>, id: string, retry = true): Promise<keyof BulkResult> {
  try {
    await op(id)

    return "ok"
  } catch (error) {
    if (isSessionNotFoundError(error)) return "missing"

    if (retry && isSessionArchiveLimitError(error) && error.kind === "rate" && error.retryAfterMillis !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(error.retryAfterMillis ?? 0, MAX_RETRY_WAIT_MS)))

      return attempt(op, id, false)
    }

    return "failed"
  }
}

/** Runs `op` for each id one at a time. Never throws and keeps no error text. */
export async function runBulk(
  ids: readonly string[],
  op: (id: string) => Promise<void>,
  options: BulkOptions = {},
): Promise<BulkResult> {
  const result: BulkResult = { ok: [], missing: [], failed: [] }
  let stopped = false
  let done = 0

  for (const id of ids) {
    if (options.proceed && !options.proceed()) stopped = true
    const skip = stopped || options.isBusy?.(id)
    const outcome = skip ? "failed" : await attempt(op, id)

    result[outcome].push(id)
    done++
    options.onProgress?.(done, ids.length)
  }

  return result
}

export function rangeSelect(
  order: readonly string[],
  anchor: string | undefined,
  target: string,
  selectable: (id: string) => boolean,
): string[] {
  const from = anchor === undefined ? -1 : order.indexOf(anchor)
  const to = order.indexOf(target)

  if (from < 0 || to < 0) return selectable(target) ? [target] : []

  return order.slice(Math.min(from, to), Math.max(from, to) + 1).filter(selectable)
}

export function isSelectable(session: ArchiveSession, busy: boolean): boolean {
  return !busy && !session.parentID && !isArchivedSession(session)
}

export function bulkSummary(kind: "archive" | "delete", result: BulkResult, language: Language): BulkSummary {
  const failed = result.failed.length
  const done = result.ok.length + result.missing.length

  if (failed === 0) {
    const key = kind === "archive" ? "home.sessions.bulk.archive.done" : "home.sessions.bulk.delete.done"

    return { variant: "success", title: language.plural(key, done) }
  }

  const key = kind === "archive" ? "home.sessions.bulk.archive.partial" : "home.sessions.bulk.delete.partial"

  return { variant: "error", title: language.t(key, { done, total: done + failed, failed }) }
}

export function nextSelection(
  state: Readonly<{ ids: readonly string[]; anchor?: string }>,
  input: { id: string; shift: boolean; order: readonly string[]; selectable: (id: string) => boolean },
): Selected {
  if (!input.selectable(input.id)) return { ids: [...state.ids], anchor: state.anchor }

  if (input.shift) {
    const kept = new Set(state.ids)
    const range = rangeSelect(input.order, state.anchor, input.id, input.selectable)
    const anchor = state.anchor !== undefined && input.order.includes(state.anchor) ? state.anchor : input.id

    return { ids: [...state.ids, ...range.filter((id) => !kept.has(id))], anchor }
  }

  const ids = state.ids.includes(input.id) ? state.ids.filter((id) => id !== input.id) : [...state.ids, input.id]

  return { ids, anchor: input.id }
}

export function pruneSelection(ids: readonly string[], valid: ReadonlySet<string>): string[] {
  return ids.filter((id) => valid.has(id))
}
