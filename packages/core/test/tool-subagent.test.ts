/**
 * @spec-handoff
 * @interface subagent({ agent, description, prompt, model? }): SubagentResult
 * @behavior
 *   - Registers exactly one public Core delegation tool named `subagent`, never a `task` alias.
 *   - Resolves an omitted model as agent → parent, without mutating caller input.
 *   - Accepts available provider/model references and lets an explicit model override the agent default.
 *   - Rejects malformed, prototype-shaped, and unavailable model references before child side effects.
 *   - Limits child effective read, subagent, and skill permissions to parent restrictions and target-agent restrictions.
 * @edge-cases
 *   - A new child treats `model: ""` as invalid; an existing-child continuation retains its current model.
 *   - Prototype-named provider, model, and variant segments are invalid format, never object-lookup defects.
 *   - Parent `ask` never becomes child `allow`.
 */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import path from "path"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { Tool } from "@opencode/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const childText = "child final response"
const completedOutput = (sessionID: Session.ID) =>
  `<subagent sessionID="${sessionID}" state="completed">\n${childText}\n</subagent>`
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const overrideModel = Model.Ref.make({
  id: Model.ID.make("override"),
  providerID: Provider.ID.make("test"),
  variant: Model.VariantID.make("fast"),
})
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("SubagentTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        if ((yield* store.get(sessionID))?.title?.includes("fail")) {
          yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID })
          return
        }
        completed.add(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
        })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: childText,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const subagentPluginSupervisor = makeLocationNode({
  name: "test/subagent-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(SubagentTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    Model.node,
    Permission.node,
    Session.node,
    Job.node,
    SubagentJob.node,
    Tool.node,
    PluginHooks.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
])
const replacements = [
  SessionExecution.node.replace(executionNode),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(
  AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(subagentPluginSupervisor)]),
)
const completionIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([nodes, SessionRestart.node, KV.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    PluginSupervisor.node.replace(subagentPluginSupervisor),
    LayerNodePlatform.llmClient.replace(TestLLM.testLayer({ fallback: TestLLM.text(childText, "completion") })),
    SessionRunnerModel.node.replace(
      Layer.succeed(SessionRunnerModel.Service, {
        resolve: () =>
          Effect.succeed(
            SessionRunnerModel.resolved(
              LanguageModel.make({ id: "child", provider: "test", route: OpenAIChat.route }),
              {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                cost: [],
                limit: { context: 200_000, output: 32_000 },
              },
            ),
          ),
      }),
    ),
  ]),
)

