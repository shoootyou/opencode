/**
 * @spec-handoff
 * @interface useFilteredList({ items, key, preserveActiveKey? }): FilteredList
 * @behavior
 *   - Default callers reset selection and recreate groups after item updates.
 *   - Opted-in unchanged-filter appends retain active key and the existing group object.
 *   - Opted-in filter changes or removed active keys reset to the first matching row without selecting after an intentional clear.
 *   - An obsolete async filter completion cannot overwrite a newer committed opted-in group, rows, or active key.
 * @edge-cases
 *   - New items append without changing the active row's key.
 * @see RFC 057 D.3.15, AP8
 */
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- SAFETY: the accepted optional prop does not exist until Kou implements it; this test deliberately states that pending public contract.
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { useFilteredList } from "./use-filtered-list"

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test("keeps the default reset behavior after an unchanged-filter item append", async () => {
  let dispose!: () => void
  let setItems!: (items: { id: string }[]) => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((rootDispose) => {
    dispose = rootDispose
    const [items, set] = createSignal([{ id: "first" }, { id: "third" }])
    setItems = set
    list = useFilteredList({ items, key: (item) => item.id })
  })
  await flush()
  list.setActive("third")
  const group = list.grouped.latest[0]
  setItems([{ id: "first" }, { id: "third" }, { id: "new" }])
  await flush()
  expect(list.active()).toBe("first")
  expect(list.grouped.latest[0]).not.toBe(group)
  list.onKeyDown({
    altKey: false,
    ctrlKey: false,
    key: "ArrowUp",
    metaKey: false,
    preventDefault: () => {},
    shiftKey: false,
  } as KeyboardEvent)
  expect(list.active()).toBe("new")
  dispose()
})

test("preserves the active key and group object for opted-in unchanged-filter append", async () => {
  let dispose!: () => void
  let setItems!: (items: { id: string }[]) => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((rootDispose) => {
    dispose = rootDispose
    const [items, set] = createSignal([{ id: "first" }, { id: "third" }])
    setItems = set
    list = useFilteredList({
      items,
      key: (item: { id: string }) => item.id,
      preserveActiveKey: true,
    } as unknown as Parameters<typeof useFilteredList<{ id: string }>>[0])
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

test("resets opted-in selection to the first matching row when filtering removes its key", async () => {
  let dispose!: () => void
  let setItems!: (items: { id: string }[]) => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((rootDispose) => {
    dispose = rootDispose
    const [items, set] = createSignal([{ id: "alpha" }, { id: "beta" }])
    setItems = set
    list = useFilteredList({ items, key: (item) => item.id, preserveActiveKey: true } as unknown as Parameters<
      typeof useFilteredList<{ id: string }>
    >[0])
  })
  await flush()
  list.setActive("alpha")
  list.onInput("beta")
  await flush()
  expect(list.active()).toBe("beta")
  dispose()
})

test("resets opted-in selection to the first row when the selected row disappears", async () => {
  let dispose!: () => void
  let setItems!: (items: { id: string }[]) => void
  let list!: ReturnType<typeof useFilteredList<{ id: string }>>
  createRoot((rootDispose) => {
    dispose = rootDispose
    const [items, set] = createSignal([{ id: "alpha" }, { id: "beta" }])
    setItems = set
    list = useFilteredList({ items, key: (item) => item.id, preserveActiveKey: true } as unknown as Parameters<
      typeof useFilteredList<{ id: string }>
    >[0])
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
  createRoot((rootDispose) => {
    dispose = rootDispose
    const [items, set] = createSignal([{ id: "first" }])
    setItems = set
    list = useFilteredList({ items, key: (item) => item.id, preserveActiveKey: true } as unknown as Parameters<
      typeof useFilteredList<{ id: string }>
    >[0])
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
    createRoot((rootDispose) => {
      dispose = rootDispose
      list = useFilteredList({
        items: (filter) => {
          calls.push(filter)
          if (!filter) return [{ id: "a" }]
          return filter === "older" ? older.promise : newer.promise
        },
        key: (item) => item.id,
        preserveActiveKey: true,
        skipFilter: () => true,
      } as unknown as Parameters<typeof useFilteredList<{ id: string }>>[0])
    })
    await flush()
    expect(list.flat().map((item) => item.id)).toEqual(["a"])
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
    expect(list.flat().map((item) => item.id)).toEqual(["a", "c"])
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
