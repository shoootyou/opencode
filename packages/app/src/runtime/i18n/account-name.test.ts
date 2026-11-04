/**
 * @spec-handoff
 * @interface en dictionary keys provider.connect.accountName.* and provider.connect.apiKey.{failed,activeNote}
 * @behavior
 *   - The English dictionary defines the five account-name strings with the exact copy below.
 *   - Other locales are not edited: they fall back to English at runtime.
 * @edge-cases
 *   - Copy for the failed key save is generic: it has no interpolation slot, so no server text or key can reach it.
 * @see ../../providers/connect/dialog.tsx
 */
import { expect, test } from "bun:test"
import en from "./en"

const copy = {
  "provider.connect.accountName.label": "Account name (optional)",
  "provider.connect.accountName.placeholder": "For example: Work",
  "provider.connect.accountName.duplicate": "An account with this name already exists for this provider",
  "provider.connect.apiKey.failed": "Could not save the key. Check it and try again.",
  "provider.connect.apiKey.activeNote": "This key becomes the active one for all models of this provider.",
} as const

const dictionary: Record<string, string> = en

test.each(Object.entries(copy))("English defines %s with the exact copy", (key, value) => {
  expect(dictionary[key]).toBe(value)
})
