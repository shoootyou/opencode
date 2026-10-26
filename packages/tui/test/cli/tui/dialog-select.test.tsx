/**
 * @spec-handoff
 * @interface DialogSelect<T>(props: DialogSelectProps<T>): JSX.Element
 * @behavior
 *   - Tab and Shift+Tab focus only footer actions explicitly available when unbound.
 *   - A focused footer action has an AA-readable paired foreground/background treatment and Enter runs it before a row.
 * @edge-cases
 *   - Bound actions without showWhenUnbound retain normal Tab field/list behavior.
 * @see ../../../src/ui/dialog-select.tsx
 */
/** @jsxImportSource @opentui/solid */
import { InputRenderable, type RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { dialogWidth } from "../../../src/ui/dialog"
import {
  dialogSelectContentWidth,
  type DialogSelectOption,
  type DialogSelectProps,
} from "../../../src/ui/dialog-select"
import { truncateFilePath } from "../../../src/ui/file-path"
import { stringWidth } from "../../../src/util/string-width"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function renderSelect(
  root: string,
  options: DialogSelectOption<string>[],
  onGlobal: () => void,
  onRow: (option: DialogSelectOption<string>) => void,
  current?: string,
  footerActions?: DialogSelectProps<string>["actions"],
) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { DialogSelect }, { ToastProvider }] =
    await Promise.all([
      import("../../../src/config"),
      import("../../../src/context/theme"),
      import("../../../src/context/keymap"),
      import("../../../src/ui/dialog"),
      import("../../../src/ui/dialog-select"),
      import("../../../src/ui/toast"),
    ])

  function Harness() {
    function Select() {
      onCleanup(Keymap.use().mode.push("modal"))
      return (
        <DialogSelect
          title="Items"
          options={options}
          current={current}
          actions={
            footerActions ?? [
              {
                command: "dialog.move_session.delete",
                title: "delete",
                onTrigger: onRow,
              },
              {
                command: "dialog.move_session.new",
                title: "new",
                selection: "none",
                onTrigger: onGlobal,
              },
            ]
          }
        />
      )
    }

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={config}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Select />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 20, kittyKeyboard: true })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Items"))
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  return app
}

async function mountSelect<T>(
  root: string,
  initial: DialogSelectOption<T>[],
  current?: T,
  focusCurrent?: boolean,
  select?: Pick<
    DialogSelectProps<T>,
    "flat" | "ref" | "onFilter" | "renderFilter" | "onCancel" | "focusTarget" | "search"
  >,
) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig()
  const [
    { ConfigProvider },
    { ThemeProvider },
    { Keymap },
    { DialogProvider, useDialog },
    { DialogSelect },
    { ToastProvider },
  ] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-select"),
    import("../../../src/ui/toast"),
  ])

  const selected: T[] = []
  const moved: T[] = []
  let replaceOptions!: (options: DialogSelectOption<T>[]) => void
  let replaceCurrent!: (value: T | undefined) => void

  function Harness() {
    const [options, setOptions] = createSignal(initial)
    replaceOptions = setOptions
    const [value, setCurrent] = createSignal(current)
    replaceCurrent = (value) => setCurrent(() => value)

    function Fixture() {
      const dialog = useDialog()
      onMount(() =>
        dialog.replace(() => (
          <DialogSelect
            title="Mutable options"
            options={options()}
            current={value()}
            focusCurrent={focusCurrent}
            {...select}
            onMove={(option) => moved.push(option.value)}
            onSelect={(option) => selected.push(option.value)}
          />
        )),
      )
      return null
    }

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={config}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 24, kittyKeyboard: true })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Mutable options"))
  if (select?.renderFilter !== false)
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  return { app, moved, replaceOptions, replaceCurrent, selected }
}

test.each([true, false])("filter refs are ready when published with renderFilter=%s", async (renderFilter) => {
  await using tmp = await tmpdir()
  const queries: string[] = []
  const select = await mountSelect(
    tmp.path,
    [
      { title: "Alpha", value: "alpha" },
      { title: "Beta", value: "beta" },
    ],
    undefined,
    undefined,
    {
      renderFilter,
      ref: (ref) => ref.setFilter("beta"),
      onFilter: (query) => queries.push(query),
    },
  )
  try {
    expect(queries).toEqual(["beta"])
    if (!renderFilter) return
    expect(select.app.renderer.currentFocusedEditor?.plainText).toBe("beta")
    expect(select.app.captureCharFrame()).not.toContain("Alpha")
    select.app.mockInput.pressEnter()
    await select.app.waitFor(() => select.selected.length === 1)
    expect(select.selected).toEqual(["beta"])
  } finally {
    select.app.renderer.destroy()
  }
})

