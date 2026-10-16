/**
 * @spec-handoff
 * @interface dict: Record<string, string>
 * @behavior
 *   - Includes every English key consumed by the v2 titlebar archive commands and archived-sessions dialog.
 *   - Includes the shared unarchive label used by the timeline archive toggle.
 * @edge-cases
 *   - A missing key must fail before a v2 UI path can render its raw key as user-visible copy.
 * @see ../../shell/titlebar/session-archive-commands.tsx
 * @see ../../shell/titlebar/dialog-archived-sessions.tsx
 */

import { describe, expect, test } from "bun:test"
import { dict } from "./en"

describe("v2 archive-session English translations", () => {
  test("contains every titlebar archive and archived-dialog key", () => {
    const keys = [
      "command.session.archive",
      "command.session.unarchive",
      "command.session.archivedBrowse",
      "dialog.archivedSessions.title",
      "dialog.archivedSessions.empty",
      "common.unarchive",
    ]

    expect(keys.filter((key) => !(key in dict))).toEqual([])
  })
})
