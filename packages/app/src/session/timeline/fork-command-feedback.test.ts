/**
 * @spec-handoff
 * @interface visibleTimelineMessages(messages, pending, revertMessageID?): SessionMessageInfo[]
 * @behavior
 *   - Retains a marked reload feedback notice at a staged-revert boundary.
 *   - Does not synthesize user or assistant messages for command feedback.
 * @edge-cases
 *   - Ordinary messages at and after the revert boundary retain their existing filtering behavior.
 * @see ./controller-projection.ts
 */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { visibleTimelineMessages } from "./controller-projection"

test("keeps display-only reload feedback visible during a staged revert without adding a prompt", () => {
  const feedback = {
    id: "msg_000001",
    type: "synthetic" as const,
    text: "Reloaded 1 skill.",
    description: "Reloaded 1 skill.",
    metadata: { "opencode.fork.displayOnly": true, source: "command", command: "reload", outcome: "success" },
    time: { created: 1 },
  }
  const later = { id: "msg_000002", type: "user" as const, text: "next prompt", time: { created: 2 } }
  const visible = visibleTimelineMessages([feedback, later] satisfies SessionMessageInfo[], [], feedback.id)

  expect(visible).toEqual([feedback])
  expect(visible.filter((message) => message.type === "user" || message.type === "assistant")).toEqual([])
})
