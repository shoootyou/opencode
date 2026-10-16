/**
 * @spec-handoff
 * @interface nextArchivedAt(current: number | null | undefined, now: number): number | null
 * @behavior
 *   - Returns now when an active session is archived.
 *   - Returns null when an archived session is unarchived.
 * @edge-cases
 *   - An epoch-zero archived timestamp is treated as archived.
 */
import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { lastAssistantWithUsage, nextArchivedAt, sessionFamily } from "../../src/util/session"

const assistant = (id: string, input: number): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0 },
})

describe("util.session", () => {
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  test("tracks usage across undo and redo boundaries", () => {
    const messages = [assistant("msg_z", 10), assistant("msg_a", 30)]

    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
    expect(lastAssistantWithUsage(messages, "msg_a")?.tokens.input).toBe(10)
    expect(lastAssistantWithUsage(messages, "msg_missing")).toBeUndefined()
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
  })

  test("resets usage at completed compaction until the next assistant reports it", () => {
    const compaction: SessionMessageInfo = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "Current state",
      recent: "",
      time: { created: 0 },
    }
    const messages = [assistant("msg_before", 30), compaction]

    expect(lastAssistantWithUsage(messages)).toBeUndefined()

    messages.push(assistant("msg_after", 5))
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(5)
  })

  describe("nextArchivedAt", () => {
    test("archives an active session with the provided timestamp", () => {
      expect(nextArchivedAt(undefined, 1_700_000_000_000)).toBe(1_700_000_000_000)
      expect(nextArchivedAt(null, 1_700_000_000_000)).toBe(1_700_000_000_000)
    })

    test("unarchives an archived session by clearing the timestamp", () => {
      expect(nextArchivedAt(1_650_000_000_000, 1_700_000_000_000)).toBeNull()
      expect(nextArchivedAt(0, 1_700_000_000_000)).toBeNull()
    })
  })
})
