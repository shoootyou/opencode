/**
 * @spec-handoff
 * @interface useFilteredList({ items, key, preserveActiveKey? }): FilteredList
 * @behavior
 *   - Default callers reset selection and recreate groups after item updates.
 *   - Opted-in unchanged-filter appends retain active key and the existing group object.
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
  setItems([{ id: "first" }, { id: "third" }, { id: "new" }])
  await flush()
  expect(list.active()).toBe("first")
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
    list = useFilteredList({ items, key: (item) => item.id, preserveActiveKey: true } as unknown as Parameters<
      typeof useFilteredList<{ id: string }>
    >[0])
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
