import fuzzysort from "fuzzysort"
import { createEffect, createMemo, createResource, on } from "solid-js"
import { createMutable, createStore } from "solid-js/store"
import { createList } from "solid-list"

export interface FilteredListProps<T> {
  items: T[] | ((filter: string) => T[] | Promise<T[]>)
  key: (item: T) => string
  filterKeys?: string[]
  current?: T
  groupBy?: (x: T) => string
  sortBy?: (a: T, b: T) => number
  sortGroupsBy?: (a: { category: string; items: T[] }, b: { category: string; items: T[] }) => number
  skipFilter?: (item: T) => boolean
  onSelect?: (value: T | undefined, index: number) => void
  noInitialSelection?: boolean
  preserveActiveKey?: boolean
}

export function groupItems<T>(
  items: T[],
  props: Pick<FilteredListProps<T>, "groupBy" | "sortBy" | "sortGroupsBy">,
) {
  // A plain object keeps the group order of `Object.entries`, where numeric-looking categories sort first.
  const byCategory: Record<string, T[]> = {}

  for (const item of items) {
    const category = props.groupBy ? props.groupBy(item) : ""
    byCategory[category] ??= []
    byCategory[category].push(item)
  }

  const groups = Object.entries(byCategory).map(([category, group]) => ({
    category,
    items: props.sortBy ? group.sort(props.sortBy) : group,
  }))

  return props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups
}

export function useFilteredList<T>(props: FilteredListProps<T>) {
  const [store, setStore] = createStore<{ filter: string }>({ filter: "" })

  type Group = { category: string; items: T[] }

  const empty: Group[] = []
  const stableGroups = new Map<string, Group>()
  let committedFilter: string | undefined
  let filterChanged = false
  let previousGroups = empty

  const search = (all: T[], needle: string) => {
    const skipFilter = props.skipFilter
    const filterable = skipFilter ? all.filter((item) => !skipFilter(item)) : all
    const skipped = skipFilter ? all.filter(skipFilter) : []

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- plain string lists have no keys to search by
    const strings = !props.filterKeys && filterable.every((e) => typeof e === "string")

    // SAFETY: when `strings` holds, every element is a string, so the matched targets are the items.
    const filtered = strings
      ? (fuzzysort.go(needle, filterable as string[]).map((x) => x.target) as T[])
      : fuzzysort.go(needle, filterable, { keys: props.filterKeys! }).map((x) => x.obj)

    return skipped.length ? [...filtered, ...skipped] : filtered
  }

  const [grouped, { refetch }] = createResource(
    () => ({
      filter: store.filter,
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `items` is either a list or a loader for one
      items: typeof props.items === "function" ? props.items(store.filter) : props.items,
    }),
    async ({ filter, items }) => {
      const query = filter ?? ""
      const needle = query.toLowerCase()
      const all = (await Promise.resolve(items)) || []

      const matched = needle ? search(all, needle) : all

      return groupItems(matched, props)
    },
    { initialValue: empty },
  )

  const committedGroups = createMemo(() => {
    const next = grouped()
    filterChanged = committedFilter !== undefined && committedFilter !== store.filter
    committedFilter = store.filter
    if (!props.preserveActiveKey) return next
    if (filterChanged) stableGroups.clear()
    const categories = new Set(next.map((group) => group.category))
    for (const category of stableGroups.keys()) if (!categories.has(category)) stableGroups.delete(category)
    return next.map((group) => {
      const existing = stableGroups.get(group.category)
      if (existing) {
        existing.items = group.items
        return existing
      }
      const stable = createMutable(group)
      stableGroups.set(group.category, stable)
      return stable
    })
  })

  const flat = createMemo(() => committedGroups().flatMap((x) => x.items))
  const filteredGroups = committedGroups as typeof committedGroups & { readonly latest: Group[]; readonly loading: boolean }
  Object.defineProperties(filteredGroups, {
    latest: { get: committedGroups },
    loading: { get: () => grouped.loading },
  })

  // Lists open on their first row; `current` only marks the selected item.
  const list = createList({
    items: () => flat().map(props.key),
    initialActive: props.noInitialSelection ? "" : flat()[0] ? props.key(flat()[0]) : "",
    loop: true,
  })

  const reset = (all = flat()) => {
    if (props.noInitialSelection) {
      list.setActive("")
      return
    }

    if (all.length === 0) {
      if (props.preserveActiveKey) list.setActive("")
      return
    }
    list.setActive(props.key(all[0]))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const selectedIndex = flat().findIndex((x) => props.key(x) === list.active())
      const selected = flat()[selectedIndex]

      if (selected) props.onSelect?.(selected, selectedIndex)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "n" || event.key === "p") {
        event.preventDefault()

        const navEvent = new KeyboardEvent("keydown", {
          key: event.key === "n" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
        })

        list.onKeyDown(navEvent)
      }
    } else {
      // Skip list navigation for text editing shortcuts (e.g., Option+Arrow, Option+Backspace on macOS)
      if (event.altKey || event.metaKey) return
      list.onKeyDown(event)
    }
  }

  createEffect(
    on(grouped, () => {
      const next = committedGroups()
      const active = list.active()
      const previousHadRows = previousGroups.some((group) => group.items.length > 0)
      const keepActive =
        props.preserveActiveKey &&
        !filterChanged &&
        (active ? next.some((group) => group.items.some((item) => props.key(item) === active)) : previousHadRows)
      if (!keepActive) reset(next.flatMap((group) => group.items))
      previousGroups = next
    }),
  )

  const onInput = (value: string) => {
    setStore("filter", value)
  }

  return {
    grouped: filteredGroups,
    filter: () => store.filter,
    flat,
    reset,
    refetch,
    clear: () => setStore("filter", ""),
    onKeyDown,
    onInput,
    active: list.active,
    setActive: list.setActive,
  }
}
