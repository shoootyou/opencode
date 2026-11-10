import { Button } from "@opencode/ui/button"
import { Checkbox } from "@opencode/ui/checkbox"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { useLanguage } from "@/runtime/i18n/language"
import { nextSelection, pruneSelection } from "./bulk"

type SelectionStore = { on: boolean; ids: string[]; anchor?: string }

export function createSelection() {
  const [store, setStore] = createStore<SelectionStore>({ on: false, ids: [], anchor: undefined })

  const set = (ids: string[], anchor?: string) => setStore({ ids, anchor })

  return {
    store,
    enter: (id?: string) => setStore({ on: true, ids: id === undefined ? [] : [id], anchor: id }),
    exit: () => setStore({ on: false, ids: [], anchor: undefined }),
    toggle: (id: string, shift: boolean, order: readonly string[], selectable: (id: string) => boolean) => {
      const next = nextSelection(store, { id, shift, order, selectable })

      set(next.ids, next.anchor)
    },
    selectAll: (ids: string[]) => set(ids, undefined),
    prune: (valid: ReadonlySet<string>) => set(pruneSelection(store.ids, valid), store.anchor),
    clear: () => set([], undefined),
  }
}

export type Selection = ReturnType<typeof createSelection>

/** Visual only: the row button carries the checkbox role, so this must stay out of the tab order and the a11y tree. */
export function SelectionBox(props: { checked: boolean }) {
  return (
    <span aria-hidden="true" inert class="pointer-events-none">
      <Checkbox checked={props.checked} />
    </span>
  )
}

export function SelectionBar(props: {
  language: Pick<ReturnType<typeof useLanguage>, "plural" | "t">
  selected: number
  total: number
  progress: { done: number; total: number } | undefined
  onSelectAll: () => void
  // The primary action (Archive on Home); `primaryLabel` lets another list name it differently.
  onArchive: () => void
  primaryLabel?: string
  onDelete: () => void
  onDone: () => void
}) {
  const idle = () => props.progress === undefined
  const empty = () => props.selected === 0 || !idle()

  return (
    <div
      data-component="home-selection-bar"
      role="toolbar"
      aria-label={props.language.t("home.sessions.select")}
      class="sticky bottom-0 z-30 flex h-14 items-center gap-2 border-t border-v2-border-border-base bg-v2-background-bg-base px-2"
    >
      <span aria-live="polite" class="min-w-0 flex-1 truncate text-v2-text-text-base [font-weight:530]">
        <Show when={props.progress} fallback={props.language.plural("home.sessions.bulk.selected", props.selected)}>
          {(progress) =>
            `${props.language.t("home.sessions.bulk.busy")} ${props.language.t("home.sessions.bulk.progress", progress())}`
          }
        </Show>
      </span>
      <Button
        variant="ghost-muted"
        size="normal"
        disabled={!idle() || props.selected >= props.total}
        onClick={props.onSelectAll}
      >
        {props.language.t("home.sessions.bulk.selectAll")}
      </Button>
      <Button variant="neutral" size="normal" disabled={empty()} onClick={props.onArchive}>
        {props.primaryLabel ?? props.language.t("common.archive")}
      </Button>
      <Button variant="ghost-danger" size="normal" disabled={empty()} onClick={props.onDelete}>
        {props.language.t("common.delete")}
      </Button>
      <Button variant="ghost-muted" size="normal" disabled={!idle()} onClick={props.onDone}>
        {props.language.t("home.sessions.bulk.done")}
      </Button>
    </div>
  )
}