test("Escape clears text selection before invoking a custom back action", async () => {
  await using tmp = await tmpdir()
  let cancelled = 0
  const select = await mountSelect(tmp.path, [{ title: "Alpha", value: "alpha" }], undefined, undefined, {
    onCancel: () => cancelled++,
  })
  try {
    const frame = select.app.captureCharFrame().split("\n")
    const row = frame.findIndex((line) => line.includes("Alpha"))
    const column = frame[row]!.indexOf("Alpha") + 1
    await select.app.mockMouse.click(column, row)
    await select.app.mockMouse.click(column, row)
    await select.app.waitFor(() => select.app.renderer.getSelection()?.getSelectedText() === "Alpha")
    select.app.mockInput.pressEscape()
    await select.app.waitFor(() => !select.app.renderer.getSelection())
    expect(cancelled).toBe(0)
    select.app.mockInput.pressEscape()
    await select.app.waitFor(() => cancelled === 1)
  } finally {
    select.app.renderer.destroy()
  }
})

test("reveals a focus target that arrives below the viewport", async () => {
  await using tmp = await tmpdir()
  const select = await mountSelect(tmp.path, [{ title: "Root", value: "root" }], undefined, true, {
    focusTarget: "checkout-29",
  })
  try {
    select.replaceOptions([
      { title: "Root", value: "root" },
      ...Array.from({ length: 30 }, (_, index) => ({ title: `Checkout ${index}`, value: `checkout-${index}` })),
    ])
    await select.app.waitForFrame((frame) => frame.includes("Checkout 29"))
    select.app.mockInput.pressEnter()
    await select.app.waitFor(() => select.selected.length === 1)
    expect(select.selected).toEqual(["checkout-29"])
  } finally {
    select.app.renderer.destroy()
  }
})

test("budgets option content for constrained and full-width large dialogs", () => {
  expect(dialogSelectContentWidth(Math.min(dialogWidth("large"), 62 - 2)) - 7).toBe(41)
  expect(dialogSelectContentWidth(Math.min(dialogWidth("large"), 100 - 2)) - 7).toBe(69)
})

test("ctrl+c clears a dialog filter before closing the dialog", async () => {
  await using tmp = await tmpdir()
  const select = await mountSelect(tmp.path, [{ title: "Alpha", value: "alpha" }])

  try {
    await select.app.mockInput.typeText("alpha")
    await select.app.waitFor(() => select.app.renderer.currentFocusedEditor?.plainText === "alpha")

    select.app.mockInput.pressKey("c", { ctrl: true })
    await select.app.waitFor(() => select.app.renderer.currentFocusedEditor?.plainText === "")
    expect(select.app.captureCharFrame()).toContain("Mutable options")

    select.app.mockInput.pressKey("c", { ctrl: true })
    await select.app.waitForFrame((frame) => !frame.includes("Mutable options"))
  } finally {
    select.app.renderer.destroy()
  }
})

test("ctrl+c clears a dialog text selection before closing the dialog", async () => {
  await using tmp = await tmpdir()
  const select = await mountSelect(tmp.path, [{ title: "Alpha", value: "alpha" }])

  try {
    const frame = select.app.captureCharFrame().split("\n")
    const row = frame.findIndex((line) => line.includes("Alpha"))
    const column = frame[row]!.indexOf("Alpha") + 1
    await select.app.mockMouse.click(column, row)
    await select.app.mockMouse.click(column, row)
    await select.app.waitFor(() => select.app.renderer.getSelection()?.getSelectedText() === "Alpha")

    select.app.mockInput.pressKey("c", { ctrl: true })
    await select.app.waitFor(() => !select.app.renderer.getSelection())
    expect(select.app.captureCharFrame()).toContain("Mutable options")

    select.app.mockInput.pressKey("c", { ctrl: true })
    await select.app.waitForFrame((frame) => !frame.includes("Mutable options"))
  } finally {
    select.app.renderer.destroy()
  }
})

