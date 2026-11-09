/**
 * @spec-handoff
 * @interface bulkArchive, bulkDelete, BulkDeleteDialog, showBulkDelete, finishBulk and selectable in ./controller.tsx; the row button in ./view.tsx
 * @behavior
 *   - view.tsx keeps SHOW_HOME_SESSION_ARCHIVE = false: the per-row archive button stays hidden while selection mode owns archiving.
 *   - bulkArchive and bulkDelete pass the busy predicate (isBusy) and the focus guard (proceed) to runBulk, show one summary after the loop, and finishBulk keeps failed rows selected and closes the bar only on a clean run.
 *   - selectable is built from isSelectable(record.session, isBusy(...)), so busy rows cannot be selected.
 *   - bulkArchive calls archiveSessionQuiet and no toast( per item, so a run ends with exactly one summary toast.
 *   - Both functions need a "connected" connection at batch start and per id (inline or through a shared helper that is itself defined in controller.tsx).
 *   - showBulkDelete hands the context it captured at open to BulkDeleteDialog, which passes it to bulkDelete; bulkDelete refuses when it is no longer the focused context.
 *   - BulkDeleteDialog latches its confirm: the danger Button has disabled=, and a flag is set before the first await.
 *   - The dialog description never joins two translated strings with a literal space.
 *   - Both functions run their post-run steps and the progress reset inside try/finally, and an onCleanup-set alive flag guards the writes after the runBulk await.
 *   - The busy row button in view.tsx carries aria-disabled.
 * @edge-cases
 *   - bulkDelete or bulkArchive missing → the function-body guards fail (red), not pass vacuously.
 * @see ./controller.tsx
 * @see ./view.tsx
 * @testability The controller needs the Home, server, dialog and query provider graph, and the bun Solid shim evaluates JSX eagerly, so a DOM mount is not feasible. These guards read the sources as text, scoped to each function body, and are brittle by nature; e2e/regression/home.spec.ts covers the rendered behavior (one toast, failures stay selected, busy rows skipped). Round 2 of the allowed two hardening rounds for source-text guards: do not add more.
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

test("bulkArchive archives quietly and never toasts per session", () => {
  const text = body("bulkArchive")

  expect(text).toContain("archiveSessionQuiet")
  expect(text).not.toContain("toast(")
  expect(text).not.toContain("showToast(")
})

for (const name of ["bulkArchive", "bulkDelete"]) {
  test(`${name} passes the busy predicate and the focus guard to runBulk`, () => {
    const text = body(name)

    expect(text).toMatch(/\bisBusy\b(?:\s*:\s*(?=[A-Za-z(])(?!undefined\b|null\b|false\b)[^\n]+?)?\s*,/)
    expect(text).toMatch(/\bproceed:[^\n]*focusedContext\(\)/)
  })

  test(`${name} shows one summary, after the loop`, () => {
    const text = body(name)

    expect(text.match(/showBulkSummary\(/g)).toHaveLength(1)
    expect(text.indexOf("showBulkSummary(")).toBeGreaterThan(text.indexOf("onProgress"))
  })
}

test("finishBulk keeps failed rows selected and closes the bar only on a clean run", () => {
  const text = body("finishBulk")

  expect(text).toMatch(/selection\.selectAll\(\s*result\.failed\s*\)/)
  expect(text).toMatch(/if\s*\(\s*result\.failed\.length\s*===\s*0\s*\)\s*selection\.exit\(\)/)
})

test("only busy-free rows are selectable", () => {
  expect(body("selectable")).toMatch(/isSelectable\(\s*record\.session\s*,\s*isBusy\(\s*record\.session\.id\s*\)\s*\)/)
})

// A name declared once in controller.tsx resolves to its body, so a shared helper counts as part of its callers.
function reach(text: string) {
  const names = new Set(text.match(/\b[A-Za-z_]\w*\b/g))

  const helpers = [...names].flatMap((name) =>
    (controller.match(new RegExp(`^\\s*(?:const|function|async function) ${name}\\b`, "gm"))?.length ?? 0) === 1
      ? [body(name)]
      : [],
  )

  return [text, ...helpers].join("\n")
}

for (const name of ["bulkArchive", "bulkDelete"]) {
  test(`${name} requires a connected server at batch start and per id`, () => {
    const text = body(name)
    const run = text.indexOf("await runBulk")
    const option = /\bisBusy\b(?:\s*:\s*([^\n]*))?,?\n/.exec(text)

    expect(run).toBeGreaterThan(0)
    expect(option).not.toBeNull()
    expect(reach(text.slice(0, run))).toContain('"connected"')
    const value = option?.[1]?.trim().replace(/,$/, "") ?? "isBusy"

    expect(reach(`${value}\n${body(value)}`)).toContain('"connected"')
  })

  test(`${name} writes after the runBulk await only while the view is alive`, () => {
    const text = body(name)

    expect(reach(text)).toMatch(/\b(alive|mounted|disposed)\b/)
    expect(reach(text.slice(text.indexOf("await runBulk")))).toMatch(/\b(alive|mounted|disposed)\b/)
  })

  test(`${name} does not return early after the runBulk await, so the toast, tab notice and cache update still run`, () => {
    const text = body(name)
    const run = text.indexOf("await runBulk")
    const finish = text.indexOf("finishBulk(", run)

    expect(run).toBeGreaterThan(0)
    expect(finish).toBeGreaterThan(run)
    expect(text.slice(run, finish)).not.toMatch(/!\s*(alive|mounted|disposed)\s*\)\s*(\{\s*)?return\b/)
  })

  test(`${name} finishes inside try/finally and resets progress there`, () => {
    const text = body(name)
    const finalizer = text.slice(text.indexOf("finally"))

    expect(text).toMatch(/\btry\s*\{/)
    expect(text).toContain("finally")
    expect(finalizer).toMatch(/setBulkProgress\(\s*undefined\s*\)|finishBulk\(/)
  })
}

test("the bulk section registers onCleanup", () => {
  const start = controller.indexOf("createSelection()")
  const end = controller.indexOf("const showBulkDelete")

  expect(start).toBeGreaterThanOrEqual(0)
  expect(controller.slice(start, end)).toContain("onCleanup(")
})

test("the delete dialog binds the context captured at open and bulkDelete compares it with the focused one", () => {
  expect(body("showBulkDelete")).toMatch(/<BulkDeleteDialog\b[^>]*\b(ctx|conn|server|context)=\{/)
  expect(body("BulkDeleteDialog")).toMatch(/bulkDelete\(\s*props\.ids\s*,\s*\S/)

  const text = body("bulkDelete")

  expect(text.split("\n")[0]).toMatch(/bulkDelete\s*=\s*async\s*\(\s*ids\s*:\s*string\[\]\s*,\s*\w+/)
  expect(text).toMatch(/\bctx\s*!==|!==\s*ctx\b|focusedContext\(\)\s*!==|!==\s*home\.server\.focusedContext\(\)/)
})

test("the delete dialog confirm is latched and disables the danger button", () => {
  const text = body("BulkDeleteDialog")
  const confirm = text.slice(text.indexOf("const confirm"))
  const danger = text.split("<Button").find((part) => part.includes('variant="danger"')) ?? ""

  expect(danger).toMatch(/\bdisabled=/)
  expect(confirm.slice(0, confirm.indexOf("await"))).toMatch(/=\s*true\b|,\s*true\s*\)|\(\s*true\s*\)/)
})

test("the delete dialog never joins translated strings with a literal space", () => {
  const text = body("BulkDeleteDialog")

  expect(text).not.toMatch(/`\s\$\{\s*language\./)
  expect(text).not.toMatch(/\{\s*["'] ["']\s*\}/)
  expect(text).not.toMatch(/\+\s*["'`] ["'`]/)
  expect(text).not.toMatch(/\$\{[^}]*language\.[^}]*\}\s\$\{[^}]*language\./)
})

test("a busy row button carries aria-disabled", () => {
  const role = view.indexOf('role={props.bulk.on() ? "checkbox"')
  const button = view.slice(view.lastIndexOf("<button", role), view.indexOf("</button>", role))

  expect(role).toBeGreaterThanOrEqual(0)
  expect(button).toMatch(/aria-disabled=\{[^}]*isSelectable/)
})
