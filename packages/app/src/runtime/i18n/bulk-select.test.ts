/**
 * @spec-handoff
 * @interface en dictionary keys home.sessions.select, home.sessions.bulk.* (plural bases carry .one and .other) and dialog.archivedSessions.bulk.description
 * @behavior
 *   - The English dictionary defines the bulk-select copy below; other locales are not edited and fall back to English.
 *   - Every plural base defines both .one and .other, so language.plural resolves it.
 *   - Count-bearing plural strings keep {{count}}; partial-result strings keep {{done}}, {{total}} and {{failed}}.
 * @edge-cases
 *   - The delete description says sub-sessions are deleted too and forks are not.
 * @see ../../home/sessions/bulk.ts
 */
import { expect, test } from "bun:test"
import en from "./en"

const dictionary: Record<string, string> = en

const copy = {
  "home.sessions.select": "Select",
  "home.sessions.bulk.selectAll": "Select all",
  "home.sessions.bulk.done": "Done",
  "home.sessions.bulk.busy": "Working…",
  "home.sessions.bulk.progress": "{{done}} of {{total}}",
  "home.sessions.bulk.selected.one": "{{count}} selected",
  "home.sessions.bulk.selected.other": "{{count}} selected",
  "home.sessions.bulk.archive.done.one": "Archived {{count}} session",
  "home.sessions.bulk.archive.done.other": "Archived {{count}} sessions",
  "home.sessions.bulk.archive.partial": "Archived {{done}} of {{total}}, {{failed}} failed",
  "home.sessions.bulk.unarchive.done.one": "Unarchived {{count}} session",
  "home.sessions.bulk.unarchive.done.other": "Unarchived {{count}} sessions",
  "home.sessions.bulk.unarchive.partial": "Unarchived {{done}} of {{total}}, {{failed}} failed",
  "dialog.archivedSessions.bulk.description":
    "Select sessions to unarchive or delete them. Search covers loaded sessions only.",
  "home.sessions.bulk.delete.title.one": "Delete {{count}} session?",
  "home.sessions.bulk.delete.title.other": "Delete {{count}} sessions?",
  "home.sessions.bulk.delete.tabs.one": "{{count}} open tab will be closed",
  "home.sessions.bulk.delete.tabs.other": "{{count}} open tabs will be closed",
  "home.sessions.bulk.delete.button.one": "Delete {{count}} session",
  "home.sessions.bulk.delete.button.other": "Delete {{count}} sessions",
  "home.sessions.bulk.delete.done.one": "Deleted {{count}} session",
  "home.sessions.bulk.delete.done.other": "Deleted {{count}} sessions",
  "home.sessions.bulk.delete.partial": "Deleted {{done}} of {{total}}, {{failed}} failed",
} as const

const pluralBases = [
  "home.sessions.bulk.selected",
  "home.sessions.bulk.archive.done",
  "home.sessions.bulk.unarchive.done",
  "home.sessions.bulk.delete.title",
  "home.sessions.bulk.delete.description",
  "home.sessions.bulk.delete.tabs",
  "home.sessions.bulk.delete.button",
  "home.sessions.bulk.delete.done",
]

test.each(Object.entries(copy))("English defines %s with the exact copy", (key, value) => {
  expect(dictionary[key]).toBe(value)
})

test.each(pluralBases)("%s defines both .one and .other", (base) => {
  expect(dictionary[`${base}.one`]?.trim()).toBeTruthy()
  expect(dictionary[`${base}.other`]?.trim()).toBeTruthy()
})

test.each(pluralBases.filter((base) => !base.endsWith("description")))("%s shows the count in both forms", (base) => {
  expect(dictionary[`${base}.one`]).toContain("{{count}}")
  expect(dictionary[`${base}.other`]).toContain("{{count}}")
})

test.each([
  "home.sessions.bulk.archive.partial",
  "home.sessions.bulk.unarchive.partial",
  "home.sessions.bulk.delete.partial",
])("%s keeps the done, total and failed slots", (key) => {
  for (const slot of ["{{done}}", "{{total}}", "{{failed}}"]) expect(dictionary[key]).toContain(slot)
})

test.each(["one", "other"])("delete description (.%s) mentions sub-sessions are deleted and forks are not", (form) => {
  const text = dictionary[`home.sessions.bulk.delete.description.${form}`]
  expect(text).toMatch(/sub-sessions/i)
  expect(text).toMatch(
    /forks? (are|is|will be) (not|kept|left|untouched|unaffected)|not (delete|deleted).*forks?|forks? (are|is) not/i,
  )
})