test("renders the complete truncated footer within the option row", async () => {
  await using tmp = await tmpdir()
  const title = "Project"
  const footer = truncateFilePath(
    "/tmp/opencode/projects/a-very-long-project-directory/distinctive-tail.tsx",
    dialogSelectContentWidth(dialogWidth("medium")) - stringWidth(title),
  )
  const select = await mountSelect(tmp.path, [{ title, footer, value: "project" }])

  try {
    await select.app.waitForFrame((frame) => frame.includes(footer))
    expect(select.app.captureCharFrame()).toContain(footer)
  } finally {
    select.app.renderer.destroy()
  }
})

test("renders actions with a current selection", async () => {
  await using tmp = await tmpdir()
  const app = await renderSelect(
    tmp.path,
    [{ title: "Alpha", value: "alpha" }],
    () => {},
    () => {},
    "alpha",
  )

  try {
    await app.waitForFrame((frame) => frame.includes("delete"))
  } finally {
    app.renderer.destroy()
  }
})

test("passes the row foreground color to gutters", async () => {
  await using tmp = await tmpdir()
  const colors = new Map<string, RGBA>()
  const gutter = (item: string) => (color: RGBA) => {
    colors.set(item, color)
    return <text fg={color}>*</text>
  }
  const select = await mountSelect(tmp.path, [
    { title: "Alpha", value: "alpha", gutter: gutter("alpha") },
    { title: "Beta", value: "beta", gutter: gutter("beta") },
  ])

  try {
    await select.app.waitFor(() => colors.size === 2)
    const selected = colors.get("alpha")!.toInts()
    const idle = colors.get("beta")!.toInts()
    expect(selected).not.toEqual(idle)

    select.app.mockInput.pressArrow("down")
    await select.app.waitFor(() =>
      colors
        .get("alpha")!
        .toInts()
        .every((value, index) => value === idle[index]),
    )
    expect(colors.get("beta")!.toInts()).toEqual(selected)
  } finally {
    select.app.renderer.destroy()
  }
})

