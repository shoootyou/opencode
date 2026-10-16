/**
 * @spec-handoff
 * @interface TuiKeybind.Definitions: Record<string, { default: string; description: string }>
 * @behavior
 *   - Provides disabled-by-default archive and archived-list visibility actions.
 *   - Describes the archive action as archiving or unarchiving a session.
 */
import { expect, test } from "bun:test"
import { TuiKeybind } from "../src/config/keybind"

test("binds agent cycling only to shift+tab by default", () => {
  expect(TuiKeybind.Definitions["agent.cycle"].default).toBe("shift+tab")
  expect(TuiKeybind.Definitions["agent.cycle.reverse"].default).toBe("none")
})

test("defines disabled archive and archived-session visibility actions", () => {
  expect(TuiKeybind.Definitions["session.archive.toggle"]).toMatchObject({
    default: "none",
    description: "Archive or unarchive session",
  })
  expect(TuiKeybind.Definitions["session.archived.toggle_visibility"]).toMatchObject({
    default: "none",
  })
})
