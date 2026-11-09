/**
 * @spec-handoff
 * @interface bulkDelete and bulkArchive paths in ./controller.tsx; SHOW_HOME_SESSION_ARCHIVE in ./view.tsx
 * @behavior
 *   - view.tsx keeps SHOW_HOME_SESSION_ARCHIVE = false: the per-row archive button stays hidden while selection mode owns archiving.
 *   - The bulkDelete body checks sessionBusy before ctx.data.session.remove, so a session that started working after it was selected is never deleted.
 *   - The bulkArchive body calls archiveSessionQuiet and no toast( per item, so a run ends with exactly one summary toast.
 * @edge-cases
 *   - bulkDelete or bulkArchive missing → the function-body guards fail (red), not pass vacuously.
 * @see ./controller.tsx
 * @see ./view.tsx
 * @testability The controller needs the Home, server, dialog and query provider graph, and the bun Solid shim evaluates JSX eagerly, so a DOM mount is not feasible. These guards read the sources as text, scoped to each function body, and are brittle by nature; e2e/regression/home.spec.ts covers the rendered behavior (one toast, failures stay selected, busy rows skipped).
 */
import { expect, test } from "bun:test"

const controller = await Bun.file(new URL("./controller.tsx", import.meta.url)).text()

const view = await Bun.file(new URL("./view.tsx", import.meta.url)).text()

// Lines of the declaration of `name` (const, function or object member) up to the first sibling line; "" when missing.
function body(name: string) {
  const lines = controller.split("\n")

  const start = lines.findIndex((line) =>
    new RegExp(`^\\s*(?:(?:const|async function|function) )?${name}\\b\\s*[=:(]`).test(line),
  )

  if (start < 0) return ""
  const indent = lines[start]!.search(/\S/)

  const length = lines
    .slice(start + 1)
    .findIndex((line) => line.trim() !== "" && line.search(/\S/) <= indent && !/^\s*[})\]]/.test(line))

  return lines.slice(start, length < 0 ? undefined : start + 1 + length).join("\n")
}

test("the per-row archive button stays hidden", () => {
  expect(view).toMatch(/const SHOW_HOME_SESSION_ARCHIVE = false\b/)
})

test("bulkDelete checks sessionBusy before it removes a session", () => {
  const text = body("bulkDelete")
  const busy = text.indexOf("sessionBusy")
  const remove = text.indexOf("session.remove")

  expect(busy).toBeGreaterThanOrEqual(0)
  expect(remove).toBeGreaterThan(busy)
})

test("bulkArchive archives quietly and never toasts per session", () => {
  const text = body("bulkArchive")

  expect(text).toContain("archiveSessionQuiet")
  expect(text).not.toContain("toast(")
  expect(text).not.toContain("showToast(")
})