test("dialog actions run without options while row actions still require a selection", async () => {
  await using tmp = await tmpdir()
  let global = 0
  const rows: string[] = []
  const app = await renderSelect(
    tmp.path,
    [],
    () => global++,
    (option) => rows.push(option.value),
  )

  try {
    app.mockInput.pressKey("a", { ctrl: true })
    app.mockInput.pressKey("d", { ctrl: true })

    expect(global).toBe(1)
    expect(rows).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("renders one gap before an empty state", async () => {
  await using tmp = await tmpdir()
  const app = await renderSelect(
    tmp.path,
    [],
    () => {},
    () => {},
  )

  try {
    await app.waitForFrame((frame) => frame.includes("No items available"))
    const lines = app
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trim())
    expect(lines.indexOf("No items available") - lines.indexOf("Search")).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("footer actions run when filtering leaves no selected row", async () => {
  await using tmp = await tmpdir()
  let global = 0
  const rows: string[] = []
  const app = await renderSelect(
    tmp.path,
    [{ title: "Alpha", value: "alpha" }],
    () => global++,
    (option) => rows.push(option.value),
  )

  try {
    for (const key of "missing") app.mockInput.pressKey(key)
    await app.waitForFrame((frame) => frame.includes("No results found"))

    app.mockInput.pressKey("d", { ctrl: true })
    const frame = app.captureCharFrame().split("\n")
    const row = frame.findIndex((line) => line.includes("new ctrl+a"))
    await app.mockMouse.click(frame[row]!.indexOf("new ctrl+a") + 1, row)

    expect(global).toBe(1)
    expect(rows).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("row actions receive the selected option", async () => {
  await using tmp = await tmpdir()
  const rows: string[] = []
  const app = await renderSelect(
    tmp.path,
    [{ title: "Alpha", value: "alpha" }],
    () => {},
    (option) => rows.push(option.value),
  )

  try {
    app.mockInput.pressKey("d", { ctrl: true })

    expect(rows).toEqual(["alpha"])
  } finally {
    app.renderer.destroy()
  }
})

test("selects the new final option immediately after removing the selected final option", async () => {
  await using tmp = await tmpdir()
  const options = ["first", "second", "third"].map((value) => ({ title: value, value }))
  const select = await mountSelect(tmp.path, options)

  try {
    select.app.mockInput.pressArrow("down")
    await select.app.waitFor(() => select.moved.at(-1) === "second")
    select.app.mockInput.pressArrow("down")
    await select.app.waitFor(() => select.moved.at(-1) === "third")
    select.replaceOptions(options.slice(0, -1))
    await select.app.waitForFrame((frame) => !frame.includes("third"))

    select.app.mockInput.pressEnter()
    await select.app.waitFor(() => select.selected.length === 1)

    expect(select.selected).toEqual(["second"])
  } finally {
    select.app.renderer.destroy()
  }
})

test("selects a repopulated option after removing the only option", async () => {
  await using tmp = await tmpdir()
  const select = await mountSelect(tmp.path, [{ title: "only", value: "only" }])

  try {
    select.replaceOptions([])
    await select.app.waitForFrame((frame) => frame.includes("No items available"))
    select.app.mockInput.pressEnter()
    expect(select.selected).toEqual([])

    select.replaceOptions([{ title: "replacement", value: "replacement" }])
    await select.app.waitForFrame((frame) => frame.includes("replacement"))
    select.app.mockInput.pressEnter()
    await select.app.waitFor(() => select.selected.length === 1)

    expect(select.selected).toEqual(["replacement"])
  } finally {
    select.app.renderer.destroy()
  }
})

test("keeps the cursor index while options are temporarily empty", async () => {
  await using tmp = await tmpdir()
  const options = ["first", "second", "third"].map((value) => ({ title: value, value }))
  const select = await mountSelect(tmp.path, options)

  try {
    select.app.mockInput.pressArrow("down")
    await select.app.waitFor(() => select.moved.at(-1) === "second")
    select.app.mockInput.pressArrow("down")
    await select.app.waitFor(() => select.moved.at(-1) === "third")
    select.replaceOptions([])
    await select.app.waitForFrame((frame) => frame.includes("No items available"))

    select.replaceOptions(options)
    await select.app.waitForFrame((frame) => frame.includes("third"))
    select.app.mockInput.pressEnter()
    await select.app.waitFor(() => select.selected.length === 1)

    expect(select.selected).toEqual(["third"])
  } finally {
    select.app.renderer.destroy()
  }
})

test("keeps the current option selected when options reorder", async () => {
  await using tmp = await tmpdir()
  const options = ["first", "current", "third"].map((value) => ({ title: value, value }))
  const select = await mountSelect(tmp.path, options, "current")

  try {
    select.replaceOptions([options[1], options[2], options[0]])
    await select.app.waitForFrame((frame) => frame.indexOf("current") < frame.indexOf("third"))
    select.app.mockInput.pressEnter()
    await select.app.waitFor(() => select.selected.length === 1)

    expect(select.selected).toEqual(["current"])
  } finally {
    select.app.renderer.destroy()
  }
})

test("custom search follows a current change batched with reordered results", async () => {
  await using tmp = await tmpdir()
  const options = ["alpha", "beta", "gamma"].map((value) => ({ title: value, value }))
  const [results, setResults] = createSignal(options)
  const select = await mountSelect(tmp.path, options, "alpha", undefined, { search: () => results() })

  try {
    batch(() => {
      select.replaceCurrent("gamma")
      setResults(options.toReversed())
    })
    await select.app.waitForFrame((frame) => frame.indexOf("gamma") < frame.indexOf("alpha"))
    select.app.mockInput.pressEnter()
    await select.app.waitFor(() => select.selected.length === 1)

    expect(select.selected).toEqual(["gamma"])
  } finally {
    select.app.renderer.destroy()
  }
})

test.each([false, 0, "", null, "current", undefined])("focuses current %p when it changes", async (current) => {
  await using tmp = await tmpdir()
  const select = await mountSelect<string | typeof current>(
    tmp.path,
    [
      { title: "First", value: "first" },
      { title: "Current", value: current === undefined ? "current" : current },
    ],
    "first",
  )

  try {
    select.replaceCurrent(current)
    await select.app.waitForVisualIdle()
    select.app.mockInput.pressEnter()
    await select.app.waitFor(() => select.selected.length === 1)

    expect(select.selected).toEqual([current === undefined ? "first" : current])
  } finally {
    select.app.renderer.destroy()
  }
})

test.each([false, 0, "", null, "current", undefined])(
  "restores current %p after clearing a filter",
  async (current) => {
    await using tmp = await tmpdir()
    const select = await mountSelect<string | typeof current>(
      tmp.path,
      [
        ...Array.from({ length: 6 }, (_, index) => ({ title: `Item-${index}`, value: `item-${index}` })),
        { title: "Current", value: current === undefined ? "current" : current },
      ],
      current,
    )

    try {
      await select.app.mockInput.typeText("Item-0")
      await select.app.waitForFrame((frame) => frame.includes("Item-0") && !frame.includes("Item-1"))
      select.app.mockInput.pressKey("c", { ctrl: true })
      await select.app.waitForVisualIdle()
      select.app.mockInput.pressEnter()
      await select.app.waitFor(() => select.selected.length === 1)

      expect(select.selected).toEqual([current === undefined ? "item-0" : current])
      expect(select.app.captureCharFrame().includes("Current")).toBe(current !== undefined)
    } finally {
      select.app.renderer.destroy()
    }
  },
)

test("shows no-match and still closes after a flat filter goes empty", async () => {
  await using tmp = await tmpdir()
  const select = await mountSelect(
    tmp.path,
    [
      { title: "models.dev", value: "models.dev", category: "Projects" },
      { title: "opencode2", value: "opencode2", category: "Projects" },
    ],
    undefined,
    undefined,
    { flat: true },
  )

  try {
    await select.app.waitForFrame((frame) => frame.includes("models.dev"))
    await select.app.mockInput.typeText("models")
    await select.app.waitForFrame((frame) => frame.includes("models.dev") && !frame.includes("opencode2"))
    await select.app.mockInput.typeText(" missing")
    await select.app.waitForFrame((frame) => frame.includes("No results found"))
    expect(select.app.captureCharFrame()).not.toContain("models.dev")

    select.app.mockInput.pressEscape()
    await select.app.waitForFrame((frame) => !frame.includes("Mutable options") && !frame.includes("No results found"))
  } finally {
    select.app.renderer.destroy()
  }
})

test("dialog rows do not add renderer resize listeners", async () => {
  await using tmp = await tmpdir()
  const options = ["first", "second", "third"].map((value) => ({ title: value, value }))
  const select = await mountSelect(tmp.path, options)

  try {
    const count = () =>
      (select.app.renderer as unknown as { listenerCount(event: string): number }).listenerCount("resize")
    const before = count()
    // Mounting 30 rows must not add one resize listener per row (Node warns
    // past 10 listeners on one emitter).
    select.replaceOptions(
      Array.from({ length: 30 }, (_, index) => ({ title: `Item ${index}`, value: `item-${index}` })),
    )
    await select.app.waitForVisualIdle()
    expect(count()).toBe(before)
  } finally {
    select.app.renderer.destroy()
  }
})

test("keeps the first row selected when current is only a marker", async () => {
  await using tmp = await tmpdir()
  const project = { title: "project", value: "project" }
  const select = await mountSelect(tmp.path, [project], "current", false)

  try {
    select.replaceOptions([
      { title: "recent session", value: "recent" },
      project,
      { title: "current session", value: "current" },
    ])
    await select.app.waitForFrame((frame) => frame.includes("recent session"))
    select.app.mockInput.pressEnter()
    await select.app.waitFor(() => select.selected.length === 1)

    expect(select.selected).toEqual(["recent"])
  } finally {
    select.app.renderer.destroy()
  }
})

function contrastRatio(foreground: RGBA, background: RGBA) {
  const luminance = (color: RGBA) => {
    const [red, green, blue] = color
      .toInts()
      .slice(0, 3)
      .map((value) => value / 255)
    const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  }
  const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (light + 0.05) / (dark + 0.05)
}

test.each(["dark", "light"] as const)(
  "renders an AA-focused footer action over its paired background in %s new-designs mode",
  async (mode) => {
    await using temporary = await tmpdir()
    let actionRuns = 0
    let rowRuns = 0
    let theme: ReturnType<ReturnType<typeof useTheme>["surface"]> | undefined
    const config = {
      ...createTuiResolvedConfig({ theme: { name: "opencode", mode } }),
      experimental: { "new-designs": true },
    }
    const [
      { ConfigProvider },
      { ThemeProvider, useTheme },
      { Keymap },
      { DialogProvider },
      { DialogSelect },
      { ToastProvider },
    ] = await Promise.all([
      import("../../../src/config"),
      import("../../../src/context/theme"),
      import("../../../src/context/keymap"),
      import("../../../src/ui/dialog"),
      import("../../../src/ui/dialog-select"),
      import("../../../src/ui/toast"),
    ])
    const app = await testRender(
      () => (
        <TestTuiContexts directory={temporary.path} paths={{ home: temporary.path, state: temporary.path }}>
          <ConfigProvider config={config}>
            <ThemeProvider mode={mode} source={emptyThemeSource}>
              <Keymap.Provider>
                <ToastProvider>
                  <DialogProvider>
                    {(() => {
                      onCleanup(Keymap.use().mode.push("modal"))
                      theme = useTheme().surface("dialog")
                      return (
                        <DialogSelect
                          title="Footer focus"
                          options={[{ title: "Selected row", value: "selected" }]}
                          onSelect={() => rowRuns++}
                          actions={[
                            {
                              command: "test.footer.visibility",
                              title: "toggle visibility",
                              selection: "none",
                              showWhenUnbound: true,
                              onTrigger: () => actionRuns++,
                            },
                          ]}
                        />
                      )
                    })()}
                  </DialogProvider>
                </ToastProvider>
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 100, height: 24, kittyKeyboard: true },
    )
    const span = (text: string) =>
      app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((entry) => entry.text.includes(text))

    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("Selected row") && frame.includes("toggle visibility"))
      await app.waitForVisualIdle({ quietFrames: 3 })
      app.renderer.currentFocusedEditor?.blur()
      app.mockInput.pressTab({ shift: true })
      await app.waitForFrame(
        () => span("toggle visibility")?.bg.equals(theme!.background.action.primary.focused) === true,
      )
      let action = span("toggle visibility")!
      let row = span("Selected row")!
      expect(action.fg.equals(theme!.text.action.primary.focused)).toBe(true)
      expect(action.bg.equals(theme!.background.action.primary.focused)).toBe(true)
      expect(contrastRatio(action.fg, action.bg)).toBeGreaterThanOrEqual(4.5)
      expect(row.bg.equals(theme!.background.action.primary.focused)).toBe(false)

      app.mockInput.pressArrow("down")
      await app.waitFor(() => span("toggle visibility")?.bg.equals(theme!.background.action.primary.focused) === false)
      app.mockInput.pressTab()
      await app.waitForFrame(
        () => span("toggle visibility")?.bg.equals(theme!.background.action.primary.focused) === true,
      )
      action = span("toggle visibility")!
      row = span("Selected row")!
      expect(action.fg.equals(theme!.text.action.primary.focused)).toBe(true)
      expect(contrastRatio(action.fg, action.bg)).toBeGreaterThanOrEqual(4.5)
      expect(row.bg.equals(theme!.background.action.primary.focused)).toBe(false)
      app.mockInput.pressEnter()
      await app.waitFor(() => actionRuns === 1)
      expect(rowRuns).toBe(0)
    } finally {
      app.renderer.destroy()
    }
  },
)

test("keeps Tab and Shift+Tab in normal dialog navigation for a bound footer action", async () => {
  // coverage backfill: tabActions() must not capture Tab unless an action opts into showWhenUnbound.
  await using temporary = await tmpdir()
  let actionRuns = 0
  const app = await renderSelect(
    temporary.path,
    [{ title: "Selected row", value: "selected" }],
    () => {},
    () => {},
    undefined,
    [
      {
        command: "test.bound.action",
        title: "bound action",
        bind: "ctrl+b",
        selection: "none",
        onTrigger: () => actionRuns++,
      },
    ],
  )

  try {
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressTab()
    app.mockInput.pressEnter()
    expect(actionRuns).toBe(0)
    expect(app.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)

    app.mockInput.pressTab({ shift: true })
    app.mockInput.pressEnter()
    expect(actionRuns).toBe(0)
    expect(app.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)
  } finally {
    app.renderer.destroy()
  }
})
