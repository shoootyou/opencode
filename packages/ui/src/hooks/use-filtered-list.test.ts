import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { groupItems, useFilteredList } from "./use-filtered-list"

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test("keeps the first row selected by default after an item append", async () => {
  let dispose!: () => void
  let setItems!: (items: { id: string }[]) => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((stop) => {
    dispose = stop
    const [items, set] = createSignal([{ id: "first" }, { id: "third" }])
    setItems = set
    list = useFilteredList({ items, key: (item) => item.id })
  })
  await flush()
  list.setActive("third")
  setItems([{ id: "first" }, { id: "third" }, { id: "new" }])
  await flush()
  expect(list.active()).toBe("first")
  dispose()
})

test("preserves the active key for opted-in unchanged-filter appends", async () => {
  let dispose!: () => void
  let setItems!: (items: { id: string }[]) => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((stop) => {
    dispose = stop
    const [items, set] = createSignal([{ id: "first" }, { id: "third" }])
    setItems = set
    list = useFilteredList({ items, key: (item) => item.id, preserveActiveKey: true })
  })
  await flush()
  list.setActive("third")
  const group = list.grouped.latest[0]
  setItems([{ id: "first" }, { id: "third" }, { id: "new" }])
  await flush()
  expect(list.active()).toBe("third")
  expect(list.grouped.latest[0]).toBe(group)
  dispose()
})

test("does not initially select when opted out", async () => {
  let dispose!: () => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((stop) => {
    dispose = stop
    const [items] = createSignal([{ id: "first" }])
    list = useFilteredList({ items, key: (item) => item.id, noInitialSelection: true })
  })
  await flush()
  expect(list.active()).toBe("")
  dispose()
})

test("retains default active selection across an empty update before later rows reset and wrap", async () => {
  let dispose!: () => void
  let setItems!: (items: { id: string }[]) => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((stop) => {
    dispose = stop
    const [items, set] = createSignal([{ id: "first" }, { id: "second" }])
    setItems = set
    list = useFilteredList({ items, key: (item) => item.id })
  })
  await flush()
  list.setActive("second")
  setItems([])
  await flush()
  expect(list.active()).toBe("second")
  setItems([{ id: "third" }, { id: "fourth" }])
  await flush()
  expect(list.active()).toBe("third")
  list.onKeyDown({
    altKey: false,
    ctrlKey: false,
    key: "ArrowUp",
    metaKey: false,
    preventDefault: () => {},
    shiftKey: false,
  } as KeyboardEvent)
  expect(list.active()).toBe("fourth")
  dispose()
})

test("resets opted-in selection to the first matching row when filtering removes its key", async () => {
  let dispose!: () => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((stop) => {
    dispose = stop
    const [items] = createSignal([{ id: "alpha" }, { id: "beta" }])
    list = useFilteredList({ items, key: (item) => item.id, filterKeys: ["id"], preserveActiveKey: true })
  })
  await flush()
  list.setActive("alpha")
  list.onInput("beta")
  await flush()
  expect(list.active()).toBe("beta")
  list.onInput("missing")
  await flush()
  expect(list.flat().map((item) => item.id)).toEqual([])
  expect(list.active()).toBe("")
  dispose()
})

test("resets opted-in selection to the first row when the selected row disappears", async () => {
  let dispose!: () => void
  let setItems!: (items: { id: string }[]) => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((stop) => {
    dispose = stop
    const [items, set] = createSignal([{ id: "alpha" }, { id: "beta" }])
    setItems = set
    list = useFilteredList({ items, key: (item) => item.id, preserveActiveKey: true })
  })
  await flush()
  list.setActive("beta")
  setItems([{ id: "alpha" }])
  await flush()
  expect(list.active()).toBe("alpha")
  dispose()
})

test("preserves intentional no-selection through an opted-in unchanged-filter append", async () => {
  let dispose!: () => void
  let setItems!: (items: { id: string }[]) => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((stop) => {
    dispose = stop
    const [items, set] = createSignal([{ id: "first" }])
    setItems = set
    list = useFilteredList({ items, key: (item) => item.id, preserveActiveKey: true })
  })
  await flush()
  list.setActive("")
  setItems([{ id: "first" }, { id: "second" }])
  await flush()
  expect(list.active()).toBe("")
  dispose()
})

