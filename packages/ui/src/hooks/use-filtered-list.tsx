import fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, map, pipe } from "remeda"
import { createEffect, createMemo, createResource, on } from "solid-js"
import { createMutable, createStore } from "solid-js/store"
import { createList } from "solid-list"

// oxlint-disable anti-slop/require-readable-spacing -- Committed resource reconciliation keeps each identity transition contiguous.

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

export function useFilteredList<T>(props: FilteredListProps<T>) {
  const [store, setStore] = createStore<{ filter: string }>({ filter: "" })

  type Group = { category: string; items: T[] }

  const empty: Group[] = []
  const stableGroups = new Map<string, Group>()
  let previousCommittedFilter: string | undefined
  let filterChanged = false
  let previousGroups = empty

  const [resource, { refetch }] = createResource(
    () => ({
      filter: store.filter,
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: items is this hook's typed synchronous-or-async source union.
      items: typeof props.items === "function" ? props.items(store.filter) : props.items,
    }),
    async ({ filter, items }) => {
      const query = filter ?? ""
      const needle = query.toLowerCase()
      const all = (await Promise.resolve(items)) || []

      const result = pipe(
        all,
        (x) => {
          if (!needle) return x
          const skipFilter = props.skipFilter
          const filterable = skipFilter ? x.filter((item) => !skipFilter(item)) : x
          const skipped = skipFilter ? x.filter(skipFilter) : []

          const stringItems =
            !props.filterKeys &&
            Array.isArray(filterable) &&
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the string-array branch is selected only after every source item is verified as a string.
            filterable.every((item) => typeof item === "string")

          // SAFETY: stringItems verifies fuzzysort receives string targets before their typed items are restored.
          const filtered = stringItems
            ? (fuzzysort.go(needle, filterable).map((x) => x.target) as T[])
            : fuzzysort.go(needle, filterable, { keys: props.filterKeys! }).map((x) => x.obj)

          return skipped.length ? [...filtered, ...skipped] : filtered
        },
        groupBy((x) => (props.groupBy ? props.groupBy(x) : "")),
        entries(),
        map(([k, v]) => ({ category: k, items: props.sortBy ? v.sort(props.sortBy) : v })),
        (groups) => (props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups),
      )

      return { filter, result }
    },
    { initialValue: { filter: "", result: empty } },
  )

  const groupedMemo = createMemo(() => {
    const next = resource()
    filterChanged = previousCommittedFilter !== undefined && previousCommittedFilter !== next.filter
    previousCommittedFilter = next.filter
    if (!props.preserveActiveKey) return next.result
    if (filterChanged) stableGroups.clear()
    const categories = new Set(next.result.map((group) => group.category))
    for (const category of stableGroups.keys()) if (!categories.has(category)) stableGroups.delete(category)
    return next.result.map((group) => {
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

  // SAFETY: this accessor exposes the resource-compatible properties List consumes while reading only committed groups.
  const grouped = (() => groupedMemo()) as (() => Group[]) & { readonly latest: Group[]; readonly loading: boolean }
  Object.defineProperty(grouped, "latest", { get: groupedMemo })
  Object.defineProperty(grouped, "loading", { get: () => resource.loading })

  const flat = createMemo(() => {
    return pipe(
      grouped(),
      flatMap((x) => x.items),
    )
  })

  function initialActive() {
    if (props.noInitialSelection) return ""

    if (props.current) return props.key(props.current)

    const items = flat()

    if (items.length === 0) return ""

    return props.key(items[0])
  }

  const list = createList({
    items: () => flat().map(props.key),
    initialActive: initialActive(),
    loop: true,
  })

  const reset = (items = flat()) => {
    if (props.noInitialSelection) {
      list.setActive("")

      return
    }

    if (items.length === 0) {
      if (props.preserveActiveKey) list.setActive("")
      return
    }
    list.setActive(props.key(items[0]))
  }

  createEffect(
    on(resource, () => {
      const next = grouped()
      const active = list.active()
      const previousHadRows = previousGroups.some((group) => group.items.length > 0)
      const keepActive =
        props.preserveActiveKey &&
        !filterChanged &&
        (active ? next.some((group) => group.items.some((item) => props.key(item) === active)) : previousHadRows)
      if (!keepActive) reset()
      previousGroups = next
    }),
  )

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

  const onInput = (value: string) => {
    setStore("filter", value)
  }

  return {
    grouped,
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
