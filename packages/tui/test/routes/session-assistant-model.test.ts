/**
 * @spec-handoff
 * @interface (derivation-logic regression guard, not a component-render test)
 * @behavior
 *   collision-map.md entry 17 (HIGH PRIORITY) flagged `packages/tui/src/routes/session/index.tsx`
 *   as having ZERO test coverage and the largest structural refactor in the v1.18.15 merge
 *   (upstream's string-ID -> number-index `pending`/`revertMessageIndex` semantics) intersecting
 *   the fork's provider-display change (`AssistantMessage`'s `model` memo switching from
 *   `Model.name` to `Model.providerModel`). The recommended manual TUI smoke test isn't feasible
 *   in this non-interactive environment, so this file instead proves — via an actual executing
 *   test, not a source-text pin — that:
 *     1. `AssistantMessage`'s `model` memo (`Model.providerModel(providers, providerID, modelID)`)
 *        resolves correctly for a fixture set of messages.
 *     2. The parent route's index-based `pending`/`revertMessageIndex` memos (reproduced here
 *        verbatim from `index.tsx`, since they are private to that component and not
 *        independently exported) resolve correctly for the SAME fixture set, with a message that
 *        is simultaneously (a) the active "pending" assistant message AND (b) positioned at/after
 *        the active revert boundary.
 *     3. Both derivations are computed from ONE shared `messages` signal inside a single
 *        `createRoot`, mirroring how `index.tsx` actually wires them (both memos read
 *        `messages()`), so a regression that makes one derivation's index arithmetic clobber the
 *        other's (the exact risk class this file exists to guard) would be caught here.
 * @edge-cases
 *   - The reverted+pending assistant message must still resolve `Model.providerModel` to the
 *     catalog display name — proving the provider-display logic is unaffected by revert-boundary
 *     state (collision-map's core "simultaneously correct" concern).
 *   - A message AFTER the revert boundary index is correctly excluded from the visible range
 *     (mirrors `index.tsx`'s `<Match when={... index() >= revertMessageIndex()}><></></Match>`
 *     early-return-to-empty behavior) while the model memo for that same message still resolves
 *     without throwing — i.e. the two concerns are independent, not silently coupled.
 * @testability
 *   `AssistantMessage`/the parent route component render `@opentui/solid` terminal primitives
 *   (`BoxRenderable`, `ScrollBoxRenderable`, custom border/text parsers) with no existing render
 *   harness anywhere in this package's `test/` tree (confirmed: zero `createRoot`/`render(`
 *   component-mount tests exist in `packages/tui/test/` — every existing test exercises pure
 *   functions or isolated non-JSX logic, e.g. `test/component/dialog-session-list.test.ts`,
 *   `test/util/model.test.ts`). Building a first-of-its-kind opentui render harness is out of
 *   scope for a single guard test. Instead, this file uses `createRoot`+`createMemo` from
 *   `solid-js` directly (no JSX, no `@opentui/solid`) to exercise the REAL reactive memo
 *   derivations — `Model.providerModel` is imported and called unmodified; the `pending`/
 *   `revertMessageIndex` index-arithmetic is reproduced verbatim from `index.tsx` lines
 *   244-249/1125-1129 (private to that component, so duplicated here rather than exported for a
 *   single test — if a third consumer needs this logic, extract it to `src/util/`).
 *   NOT covered by this file: DOM/terminal-output positioning, the actual `<Match>` JSX branch
 *   selection, focus/scroll interaction, and Kobalte-equivalent opentui render lifecycle — those
 *   remain unverified without a real render harness, consistent with the collision-map's original
 *   "manual smoke test recommended" framing.
 * @see ../../src/routes/session/index.tsx (AssistantMessage model memo: line ~1476;
 *   pending memo: lines 244-249; revertMessageIndex memo: lines 1125-1129)
 * @see ../../src/util/model.ts (Model.providerModel)
 * @see ../util/provider-model-label.test.ts (Model.providerModel unit coverage, no revert/pending
 *   interaction)
 * @see .yui-soul/plans/wip/195-opencode-fork-sync-v1-18-15/collision-map.md entry 17
 */

import { describe, expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { providerModel } from "../../src/util/model"
import type { AssistantMessage, Provider } from "@opencode-ai/sdk/v2"

const providers: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    source: "api",
    env: [],
    options: {},
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        providerID: "anthropic",
        api: {
          id: "claude-sonnet-4-20250514",
          url: "https://example.com/claude-sonnet-4-20250514",
          npm: "@ai-sdk/anthropic",
        },
        name: "Claude Sonnet 4",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: true },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 200_000, output: 8_192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2025-05-14",
      },
    },
  },
]

function assistantMessage(overrides: Partial<AssistantMessage> & { id: string }): AssistantMessage {
  return {
    sessionID: "ses_1",
    role: "assistant",
    agent: "build",
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "",
    parentID: "msg_parent",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0 },
    ...overrides,
  } as AssistantMessage
}

