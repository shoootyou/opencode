/**
 * @spec-handoff
 * @interface isDisplayOnly(message: SessionMessage.Info): boolean
 * @behavior
 *   - A synthetic reload notice marked with `opencode.fork.displayOnly: true` remains in the transcript but never reaches a model request.
 *   - History loading, runner history, preview, compaction requests, and textual recent context exclude the marked notice.
 *   - Unmarked synthetic guidance remains model-visible; only the boolean marker opts out.
 * @edge-cases
 *   - Missing, false, and string-valued markers are ordinary synthetic messages.
 *   - A completed reload notice precedes a later prompt after projection replay.
 * @see ../../src/fork-command-feedback.ts
 */
import { describe, expect, test } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, Message, type LLMRequest } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Bus } from "@opencode/core/bus"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instructions } from "@opencode/core/instructions/index"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionInbox } from "@opencode/core/session/inbox"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Location } from "@opencode/core/location"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionStore } from "@opencode/core/session/store"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { isDisplayOnly } from "@opencode/schema/fork-command-feedback"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { EventTable, } from "@opencode/core/event/sql"
import { InstructionStateTable, SessionInboxTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { testEffect } from "../lib/effect"

const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") })
const notice = "Reloaded 2 skills."
const guidance = "The refreshed skill is available."

const marked = (id = "msg_reload") =>
  SessionMessage.Synthetic.make({
    id: SessionMessage.ID.make(id),
    type: "synthetic",
    text: notice,
    description: notice,
    metadata: { "opencode.fork.displayOnly": true, source: "command", command: "reload", outcome: "success" },
    time: { created: DateTime.makeUnsafe(1) },
  })

const ordinary = (id = "msg_guidance", metadata?: Record<string, unknown>) =>
  SessionMessage.Synthetic.make({
    id: SessionMessage.ID.make(id),
    type: "synthetic",
    text: guidance,
    metadata,
    time: { created: DateTime.makeUnsafe(2) },
  })

describe("reload display-only model context", () => {
  // This is the canonical conversion immediately before the runner builds its provider request.
  // The request assertion below deliberately uses this exact conversion result, rather than a UI projection.
  test("next prompt's captured model request excludes reload feedback while retaining ordinary synthetic guidance", () => {
    const request = {
      messages: toLLMMessages(
        [marked(), ordinary(), SessionMessage.User.make({ id: SessionMessage.ID.make("msg_prompt"), type: "user", text: "Use it", time: { created: DateTime.makeUnsafe(3) } })],
        model,
      ),
    }

    expect(JSON.stringify(request.messages)).not.toContain(notice)
    expect(request.messages).toContainEqual(Message.make({ id: SessionMessage.ID.make("msg_guidance"), role: "user", content: guidance }))
    expect(JSON.stringify(request.messages)).toContain("Use it")
  })

  test("only an exact boolean marker is display-only", () => {
    for (const metadata of [undefined, {}, { "opencode.fork.displayOnly": false }, { "opencode.fork.displayOnly": "true" }]) {
      const message = ordinary(SessionMessage.ID.create(), metadata)
      expect(isDisplayOnly(message)).toBe(false)
      expect(toLLMMessages([message], model)).toHaveLength(1)
    }
    expect(isDisplayOnly(marked())).toBe(true)
  })
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

const setup = Effect.fnUntraced(function* () {
  const db = (yield* Database.Service).db
  const bus = yield* Bus.Service
  const inbox = yield* SessionInbox.Service
  const store = yield* SessionStore.Service
  const sessionID = Session.ID.create()
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
  yield* bus.publish(SessionEvent.Created, { sessionID, projectID: Project.ID.global, location: { directory: AbsolutePath.make("/project") }, slug: "reload-feedback", version: "test" })
  const instructions = Instructions.make({ key: Instructions.Key.make("test/reload-feedback"), codec: Schema.toCodecJson(Schema.String), read: Effect.succeed("instructions"), render: { initial: String, changed: (_previous, value) => value, removed: () => "removed" } })
  const feedback = (text = notice) => bus.publish(SessionEvent.Synthetic, { sessionID, text, description: text, metadata: { "opencode.fork.displayOnly": true } })
  const synthetic = (text = guidance) => bus.publish(SessionEvent.Synthetic, { sessionID, text })
  yield* InstructionState.prepare(db, bus, instructions, sessionID)
  return { db, bus, inbox, store, sessionID, instructions, feedback, synthetic }
})

it.effect("SessionHistory load, runner entries, and preview each exclude marked feedback", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    yield* s.feedback()
    yield* s.synthetic()
    for (const messages of [
      yield* SessionHistory.load(s.db, s.sessionID, "local"),
      (yield* SessionHistory.entriesForRunner(s.db, s.sessionID, s.instructions, "local")).entries.map((entry) => entry.message),
      (yield* SessionHistory.preview(s.db, s.sessionID, s.instructions, "local")).messages,
    ]) {
      const text = messages.flatMap((message) => (message.type === "user" || message.type === "synthetic" ? [message.text] : []))
      expect(text).not.toContain(notice)
      expect(text).toContain(guidance)
    }
  }),
)

it.effect("replaying the transcript retains the notice and orders it before a completed later prompt", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    yield* s.feedback()
    const promptID = SessionMessage.ID.make("msg_after_reload")
    yield* s.inbox.admit({ id: promptID, sessionID: s.sessionID, item: { type: "user", payload: { text: "Prompt after reload" }, delivery: "steer" } })
    expect(yield* SessionInbox.promote(s.db, s.bus, s.sessionID, "steer")).toBe(1)
    // Production promotion consumes the pending row and durably projects the prompt after the
    // reload notice, so replay must retain the same completed transcript order.
    const before = yield* s.store.messages({ sessionID: s.sessionID, order: "asc" })
    expect(before.flatMap((message) => (message.type === "user" || message.type === "synthetic" ? [message.text] : []))).toEqual([
      notice,
      "Prompt after reload",
    ])

    const events = yield* s.db.select().from(EventTable).where(eq(EventTable.aggregate_id, s.sessionID)).orderBy(asc(EventTable.seq)).all()
    yield* s.bus.remove(s.sessionID)
    yield* s.db.delete(SessionTable).where(eq(SessionTable.id, s.sessionID)).run()
    yield* s.db.delete(InstructionStateTable).where(eq(InstructionStateTable.session_id, s.sessionID)).run()
    yield* s.db.delete(SessionInboxTable).where(eq(SessionInboxTable.session_id, s.sessionID)).run()
    yield* s.db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, s.sessionID)).run()
    for (const event of events) yield* s.bus.replay({ id: event.id, created: event.created, aggregateID: event.aggregate_id, seq: event.seq, type: event.type, data: event.data })
    // Replay retains both the direct notice and the prompt projected by production promotion.
    expect(
      (yield* s.store.messages({ sessionID: s.sessionID, order: "asc" })).flatMap((message) =>
        message.type === "user" || message.type === "synthetic" ? [message.text] : [],
      ),
    ).toEqual([notice, "Prompt after reload"])
  }),
)

