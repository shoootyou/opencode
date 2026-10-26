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
