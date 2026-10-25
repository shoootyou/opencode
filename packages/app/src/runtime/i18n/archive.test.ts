/**
 * @spec-handoff
 * @interface archive locale dictionaries: Record<string, string>
 * @behavior
 *   - Defines exact loaded-session guidance, empty, and no-match copy in English and Spanish.
 *   - Removes the six archive-only page-browser keys from every locale while preserving generic labels.
 * @edge-cases
 *   - Locales other than English and Spanish use the existing English dictionary fallback.
 * @see RFC 057 D.3.19, D.5
 */
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/require-readable-spacing -- SAFETY: dictionaries are intentionally indexed by the contract's dynamic key set and exercised across each existing locale.
import { expect, test } from "bun:test"
import en from "./en"
import { DESKTOP_NATIVE_LOCALES } from "./desktop-native"

const loadedCopy = {
  "dialog.archivedSessions.loadedDescription":
    "Choose a session to restore it and open its tab. Search covers loaded sessions only; scroll down or load more to browse older sessions.",
  "dialog.archivedSessions.loadedEmpty": "No archived sessions found",
  "dialog.archivedSessions.loadedNoMatches": "No loaded archived sessions match your search",
} as const

const retired = [
  "dialog.archivedSessions.description",
  "dialog.archivedSessions.empty",
  "dialog.archivedSessions.noMatches",
  "dialog.archivedSessions.search.placeholder",
  "dialog.archivedSessions.previousPage",
  "dialog.archivedSessions.nextPage",
]

test("defines exact English loaded-only archive copy and exact Spanish translations", async () => {
  for (const [key, value] of Object.entries(loadedCopy)) expect((en as Record<string, string>)[key]).toBe(value)

  const spanish: Record<string, string> = (await import("./es")).dict
  expect(spanish).toMatchObject({
    "dialog.archivedSessions.loadedDescription":
      "Selecciona una sesión para restaurarla y abrir su pestaña. La búsqueda solo incluye las sesiones cargadas; desplázate hacia abajo o carga más para explorar sesiones anteriores.",
    "dialog.archivedSessions.loadedEmpty": "No hay sesiones archivadas",
    "dialog.archivedSessions.loadedNoMatches": "Ninguna sesión archivada cargada coincide con tu búsqueda",
  })
})

test("removes only the obsolete archive pager keys from all 63 dictionaries", async () => {
  expect(DESKTOP_NATIVE_LOCALES).toHaveLength(63)
  for (const locale of DESKTOP_NATIVE_LOCALES) {
    const dictionary: Record<string, string> = locale === "en" ? en : (await import(`./${locale}.ts`)).dict
    for (const key of retired) expect(Object.hasOwn(dictionary, key)).toBe(false)
    expect(dictionary["common.loadMore"]).toBeTruthy()
    expect(dictionary["common.retry"]).toBeTruthy()
  }
})
