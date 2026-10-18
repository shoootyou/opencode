/**
 * @spec-handoff
 * @interface session.list command/keybind -> DialogSessionList
 * @behavior
 *   - Opens the Sessions dialog through the real configured session.list keybind.
 *   - Uses a real nonconflicting archive-visibility keybind to request one archived-only page.
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
      if (url.searchParams.get("archived")) return json({ data: [], cursor: { next: "older" } })
      return json({ data: [active], cursor: {} })
    },
  })

  await setup.waitForFrame((frame) => frame.includes("Ask anything"))
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Sessions") && frame.includes("Active root"))
  setup.mockInput.pressKey("b", { ctrl: true })
  await setup.waitFor(() => requests.some((url) => url.searchParams.get("archived")))
  await setup.waitForVisualIdle({ quietFrames: 2 })
  expect(requests.filter((url) => url.searchParams.get("archived") === "only")).toHaveLength(1)
})