for (const outcome of ["resolve", "reject"] as const) {
  test(`keeps the newer committed group when an older held filter result ${outcome}s later`, async () => {
    const older = Promise.withResolvers<{ id: string }[]>()
    const newer = Promise.withResolvers<{ id: string }[]>()
    const calls: string[] = []
    let dispose!: () => void
    let list!: ReturnType<typeof useFilteredList<{ id: string }>>
    createRoot((stop) => {
      dispose = stop
      list = useFilteredList({
        items: (filter) => {
          calls.push(filter)
          return !filter ? [{ id: "a" }] : filter === "older" ? older.promise : newer.promise
        },
        key: (item) => item.id,
        preserveActiveKey: true,
        skipFilter: () => true,
      })
    })
    await flush()
    list.onInput("older")
    await flush()
    list.onInput("newer")
    await flush()
    expect(calls).toEqual(["", "older", "newer"])
    newer.resolve([{ id: "a" }, { id: "c" }])
    await flush()
    await flush()
    const group = list.grouped.latest[0]
    const rows = group.items
    list.setActive("c")
    if (outcome === "resolve") older.resolve([{ id: "a" }, { id: "b" }])
    else older.reject(new Error("obsolete filter"))
    await flush()
    await flush()
    expect(list.flat().map((item) => item.id)).toEqual(["a", "c"])
    expect(list.grouped.latest[0]).toBe(group)
    expect(list.grouped.latest[0].items).toBe(rows)
    expect(list.active()).toBe("c")
    dispose()
  })
}

for (const outcome of ["resolve", "reject"] as const) {
  test(`keeps the current group after an obsolete same-filter source ${outcome}s`, async () => {
    type Row = { id: string }
    const a: Row = { id: "a" }
    const b: Row = { id: "b" }
    const c: Row = { id: "c" }
    const older = Promise.withResolvers<Row[]>()
    const newer = Promise.withResolvers<Row[]>()
    const calls: string[] = []
    let dispose!: () => void
    let setSource!: (source: Promise<Row[]>) => void
    let list!: ReturnType<typeof useFilteredList<Row>>
    createRoot((stop) => {
      dispose = stop
      const [source, set] = createSignal<Promise<Row[]>>(Promise.resolve([a]))
      setSource = set
      list = useFilteredList({
        items: (filter) => {
          calls.push(filter)
          return source()
        },
        key: (row) => row.id,
        preserveActiveKey: true,
      })
    })
    for (let index = 0; index < 8; index++) await Promise.resolve()
    setSource(older.promise)
    for (let index = 0; index < 8; index++) await Promise.resolve()
    setSource(newer.promise)
    for (let index = 0; index < 8; index++) await Promise.resolve()
    newer.resolve([a, c])
    for (let index = 0; index < 8; index++) await Promise.resolve()
    expect(calls).toEqual(["", "", ""])
    expect(list.flat().map((row) => row.id)).toEqual(["a", "c"])
    const group = list.grouped.latest[0]
    const rows = group.items
    list.setActive("c")
    if (outcome === "resolve") older.resolve([a, b])
    else older.reject(new Error("obsolete source"))
    for (let index = 0; index < 8; index++) await Promise.resolve()
    expect(group.items.map((row) => row.id)).toEqual(["a", "c"])
    expect(list.flat().map((row) => row.id)).toEqual(["a", "c"])
    expect(list.grouped.latest[0]).toBe(group)
    expect(group.items).toBe(rows)
    expect(list.active()).toBe("c")
    dispose()
  })
}

test("groups under one empty category without a groupBy", () => {
  expect(groupItems(["b", "a"], {})).toEqual([{ category: "", items: ["b", "a"] }])
})

test("keeps item order within a group and first-seen order between groups", () => {
  const items = [
    { name: "x1", group: "x" },
    { name: "y1", group: "y" },
    { name: "x2", group: "x" },
  ]

  expect(groupItems(items, { groupBy: (item) => item.group }).map((g) => [g.category, g.items.map((i) => i.name)])).toEqual([
    ["x", ["x1", "x2"]],
    ["y", ["y1"]],
  ])
})

test("lists numeric-looking categories first, as object keys do", () => {
  expect(groupItems(["b", "10", "a", "2"], { groupBy: (item) => item }).map((g) => g.category)).toEqual([
    "2",
    "10",
    "b",
    "a",
  ])
})

test("sorts items within groups and then the groups", () => {
  const groups = groupItems([3, 1, 4, 2], {
    groupBy: (n) => (n % 2 ? "odd" : "even"),
    sortBy: (a, b) => a - b,
    sortGroupsBy: (a, b) => a.category.localeCompare(b.category),
  })

  expect(groups).toEqual([
    { category: "even", items: [2, 4] },
    { category: "odd", items: [1, 3] },
  ])
})
