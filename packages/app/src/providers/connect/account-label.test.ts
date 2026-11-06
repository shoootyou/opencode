/**
 * @spec-handoff
 * @interface normalizeAccountName(raw: string): string | undefined
 * @interface isDuplicateAccountName(name: string, labels: readonly string[]): boolean
 * @behavior
 *   - normalizeAccountName trims the name; blank or whitespace-only input gives undefined; inner spaces are kept.
 *   - isDuplicateAccountName compares trimmed names case-insensitively (String#toLowerCase) against the labels it is given.
 *   - Only the labels passed are compared: the caller passes the labels of one provider.
 * @edge-cases
 *   - Blank name → false, even when the list holds a blank label.
 *   - Empty label list → false.
 *   - A label that merely starts with the name → false.
 * @see ./controller.ts
 */
import { describe, expect, test } from "bun:test"
import { isDuplicateAccountName, normalizeAccountName } from "./account-label"

describe("normalizeAccountName", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeAccountName("  Work \t")).toBe("Work")
  })

  test("keeps inner spaces", () => {
    expect(normalizeAccountName("  Team  Alpha ")).toBe("Team  Alpha")
  })

  test.each(["", " ", "   ", "\t\n  "])("returns undefined for the blank name %j", (raw) => {
    expect(normalizeAccountName(raw)).toBeUndefined()
  })
})

describe("isDuplicateAccountName", () => {
  const labels = ["Work", "Personal"]

  test("matches an identical label", () => {
    expect(isDuplicateAccountName("Work", labels)).toBe(true)
  })

  test("ignores case", () => {
    expect(isDuplicateAccountName("wORK", labels)).toBe(true)
  })

  test("trims the name before comparing", () => {
    expect(isDuplicateAccountName("  Work  ", labels)).toBe(true)
  })

  test("trims the existing labels before comparing", () => {
    expect(isDuplicateAccountName("Work", ["  Work "])).toBe(true)
  })

  test("folds case with toLowerCase semantics for non-ASCII letters", () => {
    expect(isDuplicateAccountName("ÁLVARO", ["álvaro"])).toBe(true)
  })

  test("accepts a name that is not in the list", () => {
    expect(isDuplicateAccountName("Home", labels)).toBe(false)
  })

  test("does not match a label that only starts with the name", () => {
    expect(isDuplicateAccountName("Wor", labels)).toBe(false)
  })

  test("does not match a label that only contains the name", () => {
    expect(isDuplicateAccountName("ork", labels)).toBe(false)
  })

  test("compares only the labels it is given", () => {
    expect(isDuplicateAccountName("Work", ["Personal"])).toBe(false)
    expect(isDuplicateAccountName("Work", ["Personal", "Work"])).toBe(true)
  })

  test("is false for an empty label list", () => {
    expect(isDuplicateAccountName("Work", [])).toBe(false)
  })

  test.each(["", "   "])("is false for the blank name %j, even when a blank label exists", (name) => {
    expect(isDuplicateAccountName(name, ["Work", ""])).toBe(false)
    expect(isDuplicateAccountName(name, ["Work", "  "])).toBe(false)
  })
})