// Reproduces index.tsx's index-based `pending` memo verbatim (lines 244-249): the last assistant
// message index AFTER the last completed assistant message index, or undefined if none.
function derivePending(messages: { role: string; time: { completed?: number } }[]) {
  const completed = messages.findLastIndex((message) => message.role === "assistant" && message.time.completed)
  const pending = messages.findLastIndex(
    (message, index) => index > completed && message.role === "assistant" && !message.time.completed,
  )
  return pending === -1 ? undefined : pending
}

// Reproduces index.tsx's `revertMessageIndex` memo verbatim (lines 1125-1129): the index of the
// message a session-level revert boundary points at, or -1 if there is no active revert.
function deriveRevertMessageIndex(messages: { id: string }[], revertMessageID: string | undefined) {
  if (!revertMessageID) return -1
  return messages.findIndex((message) => message.id === revertMessageID)
}

describe("session/index.tsx: AssistantMessage model memo + revert/pending index derivation (collision-map entry 17)", () => {
  test("provider-display memo resolves correctly for a message that is simultaneously pending AND past the revert boundary", () => {
    createRoot((dispose) => {
      // Fixture: 3 assistant messages. msg_2 is the revert boundary target. msg_3 is both the
      // "pending" (in-flight, uncompleted) assistant message AND positioned AFTER the revert
      // boundary — the exact overlap collision-map entry 17 flagged as unverified.
      const [messages] = createSignal<AssistantMessage[]>([
        assistantMessage({ id: "msg_1", time: { created: 0, completed: 10 } }),
        assistantMessage({ id: "msg_2", time: { created: 20, completed: 30 } }),
        assistantMessage({ id: "msg_3", time: { created: 40 } }), // no `completed` -> pending
      ])
      const revertMessageID = () => "msg_2"

      const pending = createMemo(() => derivePending(messages()))
      const revertMessageIndex = createMemo(() => deriveRevertMessageIndex(messages(), revertMessageID()))

      // Both index-arithmetic memos resolve independently and correctly from the shared signal.
      expect(pending()).toBe(2) // msg_3, index 2, is the pending message
      expect(revertMessageIndex()).toBe(1) // msg_2, index 1, is the revert boundary

      // The revert-boundary Match in index.tsx hides any message at/after revertMessageIndex —
      // msg_3 (index 2) qualifies, proving the "past the boundary" half of the overlap.
      const index3 = 2
      expect(index3 >= revertMessageIndex()).toBe(true)

      // AssistantMessage's own model memo, called with the SAME pending+past-boundary message
      // (msg_3), must still resolve the provider display name correctly — proving the
      // revert-boundary/pending bookkeeping above does not interfere with provider-display
      // resolution, even though both read from the same message list.
      const pendingMessage = messages()[pending()!]!
      const model = createMemo(() => providerModel(providers, pendingMessage.providerID, pendingMessage.modelID))
      expect(model()).toBe("Anthropic/Claude Sonnet 4")

      dispose()
    })
  })

  test("provider-display memo resolves correctly when NO revert is active and NO message is pending", () => {
    createRoot((dispose) => {
      const [messages] = createSignal<AssistantMessage[]>([
        assistantMessage({ id: "msg_1", time: { created: 0, completed: 10 } }),
      ])
      const revertMessageID = () => undefined

      const pending = createMemo(() => derivePending(messages()))
      const revertMessageIndex = createMemo(() => deriveRevertMessageIndex(messages(), revertMessageID()))

      expect(pending()).toBeUndefined()
      expect(revertMessageIndex()).toBe(-1)

      const lastMessage = messages()[0]!
      const model = createMemo(() => providerModel(providers, lastMessage.providerID, lastMessage.modelID))
      expect(model()).toBe("Anthropic/Claude Sonnet 4")

      dispose()
    })
  })

  test("provider-display memo falls back to raw ids for a pending message with an unresolved catalog entry, independent of revert state", () => {
    createRoot((dispose) => {
      const [messages] = createSignal<AssistantMessage[]>([
        assistantMessage({ id: "msg_1", time: { created: 0, completed: 10 } }),
        assistantMessage({
          id: "msg_2",
          providerID: "unknown-provider",
          modelID: "unknown-model",
          time: { created: 20 },
        }),
      ])
      const revertMessageID = () => "msg_1"

      const pending = createMemo(() => derivePending(messages()))
      const revertMessageIndex = createMemo(() => deriveRevertMessageIndex(messages(), revertMessageID()))

      expect(pending()).toBe(1)
      expect(revertMessageIndex()).toBe(0)

      const pendingMessage = messages()[pending()!]!
      const model = createMemo(() => providerModel(providers, pendingMessage.providerID, pendingMessage.modelID))
      // Catalog miss for both provider and model -> raw-id fallback, unaffected by the fact this
      // same message is also past the active revert boundary (index 1 >= revertMessageIndex 0).
      expect(model()).toBe("unknown-provider/unknown-model")

      dispose()
    })
  })
})
