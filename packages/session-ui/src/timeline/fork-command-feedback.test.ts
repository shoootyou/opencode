/**
 * @spec-handoff
 * @interface Timeline.constructSessionMessageRows(messages, detail): TimelineRow[]
 * @behavior
 *   - Renders marked reload feedback as a required standalone notice in every timeline preset.
 *   - Keeps ordinary unmarked notices subject to the existing hidden/grouped behavior.
 * @edge-cases
 *   - A marked feedback notice remains separate when notices are grouped and remains visible when hidden.
 * @see ./detail.ts
 */
import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { timelinePresets } from "./detail"
import { Timeline } from "./projection"

const feedback = {
  id: "msg_reload",
  type: "synthetic" as const,
  text: "Reloaded 1 skill.",
  description: "Reloaded 1 skill.",
  metadata: { "opencode.fork.displayOnly": true, source: "command", command: "reload", outcome: "success" },
  time: { created: 1 },
} satisfies SessionMessageInfo

describe("display-only command feedback timeline rows", () => {
  test("keeps feedback visible and standalone in every preset", () => {
    for (const preset of timelinePresets) {
      const rows = Timeline.constructSessionMessageRows(
        [feedback],
        true,
        { type: "idle" },
        undefined,
        false,
        false,
        undefined,
        preset.value,
      ).rows
      expect(rows).toMatchObject([{ _tag: "Notice", messageID: feedback.id }])
      expect(rows).toHaveLength(1)
    }
  })

  test("preserves existing hidden and grouped behavior for ordinary synthetic notices", () => {
    const ordinary = { ...feedback, id: "msg_ordinary", metadata: { source: "command" } } satisfies SessionMessageInfo
    const quiet = timelinePresets.find((preset) => preset.id === "quiet")!
    const compact = timelinePresets.find((preset) => preset.id === "compact")!

    expect(
      Timeline.constructSessionMessageRows([ordinary], true, { type: "idle" }, undefined, false, false, undefined, quiet.value)
        .rows,
    ).toEqual([])
    expect(
      Timeline.constructSessionMessageRows([ordinary], true, { type: "idle" }, undefined, false, false, undefined, compact.value)
        .rows[0]?._tag,
    ).toBe("AssistantPart")
  })
})