let compactionRequests: LLMRequest[] = []
const compactionClient = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    compactionRequests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "## Objective\n- summarized" }),
      LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" }, usage: { inputTokens: 1, outputTokens: 1, nonCachedInputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 } }),
      LLMEvent.finish({ reason: { normalized: "stop" } }),
    )
  },
  generate: () => Effect.die("unused"),
})
const compactionIt = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, SessionCompaction.node, SessionModelRequest.node, PluginHooks.node]),
  [Bus.node.replace(Bus.configured({ persist: true })), llmClient.replace(compactionClient), Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") }))],
))

compactionIt.effect("compaction request and saved textual recent context exclude marked feedback", () =>
  Effect.gen(function* () {
    compactionRequests = []
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const sessionID = Session.ID.create()
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    yield* bus.publish(SessionEvent.Created, { sessionID, projectID: Project.ID.global, location: { directory: AbsolutePath.make("/project") }, slug: "reload-compaction", version: "test" })
    const session = yield* store.get(sessionID)
    if (!session) return yield* Effect.die("missing session")
    const selected = SessionRunnerModel.resolved(LanguageModel.make({ id: "summary", provider: "test", route: OpenAIChat.route }), { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200_000, output: 32_000 } })
    const messages = [
      SessionMessage.User.make({ id: SessionMessage.ID.make("msg_before"), type: "user", text: "Before reload", time: { created: DateTime.makeUnsafe(0) } }),
      ordinary(),
      SessionMessage.User.make({ id: SessionMessage.ID.make("msg_after"), type: "user", text: "After reload", time: { created: DateTime.makeUnsafe(3) } }),
      marked(),
    ]
    const inputID = SessionMessage.ID.make("msg_compact")
    yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID })
    expect(yield* compaction.compact({ reason: "manual", inputID, context: { session, messages, model: selected, agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) }, initial: "", tools: { definitions: [], execute: () => Effect.die("unused") } } })).toEqual({ status: "completed" })
    expect(JSON.stringify(compactionRequests[0]?.messages)).not.toContain(notice)
    expect(JSON.stringify(compactionRequests[0]?.messages)).toContain(guidance)
    const saved = (yield* store.context(sessionID)).find(
      (message) => message.type === "compaction" && message.status === "completed",
    )
    expect(saved?.recent ?? "").not.toContain(notice)
  }),
)
