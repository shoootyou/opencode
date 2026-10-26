/**
 * @spec-handoff
 * @interface session.list command/keybind -> DialogSessionList
 * @behavior
 *   - Opens the Sessions dialog through the real configured session.list keybind.
 *   - Uses a real nonconflicting archive-visibility keybind to request one archived-only page.
 *   - Uses the upstream Ctrl+A scope binding and the default-none archive action's Tab/Enter fallback independently.
 *   - Seeds the scope action from config.tabs.scope rather than an archive-specific hard-coded default.
 * @edge-cases
 *   - A cursor returned by that page does not trigger a second automatic request.
 * @see ../src/app.tsx
 */
import { RGBA } from "@opentui/core"
import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const active = {
  id: "ses_active",
  projectID: "proj_test",
  title: "Active root",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory },
}

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

test("opens Sessions through session.list and requests one archived-only page through a real keybind", async () => {
  const requests: URL[] = []
  await using setup = await createAppFixture({
    config: {
      animations: false,
      keybinds: { "session.list": "ctrl+l", "session.archived.toggle_visibility": "ctrl+b" },
    },
    fetch: (url) => {
      if (url.pathname !== "/api/session") return
      requests.push(url)
      if (url.searchParams.get("archived") === "true") return json({ data: [], cursor: { next: "older" } })
      return json({ data: [active], cursor: {} })
    },
  })

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Ask anything"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Sessions") && frame.includes("Active root"))
  await setup.waitFor(() => requests.length > 0)
  await setup.waitForFrame((frame) => frame.includes("ctrl+b"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  setup.mockInput.pressKey("b", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("hide") && frame.includes("archived"))
  await setup.waitFor(() => requests.some((url) => url.searchParams.get("archived")))
  await setup.waitForVisualIdle({ quietFrames: 2 })
  expect(requests.filter((url) => url.searchParams.get("archived") === "true")).toHaveLength(1)
}, 20000)

test("toggles scope with Ctrl+A and archives through the default-none Tab fallback", async () => {
  const patches: unknown[] = []
  await using setup = await createAppFixture({
    config: {
      animations: false,
      tabs: { scope: "cwd" },
      keybinds: { "session.list": "ctrl+l" },
    },
    fetch: async (url, request) => {
      if (!url.pathname.startsWith("/api/session")) return
      if (request.method === "PATCH") {
        patches.push(await request.json())
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/session/ses_active") return json({ data: active })
      return json({ data: [active], cursor: {} })
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Ask anything"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Sessions") && frame.includes("all projects"))
  await setup.waitForFrame((frame) => frame.includes("ctrl+a"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  setup.mockInput.pressKey("a", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("current directory"))
  expect(patches).toEqual([])
  await setup.waitForVisualIdle({ quietFrames: 3 })
  setup.mockInput.pressTab()
  setup.mockInput.pressTab()
  setup.mockInput.pressTab()
  setup.mockInput.pressEnter()
  await setup.waitFor(() => patches.length === 1)
  expect(patches).toEqual([{ archived: true }])
})

test("Shift+Tab activates the default-unbound archived-visibility action without selecting a row", async () => {
  // coverage backfill: the reverse default-none traversal must reach the selection-free visibility action.
  const requests: URL[] = []
  const patches: unknown[] = []
  await using setup = await createAppFixture({
    config: {
      animations: false,
      keybinds: { "session.list": "ctrl+l" },
    },
    fetch: async (url, request) => {
      if (!url.pathname.startsWith("/api/session")) return
      if (request.method === "PATCH") {
        patches.push(await request.json())
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/session") {
        requests.push(url)
        return json({ data: [active], cursor: {} })
      }
      return json({ data: active })
    },
  })

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Ask anything"))
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Sessions") && frame.includes("Active root"))
  setup.mockInput.pressTab({ shift: true })
  setup.mockInput.pressEnter()
  await setup.waitFor(() => requests.some((url) => url.searchParams.get("archived") === "true"))
  expect(patches).toEqual([])
  expect(requests.filter((url) => url.searchParams.get("archived") === "true")).toHaveLength(1)
})

test.each(["dark", "light"] as const)("renders an AA focused footer action in %s mode", async (mode) => {
  const patches: unknown[] = []
  await using setup = await createAppFixture({
    mode,
    config: {
      animations: false,
      theme: { name: "opencode", mode },
      keybinds: { "session.list": "ctrl+l" },
    },
    fetch: async (url, request) => {
      if (!url.pathname.startsWith("/api/session")) return
      if (request.method === "PATCH") {
        patches.push(await request.json())
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/session/ses_active") return json({ data: active })
      return json({ data: [active], cursor: {} })
    },
  })
  const span = (text: string) =>
    setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((entry) => entry.text.includes(text))
  const pair = () => {
    const action = span("archive/unarchive")
    const dialog = span("Sessions")
    if (!action || !dialog) throw new Error("archive footer or dialog background was not rendered")
    const background = action.bg.toInts()[3] === 0 ? dialog.bg : action.bg
    const hex = (color: RGBA) =>
      `#${color
        .toInts()
        .slice(0, 3)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`
    return { foreground: action.fg, background, description: `fg=${hex(action.fg)} bg=${hex(background)}` }
  }

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Ask anything"))
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Sessions") && frame.includes("Active root"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  const unfocused = pair()
  const unfocusedRatio = contrastRatio(unfocused.foreground, unfocused.background)
  expect(
    unfocusedRatio,
    `unfocused ${mode} archive action ${unfocused.description} ratio=${unfocusedRatio.toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(4.5)
  setup.mockInput.pressTab()
  setup.mockInput.pressTab()
  setup.mockInput.pressTab()
  try {
    await setup.waitFor(() => {
      const focused = pair()
      return !focused.foreground.equals(unfocused.foreground) || !focused.background.equals(unfocused.background)
    })
  } catch {
    const current = pair()
    throw new Error(
      `archive focus did not repaint in ${mode}: unfocused ${unfocused.description}; current ${current.description}`,
    )
  }
  const focused = pair()
  const focusedRatio = contrastRatio(focused.foreground, focused.background)
  expect(
    focusedRatio,
    `focused ${mode} archive action ${focused.description} ratio=${focusedRatio.toFixed(2)}:1; unfocused ${unfocused.description} ratio=${unfocusedRatio.toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(4.5)
  setup.mockInput.pressEnter()
  await setup.waitFor(() => patches.length === 1)
  expect(patches).toEqual([{ archived: true }])
})
