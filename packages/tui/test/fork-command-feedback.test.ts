/**
 * @spec-handoff
 * @interface filterStagedRevert(messages, revertMessageID?): SessionMessageInfo[]
 * @behavior
 *   - Treats a live, marked synthetic reload event as one ordinary transcript row, not a user or assistant row.
 *   - The renderer consumes that row's live synthetic description for its inline notice text.
 * @edge-cases
 *   - A marked feedback item is retained across staged revert filtering while ordinary post-boundary rows remain hidden.
 * @see ../src/routes/session/rows.ts
 */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { filterStagedRevert, reduceSessionRows } from "../src/routes/session/rows"

test("projects one live reload feedback event as a synthetic transcript row without user or assistant rows", () => {
  const feedback = {
    id: "msg_reload",
    type: "synthetic" as const,
    text: "Reloaded 1 skill.",
    description: "Reloaded 1 skill.",
    metadata: { "opencode.fork.displayOnly": true, source: "command", command: "reload", outcome: "success" },
    time: { created: 1 },
  }
  const rows = reduceSessionRows([feedback] satisfies SessionMessageInfo[])

  expect(rows).toEqual([{ type: "message", messageID: feedback.id }])
})

test("retains marked feedback at or beyond a staged revert boundary while hiding ordinary later messages", () => {
  const feedback = (id: string) => ({
    id,
    type: "synthetic" as const,
    text: "Reloaded 1 skill.",
    description: "Reloaded 1 skill.",
    metadata: { "opencode.fork.displayOnly": true },
    time: { created: 1 },
  })
  const messages = [
    { id: "msg_000001", type: "user" as const, text: "before boundary", time: { created: 1 } },
    feedback("msg_000002"),
    { id: "msg_000003", type: "user" as const, text: "ordinary later prompt", time: { created: 3 } },
    feedback("msg_000004"),
    {
      id: "msg_000005",
      type: "synthetic" as const,
      text: "not display-only",
      metadata: { "opencode.fork.displayOnly": "true" },
      time: { created: 5 },
    },
  ] satisfies SessionMessageInfo[]

  expect(filterStagedRevert(messages, "msg_000002").map((message) => message.id)).toEqual([
    "msg_000001",
    "msg_000002",
    "msg_000004",
  ])
  expect(filterStagedRevert(messages).map((message) => message.id)).toEqual(messages.map((message) => message.id))
})
