/**
 * @spec-handoff
 * @interface archive locale dictionaries: Record<ArchiveKey, string>
 * @behavior
 *   - Provides the 14 complete archive UI phrases in each of the 63 locale dictionaries.
 *   - Preserves each key's interpolation placeholder multiset.
 * @see RFC 057 Addendum A.7
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
  "dialog.archivedSessions.description": "Choose a session to restore it and open its tab.",
  "dialog.archivedSessions.empty": "No archived sessions found",
  "dialog.archivedSessions.noMatches": "No archived sessions match your search",
  "dialog.archivedSessions.error": "Could not load archived sessions",
  "dialog.archivedSessions.loading": "Loading archived sessions…",
  "session.archive.refreshFailed": "Session updated, but its details could not be refreshed.",
} as const
const slots = (value: string) => [...value.matchAll(/{{([^{}]+)}}/g)].map((x) => x[1]).sort()
test("defines exact English archive copy and 63 locale own-property parity", async () => {
  expect(DESKTOP_NATIVE_LOCALES).toHaveLength(63)
  expect(new Set(DESKTOP_NATIVE_LOCALES).size).toBe(63)
  for (const [key, value] of Object.entries(expected)) expect(en[key as keyof typeof en]).toBe(value)
  for (const locale of DESKTOP_NATIVE_LOCALES) {
    const dictionary = locale === "en" ? en : (await import(`./${locale}.ts`)).dict
    for (const key of Object.keys(expected)) {
      expect(Object.hasOwn(dictionary, key)).toBe(true)
      expect(dictionary[key as keyof typeof dictionary]?.trim()).not.toBe("")
      expect(slots(dictionary[key as keyof typeof dictionary] as string)).toEqual(
        slots(expected[key as keyof typeof expected]),
      )
    }
  }
})
test("keeps checked locale phrases whole and distinguishes title, empty, and error states", async () => {
  const checked = {
    es: {
      "command.session.unarchive.description": "Restaura la sesión actual en la lista de sesiones",
      "dialog.archivedSessions.empty": "No se encontraron sesiones archivadas",
      "dialog.archivedSessions.error": "No se pudieron cargar las sesiones archivadas",
    },
    fr: {
      "command.session.unarchive.description": "Restaurez la session actuelle dans la liste des sessions",
      "dialog.archivedSessions.empty": "Aucune session archivée trouvée",
      "dialog.archivedSessions.error": "Impossible de charger les sessions archivées",
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
    const dictionary = (await import(`./${locale}.ts`)).dict
    for (const [key, value] of Object.entries(phrases)) expect(dictionary[key as keyof typeof dictionary]).toBe(value)
    expect(dictionary["dialog.archivedSessions.empty" as keyof typeof dictionary]).not.toBe(
      dictionary["dialog.archivedSessions.title" as keyof typeof dictionary],
    )
  }
})
