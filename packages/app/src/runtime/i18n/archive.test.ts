/**
 * @spec-handoff
 * @interface archive locale dictionaries: Record<ArchiveKey, string>
 * @behavior
 *   - Provides the 17 complete page-scoped archive UI phrases in each of the 63 locale dictionaries.
 *   - Preserves each key's interpolation placeholder multiset.
 * @see RFC 057 Addendum C.6
 */
import { expect, test } from "bun:test"
import en from "./en"
import { DESKTOP_NATIVE_LOCALES } from "./desktop-native"

const expected = {
  "common.unarchive": "Unarchive",
  "command.session.archive": "Archive session",
  "command.session.archive.description": "Archive the current session",
  "command.session.unarchive": "Unarchive session",
  "command.session.unarchive.description": "Restore the current session to the session list",
  "command.session.archivedBrowse": "Browse archived sessions",
  "command.session.archivedBrowse.description": "Find and restore an archived session",
  "dialog.archivedSessions.title": "Archived sessions",
  "dialog.archivedSessions.description": "Choose a session on this page to restore it and open its tab.",
  "dialog.archivedSessions.empty": "No archived sessions on this page",
  "dialog.archivedSessions.noMatches": "No archived sessions on this page match your search",
  "dialog.archivedSessions.error": "Could not load archived sessions",
  "dialog.archivedSessions.loading": "Loading archived sessions…",
  "dialog.archivedSessions.search.placeholder": "Search this page",
  "dialog.archivedSessions.previousPage": "Previous page",
  "dialog.archivedSessions.nextPage": "Next page",
  "session.archive.refreshFailed": "Session updated, but its details could not be refreshed.",
} as const

// oxlint-disable-next-line anti-slop/no-known-value-widening -- The dictionary test intentionally indexes the complete exact-copy fixture by dynamic locale keys.
const expectedCopy: Record<string, string> = expected

const english: Record<string, string> = en

const slots = (value: string) => [...value.matchAll(/{{([^{}]+)}}/g)].map((x) => x[1]).sort()

test("defines exact English archive copy and 63 locale own-property parity", async () => {
  expect(DESKTOP_NATIVE_LOCALES).toHaveLength(63)
  expect(new Set(DESKTOP_NATIVE_LOCALES).size).toBe(63)

  for (const [key, value] of Object.entries(expectedCopy)) expect(english[key]).toBe(value)

  for (const locale of DESKTOP_NATIVE_LOCALES) {
    const dictionary: Record<string, string> = locale === "en" ? en : (await import(`./${locale}.ts`)).dict

    for (const key of Object.keys(expectedCopy)) {
      expect(Object.hasOwn(dictionary, key)).toBe(true)
      expect(dictionary[key]?.trim()).not.toBe("")
      expect(slots(dictionary[key])).toEqual(slots(expectedCopy[key]))
    }
  }
})

test("keeps corrected Spanish and French whole sentences with page, restore, and tab meaning", async () => {
  const checked = {
    es: {
      "command.session.archive.description": "Archivar la sesión actual",
      "command.session.archivedBrowse": "Explorar sesiones archivadas",
      "command.session.archivedBrowse.description": "Buscar y restaurar una sesión archivada",
      "dialog.archivedSessions.description":
        "Selecciona una sesión de esta página para restaurarla y abrir su pestaña.",
      "dialog.archivedSessions.empty": "No hay sesiones archivadas en esta página",
      "dialog.archivedSessions.noMatches": "Ninguna sesión archivada de esta página coincide con tu búsqueda",
    },
    fr: {
      "command.session.archive.description": "Archiver la session actuelle",
      "command.session.archivedBrowse": "Parcourir les sessions archivées",
      "command.session.archivedBrowse.description": "Rechercher et restaurer une session archivée",
      "dialog.archivedSessions.description":
        "Sélectionnez une session sur cette page pour la restaurer et ouvrir son onglet.",
      "dialog.archivedSessions.empty": "Aucune session archivée sur cette page",
      "dialog.archivedSessions.noMatches": "Aucune session archivée sur cette page ne correspond à votre recherche",
    },
    ar: {
      "command.session.unarchive.description": "استعد الجلسة الحالية إلى قائمة الجلسات",
      "dialog.archivedSessions.empty": "لم يتم العثور على جلسات مؤرشفة",
      "dialog.archivedSessions.error": "تعذر تحميل الجلسات المؤرشفة",
    },
    he: {
      "command.session.unarchive.description": "שחזר את ההפעלה הנוכחית לרשימת ההפעלות",
      "dialog.archivedSessions.empty": "לא נמצאו הפעלות בארכיון",
      "dialog.archivedSessions.error": "לא ניתן לטעון הפעלות בארכיון",
    },
  } as const

  for (const [locale, phrases] of Object.entries(checked)) {
    const dictionary: Record<string, string> = (await import(`./${locale}.ts`)).dict

    for (const [key, value] of Object.entries(phrases)) expect(dictionary[key]).toBe(value)
    expect(dictionary["dialog.archivedSessions.empty"]).not.toBe(dictionary["dialog.archivedSessions.title"])
  }
})