const withSubagent = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(location)))
    yield* Provider.Service.use((providers) =>
      providers.transform((editor) => {
        editor.models.update(overrideModel.providerID, overrideModel.id, (model) => {
          model.variants = [{ id: Model.VariantID.make("fast") }]
        })
        editor.models.update(Provider.ID.make("test"), Model.ID.make("plain"), () => {})
      }),
    ).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        // The caller identity used by executeTool; subagent permission asserts against it.
        editor.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
        editor.update(Agent.ID.make("fallback"), (agent) => {
          agent.mode = "subagent"
        })
        editor.update(Agent.ID.make("primary"), (agent) => {
          agent.mode = "primary"
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

describe("SubagentTool", () => {
  completionIt.live("admits one durable completion across live delivery and restart replay", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            model: parentModel,
            title: "Completion recipient",
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          const bus = yield* Bus.Service
          const admitted = yield* Deferred.make<Job.Background>()
          const notifications: SessionMessage.ID[] = []
          yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
            Effect.gen(function* () {
              if (event.data.sessionID !== parent.id || event.data.item.type !== "synthetic") return
              notifications.push(event.data.inboxID)
              const marker = (yield* jobs.pendingBackground).find((job) => job.notificationID === event.data.inboxID)
              // The marker must survive until admission commits, not merely until delivery starts.
              expect(marker?.status).toBe("completed")
              if (marker) yield* Deferred.succeed(admitted, marker)
            }),
          )

          const result = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-completion-replay",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "background review", prompt: "review", background: true },
            },
          })
          const marker = yield* Deferred.await(admitted)
          yield* jobs.pendingBackground.pipe(Effect.repeat({ until: (pending) => pending.length === 0 }))
          yield* sessions.wait(parent.id)
          const messages = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(messages).toEqual([
            expect.objectContaining({
              id: marker.notificationID,
              description: "background review",
              text: `<subagent sessionID="${outputSessionID(result.metadata)}" state="completed" description="background review">\n${childText}\n</subagent>`,
              metadata: {
                source: "subagent",
                childID: outputSessionID(result.metadata),
                agent: "reviewer",
                state: "completed",
              },
            }),
          ])

          // Reproduce a crash after admission but before acknowledgment using the real persisted marker.
          const kv = yield* KV.Service
          yield* kv.set(`job.background/${marker.notificationID}`, marker)
          const restart = yield* SessionRestart.Service
          yield* restart.resumeSuspendedSessions
          yield* sessions.wait(parent.id)
          expect(notifications).toEqual([marker.notificationID])
          expect((yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")).toEqual(
            messages,
          )
          expect(yield* jobs.pendingBackground).toEqual([])
        }),
      ),
    ),
  )

  productionIt.live(
    "registers exactly one public subagent owner through the Core plugin flow while resolving agents from the caller location",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const session = yield* Session.Service
            const parent = yield* session.create({ location })
            yield* withSubagent(parent.location)

            const locations = yield* LocationServiceMap.Service
            const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
            const publicDelegationTools = (yield* registry.snapshot()).definitions
              .map((tool) => tool.name)
              .filter((name) => name === SubagentTool.name || name === "task")
            expect(publicDelegationTools).toEqual(["subagent"])
            expect(
              yield* executeTool(registry, {
                sessionID: parent.id,
                ...toolIdentity,
                call: {
                  type: "tool-call",
                  id: "call-primary",
                  name: SubagentTool.name,
                  input: { agent: "primary", description: "primary", prompt: "should fail" },
                },
              }),
            ).toEqual({
              status: "error",
              error: { type: "tool.execution", message: "Agent primary cannot run as a subagent" },
            })
          }),
        ),
      ),
  )

  it.live("prevents subagents from launching subagents by default", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent" })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-nested-subagent",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "nested", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: expect.stringContaining("Subagent depth limit reached (1)"),
            },
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("allows nested subagents up to the configured depth", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(path.join(dir.path, "opencode.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
          )
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent", model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-configured-nested-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "nested", prompt: "should run" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            metadata: { status: "completed" },
            content: [{ type: "text", text: expect.stringContaining(childText) }],
          })
          expect(settled.metadata).toEqual({
            sessionID: outputSessionID(settled.metadata),
            status: "completed",
          })
          expect((yield* sessions.get(outputSessionID(settled.metadata))).parentID).toBe(parent.id)
        }),
      ),
    ),
  )

  it.live("runs a foreground child session and returns the final assistant text", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const progress: Tool.Metadata[] = []

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            progress: (update) => Effect.sync(() => progress.push(update)),
            call: {
              type: "tool-call",
              id: "call-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this", sessionID: "" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            metadata: { status: "completed" },
            content: [{ type: "text", text: expect.stringContaining(childText) }],
          })
          const child = yield* sessions.get(outputSessionID(settled.metadata))
          expect(settled.content).toEqual([{ type: "text", text: completedOutput(child.id) }])
          expect(settled.metadata).toEqual({ sessionID: child.id, status: "completed" })
          expect(progress[0]).toEqual({ sessionID: child.id, status: "running" })
          expect(child).toMatchObject({
            parentID: parent.id,
            location: parent.location,
            agent: "reviewer",
            model: childModel,
          })
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
            "You are a subagent spawned by another session.\nreview this",
          )

          const fallback = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-fallback",
              name: SubagentTool.name,
              input: { agent: "fallback", description: "fallback", prompt: "fallback" },
            },
          })
          const fallbackChild = yield* sessions.get(outputSessionID(fallback.metadata))
          expect(fallbackChild).toMatchObject({ parentID: parent.id, model: parentModel })
        }),
      ),
    ),
  )

  it.live("continues an existing child session", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const first = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-first",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          const second = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-second",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue this",
                sessionID: childID,
                model: "",
              },
            },
          })

          expect(outputSessionID(second.metadata)).toBe(childID)
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
          expect((yield* sessions.get(childID)).title).toBe("review")
          expect(
            (yield* sessions.inbox(childID)).flatMap((message) =>
              message.type === "user" ? [message.payload.text] : [],
            ),
          ).toEqual(["You are a subagent spawned by another session.\nreview this", "continue this"])
          expect(second.content).toEqual([{ type: "text", text: completedOutput(childID) }])
        }),
      ),
    ),
  )

  it.live("steers a running child session in the background", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          yield* jobs.start({ id: child.id, type: SubagentTool.name, run: Effect.never })

          const result = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-running-subagent",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue while running",
                sessionID: child.id,
                background: true,
              },
            },
          })

          expect(result).toMatchObject({
            status: "completed",
            metadata: { sessionID: child.id, status: "running" },
          })
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
            "continue while running",
          )
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          yield* jobs.cancel(child.id)
        }),
      ),
    ),
  )

  it.live("rejects unrelated children and switches agents on continuation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const otherParent = yield* sessions.create({ location, model: parentModel })
          const unrelated = yield* sessions.create({
            parentID: otherParent.id,
            title: "other review",
            agent: Agent.ID.make("reviewer"),
          })
          const switched = yield* sessions.create({
            parentID: parent.id,
            title: "fallback review",
            agent: Agent.ID.make("fallback"),
            model: parentModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (sessionID: Session.ID, id: string, agent = "reviewer") =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent, description: "follow up", prompt: "continue", sessionID },
              },
            })

          const missing = Session.ID.create()
          expect(yield* call(missing, "call-missing-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Subagent session not found: ${missing}`,
            },
          })
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-malformed-child-id",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "follow up", prompt: "continue", sessionID: "placeholder" },
              },
            }),
          ).toMatchObject({
            status: "error",
            error: { message: expect.stringContaining('sessionID: Expected a string starting with "ses"') },
          })
          expect(yield* call(parent.id, "call-parent-id")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${parent.id} is not a child of the current session`,
            },
          })
          expect(yield* call(unrelated.id, "call-unrelated-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${unrelated.id} is not a child of the current session`,
            },
          })
          expect(yield* call(switched.id, "call-switched-child")).toMatchObject({
            status: "completed",
            metadata: { sessionID: switched.id, status: "completed" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "reviewer",
            model: childModel,
          })
          // Switching to an agent without a configured model keeps the child's current model.
          expect(yield* call(switched.id, "call-modelless-switch", "fallback")).toMatchObject({
            status: "completed",
            metadata: { sessionID: switched.id, status: "completed" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "fallback",
            model: childModel,
          })
        }),
      ),
    ),
  )

  it.live(
    "runs the child on an explicitly requested provider/model reference and gives it precedence over the agent model",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            yield* withSubagent(parent.location)
            const locations = yield* LocationServiceMap.Service
            const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
            const call = (id: string, input: Record<string, unknown>) =>
              executeTool(registry, {
                sessionID: parent.id,
                ...toolIdentity,
                call: {
                  type: "tool-call" as const,
                  id,
                  name: SubagentTool.name,
                  input: { agent: "reviewer", description: "review", prompt: "review this", ...input },
                },
              })

            // The requested model beats the agent's configured model.
            const spawned = yield* call("call-override", { model: "test/override#fast", sessionID: "" })
            expect(spawned).toMatchObject({ status: "completed", metadata: { status: "completed" } })
            const child = yield* sessions.get(outputSessionID(spawned.metadata))
            expect(child).toMatchObject({ agent: "reviewer", model: overrideModel })

            // Continuing with a model switches the existing child even when the agent is unchanged.
            const continued = yield* call("call-override-continue", { sessionID: child.id, model: "test/override" })
            expect(continued).toMatchObject({ status: "completed", metadata: { sessionID: child.id } })
            expect((yield* sessions.get(child.id)).model).toEqual({
              id: overrideModel.id,
              providerID: overrideModel.providerID,
              variant: Model.VariantID.make("default"),
            })

            const failures = [
              ["not-a-ref", 'Invalid model "not-a-ref". Use "providerID/modelID" or "providerID/modelID#variant".'],
              ["test/missing", 'Model "test/missing" is not available. Use the models tool to see what is available.'],
              ["test/override#slow", 'Variant "slow" is not available for "test/override". Available: fast.'],
              ["test/plain#high", 'Model "test/plain" has no variants. Omit the variant.'],
            ] as const
            for (const [model, message] of failures) {
              expect(yield* call(`call-${model}`, { model })).toEqual({
                status: "error",
                error: { type: "tool.execution", message },
              })
            }
          }),
        ),
      ),
  )

  it.live(
    "rejects an empty model for a new child after execute.before without mutating frozen caller input or creating side effects",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            yield* withSubagent(parent.location)
            const locations = yield* LocationServiceMap.Service
            const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
            const jobs = yield* Job.Service
            const bus = yield* Bus.Service
            const prompted: Session.ID[] = []
            yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
              Effect.sync(() => prompted.push(event.data.sessionID)),
            )
            const input = Object.freeze({
              agent: "reviewer",
              description: "empty model",
              prompt: "must not prompt",
              model: "",
              sessionID: "",
              metadata: Object.freeze({ preserved: Object.freeze(["caller-owned"]) }),
            })

            expect(
              yield* executeTool(registry, {
                sessionID: parent.id,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-empty-new-child-model", name: SubagentTool.name, input },
              }),
            ).toEqual({
              status: "error",
              error: {
                type: "tool.execution",
                message: 'Invalid model "". Use "providerID/modelID" or "providerID/modelID#variant".',
              },
            })
            expect(input).toEqual({
              agent: "reviewer",
              description: "empty model",
              prompt: "must not prompt",
              model: "",
              sessionID: "",
              metadata: { preserved: ["caller-owned"] },
            })
            expect((yield* sessions.list({ parentID: parent.id })).data).toEqual([])
            expect(prompted).toEqual([])
            expect(yield* jobs.pendingBackground).toEqual([])
          }),
        ),
      ),
  )

  it.live("rejects malformed and prototype-shaped model references before child, prompt, or job side effects", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (id: string, model: string) => {
            const input = Object.freeze({
              agent: "reviewer",
              description: "review",
              prompt: "review this",
              model,
              metadata: Object.freeze({ preserved: Object.freeze(["caller-owned"]) }),
            })
            return executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: { type: "tool-call", id, name: SubagentTool.name, input },
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  expect(input).toEqual({
                    agent: "reviewer",
                    description: "review",
                    prompt: "review this",
                    model,
                    metadata: { preserved: ["caller-owned"] },
                  }),
                ),
              ),
            )
          }

          const invalid = [
            "",
            "test",
            "/override",
            "test/",
            "test//override",
            "test/override#",
            "test/override##fast",
            "test/override#fast#extra",
            ...["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"].flatMap((segment) => [
              `${segment}/override`,
              `test/${segment}`,
              `test/override#${segment}`,
            ]),
          ]
          for (const model of invalid) {
            expect(yield* call(`call-invalid-${model || "empty"}`, model)).toEqual({
              status: "error",
              error: {
                type: "tool.execution",
                message: `Invalid model "${model}". Use "providerID/modelID" or "providerID/modelID#variant".`,
              },
            })
          }
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)

          expect(yield* call("call-unknown-provider", "missing/child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: 'Provider "missing" is not available. Use the models tool to see what is available.',
            },
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)

          // A rejected continuation must not alter its existing child or enqueue its prompt.
          const spawned = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-valid-child-before-invalid-continuation",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "first prompt" },
            },
          })
          const childID = outputSessionID(spawned.metadata)
          const childBefore = yield* sessions.get(childID)
          const inboxBefore = yield* sessions.inbox(childID)
          const jobs = yield* Job.Service
          const jobBefore = yield* jobs.get(childID)
          const continuationBaseline = {
            child: { agent: childBefore.agent, model: childBefore.model },
            inbox: inboxBefore,
            job: jobBefore,
          }
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-invalid-continuation-before-side-effects",
                name: SubagentTool.name,
                input: {
                  agent: "fallback",
                  description: "must not update",
                  prompt: "must not enqueue",
                  sessionID: childID,
                  model: "test//override",
                },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: 'Invalid model "test//override". Use "providerID/modelID" or "providerID/modelID#variant".',
            },
          })
          expect({
            child: {
              agent: (yield* sessions.get(childID)).agent,
              model: (yield* sessions.get(childID)).model,
            },
            inbox: yield* sessions.inbox(childID),
            job: yield* jobs.get(childID),
          }).toEqual(continuationBaseline)
          expect(yield* sessions.get(childID)).toMatchObject({
            agent: continuationBaseline.child.agent,
            model: continuationBaseline.child.model,
          })
          expect(yield* sessions.inbox(childID)).toEqual(continuationBaseline.inbox)
          expect(yield* jobs.get(childID)).toEqual(continuationBaseline.job)
        }),
      ),
    ),
  )

  it.live(
    "reports unknown providers, unavailable models, absent variants, and unavailable variants with stable sorted errors",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            yield* withSubagent(parent.location)
            const locations = yield* LocationServiceMap.Service
            const layer = locations.get(parent.location)
            yield* Provider.Service.use((providers) =>
              providers.transform((editor) => {
                editor.models.update(overrideModel.providerID, overrideModel.id, (model) => {
                  model.variants = [{ id: Model.VariantID.make("zeta") }, { id: Model.VariantID.make("alpha") }]
                })
              }),
            ).pipe(Effect.provide(layer))
            const registry = yield* Tool.Service.pipe(Effect.provide(layer))
            const call = (id: string, model: string) =>
              executeTool(registry, {
                sessionID: parent.id,
                ...toolIdentity,
                call: {
                  type: "tool-call" as const,
                  id,
                  name: SubagentTool.name,
                  input: { agent: "reviewer", description: "review", prompt: "review this", model },
                },
              })

            const failures = [
              [
                "missing/override",
                'Provider "missing" is not available. Use the models tool to see what is available.',
              ],
              ["test/missing", 'Model "test/missing" is not available. Use the models tool to see what is available.'],
              ["test/plain#high", 'Model "test/plain" has no variants. Omit the variant.'],
              ["test/override#slow", 'Variant "slow" is not available for "test/override". Available: alpha, zeta.'],
            ] as const
            for (const [model, message] of failures) {
              expect(yield* call(`call-semantic-${model}`, model)).toEqual({
                status: "error",
                error: { type: "tool.execution", message },
              })
            }
            expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
          }),
        ),
      ),
  )

  it.live("keeps a real child within parent and target-agent permission bounds", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({
            location,
            model: parentModel,
            permissions: [
              { action: "bash", resource: "*", effect: "deny" },
              { action: "edit", resource: "*", effect: "ask" },
              { action: "skill", resource: "deploy", effect: "deny" },
              { action: "skill", resource: "review", effect: "ask" },
            ],
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const layer = locations.get(parent.location)
          const registry = yield* Tool.Service.pipe(Effect.provide(layer))
          yield* Agent.Service.use((agents) =>
            agents.transform((editor) => {
              editor.update(Agent.ID.make("reviewer"), (agent) => {
                agent.permissions = [
                  { action: "bash", resource: "*", effect: "allow" },
                  { action: "edit", resource: "*", effect: "allow" },
                  { action: "read", resource: "*", effect: "deny" },
                  { action: "subagent", resource: "*", effect: "deny" },
                ]
              })
            }),
          ).pipe(Effect.provide(layer))
          const spawned = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-parent-bounded-child",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this" },
            },
          })
          const childID = outputSessionID(spawned.metadata)
          const permission = yield* Permission.Service.pipe(Effect.provide(layer))
          expect(
            yield* permission.ask({
              sessionID: childID,
              action: "bash",
              resources: ["git status"],
              save: [],
              source: { type: "tool", messageID: SessionMessage.ID.make("msg_parent_permission"), id: "bash" },
            }),
          ).toMatchObject({ effect: "deny" })
          expect(
            yield* permission.ask({
              sessionID: childID,
              action: "edit",
              resources: ["README.md"],
              save: [],
              source: { type: "tool", messageID: SessionMessage.ID.make("msg_parent_permission"), id: "edit" },
            }),
          ).toMatchObject({ effect: "ask" })
          expect(
            yield* permission.ask({
              sessionID: childID,
              action: "skill",
              resources: ["deploy"],
              save: [],
              source: { type: "tool", messageID: SessionMessage.ID.make("msg_parent_permission"), id: "skill" },
            }),
          ).toMatchObject({ effect: "deny" })
          expect(
            yield* permission.ask({
              sessionID: childID,
              action: "skill",
              resources: ["review"],
              save: [],
              source: { type: "tool", messageID: SessionMessage.ID.make("msg_parent_permission"), id: "skill" },
            }),
          ).toMatchObject({ effect: "ask" })
          expect(
            yield* permission.ask({
              sessionID: childID,
              action: "read",
              resources: ["*"],
              save: [],
              source: { type: "tool", messageID: SessionMessage.ID.make("msg_parent_permission"), id: "read" },
            }),
          ).toMatchObject({ effect: "deny" })
          expect(
            yield* permission.ask({
              sessionID: childID,
              action: "subagent",
              resources: ["reviewer"],
              save: [],
              source: { type: "tool", messageID: SessionMessage.ID.make("msg_parent_permission"), id: "subagent" },
            }),
          ).toMatchObject({ effect: "deny" })
        }),
      ),
    ),
  )

  it.live("returns child runner failures as tool errors", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-subagent-failure",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "fail review", prompt: "please fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: expect.stringContaining("No model is available for session"),
            },
          })
        }),
      ),
    ),
  )

  it.live("notifies once when background work completes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const bus = yield* Bus.Service
          const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.item.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-background-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "background review", prompt: "review", background: true },
            },
          })
          const childID = outputSessionID(settled.metadata)
          expect(settled.metadata).toMatchObject({
            status: "running",
          })
          expect(settled.metadata).toEqual({ sessionID: childID, status: "running" })
          expect(settled.content).toEqual([{ type: "text", text: expect.stringContaining(`sessionID: ${childID}`) }])

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.item.type).toBe("synthetic")
          if (admission?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
          expect(admission?.data.item.payload.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(admission?.data.item.payload).toMatchObject({
            description: "background review",
            metadata: {
              source: "subagent",
              childID,
              agent: "reviewer",
              state: "completed",
            },
          })
          const database = yield* Database.Service
          yield* SessionInbox.promote(database.db, bus, parent.id, "steer")
          const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(synthetic).toHaveLength(1)
          expect(synthetic[0]?.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(synthetic[0]?.text).toContain(childText)
        }),
      ),
    ),
  )
})
