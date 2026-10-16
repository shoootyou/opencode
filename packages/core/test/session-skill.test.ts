/**
 * @spec-handoff
 * @interface Session.catalogue({ sessionID: Session.ID }): Effect<Command.Info[]>
 * @interface Session.command({ sessionID: Session.ID; command: string; text: string }): Effect<void, Command.NotFoundError>
 * @behavior
 *   - Resolves session Location, Agent, Skill, and Instance services to list only effectively allowed skills.
 *   - Executes an allowed projected skill from its operation snapshot with canonical Skill.toModelOutput content.
 *   - Attaches model text escaped from raw structural metadata while retaining raw attachment IDs and names.
 *   - Returns the same command-not-found shape for denied and missing projected skill IDs.
 * @edge-cases
 *   - Session deny overrides agent allow; session allow after agent deny follows Permission.merge.
 *   - A direct prompt mention for a session-denied skill rejects before durable prompt admission or skill activation.
 *   - An explicit command with the same skill ID wins both listing and execution.
 *   - A session agent absent from its location denies the skill catalogue, command projection, and attachment.
 *   - A reload cannot mix catalogue, resolution, and attachment skill generations within one operation.
 *   - A pending or delivered retry succeeds after its originally admitted skill is removed or denied.
 *   - Hook-injected attachments resolve one post-hook snapshot; detached Handle and facade both route by current placement.
 * @see ../src/fork/capabilities/service.ts
 * @mutation-targets snapshot-before-reconcile; re-fetch-at-materialization; detached-handle capability caching
 */
import type { FileSystem } from "@opencode/core/filesystem"
import path from "path"
import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, LayerMap } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionPrompt } from "@opencode/core/session/prompt"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSkill } from "@opencode/core/session/skill"
import { SessionStore } from "@opencode/core/session/store"
import { SessionInbox } from "@opencode/core/session/inbox"
import { Instance } from "@opencode/core/instance/service"
import { Skill } from "@opencode/core/skill"
import { Command } from "@opencode/core/command"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { node as ForkCapabilitiesNode } from "@opencode/core/fork/capabilities"
import { Event } from "@opencode/schema/event"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { registerIntegrationPolicy } from "./fixture/policy"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const info = Skill.Info.make({
  id: Skill.ID.make("effect"),
  name: Skill.Name.make("Effect"),
  description: "Effect guidance",
  path: AbsolutePath.make(path.resolve("/skills/effect.md")),
  content: "  Use Effect\n",
})
const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const managed = yield* ManagedPolicy.Service
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          // These tests need skill activation and prompt preparation from the same location services.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          Layer.mergeAll(
            Layer.effectDiscard(
              Effect.gen(function* () {
                const skills = yield* Skill.Service
                const agents = yield* Agent.Service
                yield* skills.transform((editor) => editor.add(info))
                yield* agents.transform((editor) => {
                  editor.update(Agent.defaultID, () => {})
                  editor.default(Agent.defaultID)
                })
                yield* registerIntegrationPolicy({ skill: skills })
              }),
            ).pipe(
              Layer.provideMerge(
                LayerNode.compile(
                  LayerNode.group([
                     PluginHooks.node,
                     Image.node,
                     Plugin.node,
                     ConfigSkillReload.node,
                     ForkCapabilitiesNode,
                     Skill.node,
                    Command.node,
                    Agent.node,
                    Config.node,
                    ManagedPolicy.node,
                  ]),
                  {
                    replacements: [
                       Config.node.replace(Config.testLayer()),
                       Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
                       ManagedPolicy.node.replace(Layer.succeed(ManagedPolicy.Service, managed)),
                    ],
                  },
                ),
              ),
            ),
          ) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
        { idleTimeToLive: Duration.infinity },
      )
    }),
  ),
  deps: [ManagedPolicy.node],
})
const instances = makeGlobalNode({
  service: Instance.Service,
  layer: Layer.effect(
    Instance.Service,
    Effect.map(LocationServiceMap.Service, (locations) =>
      Instance.Service.of({
        provide: (session) => (effect) => effect.pipe(Effect.provide(locations.get(session.location))),
      }),
    ),
  ),
  deps: [LocationServiceMap.node],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      FSUtil.node,
      Instance.node,
      ManagedPolicy.node,
      LocationServiceMap.node,
    ]),
    [
      LocationServiceMap.node.replace(locations),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Instance.node.replace(instances),
    ],
  ),
)

describe("Session.skill", () => {
  it.effect(
    "projects an allowed skill through real location services and executes it as a canonical prompt attachment",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const session = yield* sessions.create({ location })

        expect(yield* sessions.catalogue({ sessionID: session.id })).toEqual([
          Command.Info.make({ name: "effect", description: "Effect guidance" }),
        ])

        yield* sessions.command({ sessionID: session.id, command: "effect", text: "Apply this", delivery: "steer" })
        yield* SessionInbox.promote(database.db, bus, session.id, "steer")
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(messages).toEqual([
          expect.objectContaining({
            type: "user",
            text: "Apply this",
            skills: [
              {
                id: "effect",
                name: "Effect",
                text: Skill.toModelOutput(info, []),
              },
            ],
          }),
        ])
      }),
  )

  it.effect("attaches once-escaped model text while retaining raw prompt attachment metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const locations = yield* LocationServiceMap.Service
      const session = yield* sessions.create({ location })
      const unsafe = Skill.Info.make({
        ...info,
        name: Skill.Name.make("Effect&lt;&amp;<&>'\""),
        path: AbsolutePath.make("/skills/effect&lt;&amp;<&>'\".md"),
      })
      yield* Skill.Service.use((skills) =>
        skills.transform((editor) => {
          editor.update("effect", (skill) => Object.assign(skill, unsafe))
        }),
      ).pipe(Effect.provide(locations.get(session.location)))

      yield* sessions.prompt({
        sessionID: session.id,
        text: "Use @effect",
        skills: [{ id: unsafe.id, mention: { start: 4, end: 11, text: "@effect" } }],
        resume: false,
      })
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")

      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([
        expect.objectContaining({
          skills: [
            expect.objectContaining({
              id: "effect",
              name: "Effect&lt;&amp;<&>'\"",
              text: Skill.toModelOutput(unsafe, []),
            }),
          ],
        }),
      ])
    }),
  )

  it.effect("hides session-denied skills and gives denied and missing commands the identical not-found shape", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location })
      yield* sessions.setPermissions({
        sessionID: session.id,
        permissions: [{ action: "skill", resource: "effect", effect: "deny" }],
      })

      expect(yield* sessions.catalogue({ sessionID: session.id })).toEqual([])
      const denied = yield* sessions
        .command({ sessionID: session.id, command: "effect", text: "Apply" })
        .pipe(Effect.flip)
      const missing = yield* sessions
        .command({ sessionID: session.id, command: "missing", text: "Apply" })
        .pipe(Effect.flip)
      expect(denied).toMatchObject({ _tag: "Command.NotFoundError" })
      expect(missing).toMatchObject({ _tag: "Command.NotFoundError" })
    }),
  )

  it.effect("denies all projected skill access when the session agent is absent from its location", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location, agent: Agent.ID.make("missing") })

      expect(yield* sessions.catalogue({ sessionID: session.id })).toEqual([])
      const missing = yield* sessions
        .command({ sessionID: session.id, command: "effect", text: "Apply" })
        .pipe(Effect.flip)
      expect(missing).toMatchObject({
        _tag: "Command.NotFoundError",
        command: "effect",
        message: "Command not found: effect",
      })
      expect(
        yield* sessions.skill({ sessionID: session.id, skill: info.id, resume: false }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: info.id })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
      expect(yield* sessions.inbox(session.id)).toEqual([])
    }),
  )

  it.effect(
    "uses canonical permission merge precedence and lets an explicit command win an exact skill-ID collision",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const locations = yield* LocationServiceMap.Service
        yield* Agent.Service.use((agents) =>
          agents.transform((editor) => {
            editor.update(Agent.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "effect", effect: "deny" })
            })
          }),
        ).pipe(Effect.provide(locations.get(location)))
        const session = yield* sessions.create({ location, agent: Agent.ID.make("reviewer") })
        const calls: Command.Invocation[] = []
        yield* Command.Service.use((command) =>
          command.transform((editor) => {
            editor.add({
              name: "effect",
              description: "Explicit effect",
              execute: (input) => Effect.sync(() => calls.push(input)),
            })
          }),
        ).pipe(Effect.provide(locations.get(session.location)))

        yield* sessions.setPermissions({
          sessionID: session.id,
          permissions: [{ action: "skill", resource: "effect", effect: "allow" }],
        })
        expect(
          Permission.evaluate(
            "skill",
            "effect",
            Permission.merge([{ action: "skill", resource: "effect", effect: "deny" }], session.permissions ?? []),
          ).effect,
        ).toBe("deny")
        expect(yield* sessions.catalogue({ sessionID: session.id })).toEqual([
          Command.Info.make({ name: "effect", description: "Explicit effect" }),
        ])

        yield* sessions.command({ sessionID: session.id, command: "effect", text: "Explicit wins" })
        expect(calls).toEqual([expect.objectContaining({ sessionID: session.id, prompt: { text: "Explicit wins" } })])

        yield* sessions.setPermissions({
          sessionID: session.id,
          permissions: [{ action: "skill", resource: "effect", effect: "deny" }],
        })
        expect(yield* sessions.catalogue({ sessionID: session.id })).toEqual([
          Command.Info.make({ name: "effect", description: "Explicit effect" }),
        ])
      }),
  )

  it.effect("refuses blocked skill mentions and standalone activation without writing their content", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const managed = yield* ManagedPolicy.Service
      const session = yield* sessions.create({ location })
      yield* managed.set({ statements: [{ action: "integration.use", resource: "skill:effect", effect: "deny" }] })
      expect(
        yield* sessions.skill({ sessionID: session.id, skill: info.id, resume: false }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: info.id })
      expect(
        yield* sessions
          .prompt({
            sessionID: session.id,
            text: "@effect",
            skills: [{ id: info.id, mention: { start: 0, end: 7, text: "@effect" } }],
            resume: false,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: info.id })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
      expect(yield* sessions.inbox(session.id)).toEqual([])
    }),
  )

  it.effect(
    "rejects a direct prompt mention when the session denies an agent-allowed skill before admission or activation",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const bus = yield* Bus.Service
        const session = yield* sessions.create({ location })
        const events: Event.Payload[] = []
        yield* sessions.setPermissions({
          sessionID: session.id,
          permissions: [{ action: "skill", resource: "effect", effect: "deny" }],
        })
        const locations = yield* LocationServiceMap.Service
        yield* Skill.Service.use((skills) => skills.list()).pipe(Effect.provide(locations.get(session.location)))
        yield* bus.listen((event) =>
          Effect.sync(() => {
            events.push(event)
          }),
        )

        expect(
          yield* sessions
            .prompt({
              sessionID: session.id,
              text: "Use @effect",
              skills: [{ id: info.id, mention: { start: 4, end: 11, text: "@effect" } }],
              resume: false,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: info.id })
        expect(events).toEqual([])
        expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
        expect(yield* sessions.inbox(session.id)).toEqual([])
      }),
  )

  it.effect("keeps the first skill admission when a pending or delivered retry follows removal or denial", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const locations = yield* LocationServiceMap.Service

      yield* Effect.forEach([false, true], (delivered) =>
        Effect.gen(function* () {
          const session = yield* sessions.create({ location })
          yield* Skill.Service.use((skills) => skills.transform((editor) => editor.add(info))).pipe(
            Effect.provide(locations.get(session.location)),
          )
          const id = SessionMessage.ID.create()
          const first = yield* sessions.prompt({
            id,
            sessionID: session.id,
            text: "Use @effect",
            skills: [{ id: info.id, mention: { start: 4, end: 11, text: "@effect" } }],
            resume: false,
          })
          if (delivered) {
            const database = yield* Database.Service
            const bus = yield* Bus.Service
            yield* SessionInbox.promote(database.db, bus, session.id, "steer")
          }
          yield* Skill.Service.use((skills) =>
            skills.transform((editor) => {
              editor.remove(info.id)
            }),
          ).pipe(Effect.provide(locations.get(session.location)))
          yield* sessions.setPermissions({
            sessionID: session.id,
            permissions: [{ action: "skill", resource: info.id, effect: "deny" }],
          })

          expect(
            yield* sessions.prompt({
              id,
              sessionID: session.id,
              text: "Ignored retry after removal",
              skills: [{ id: info.id, mention: { start: 0, end: 7, text: "@effect" } }],
              resume: false,
            }),
          ).toEqual(first)
        }),
      )
    }),
  )

  it.effect("derives exactly one lazy snapshot after a hook injects an attachment into a skill-free prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const locations = yield* LocationServiceMap.Service
      const session = yield* sessions.create({ location })
      yield* Skill.Service.use((skills) =>
        skills.transform((editor) => {
          editor.add(info)
        }),
      ).pipe(Effect.provide(locations.get(session.location)))
      const hook = yield* PluginHooks.Service.use((hooks) =>
        hooks.register("session", "prompt", (event) =>
          Effect.sync(() => {
            event.prompt.skills = [{ id: info.id }]
          }),
        ),
      ).pipe(Effect.provide(locations.get(session.location)))
      const admitted = yield* sessions.prompt({ sessionID: session.id, text: "No skill was requested", resume: false })
      expect(admitted.payload.skills).toEqual([expect.objectContaining({ id: info.id })])
      yield* hook.dispose
    }),
  )

  it.effect("materializes mentioned skills on their owning prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const fs = yield* FSUtil.Service
      const locations = yield* LocationServiceMap.Service
      const session = yield* sessions.create({ location })
      const id = SessionMessage.ID.make("msg_skill_attachment")
      const locationServices = locations.get(session.location)

      const plugin = yield* Plugin.Service.pipe(Effect.provide(locationServices))
      expect(plugin).toBeDefined()

      const selected = yield* Agent.Service.use((agents) => agents.select(session.agent)).pipe(
        Effect.provide(locationServices),
      )
      expect(selected.info).toBeDefined()
      if (!selected.info) return

      const available = yield* Skill.Service.use((skills) => skills.list()).pipe(Effect.provide(locationServices))
      expect(available.some((skill) => skill.id === info.id)).toBe(true)
      expect(
        Permission.evaluate("skill", info.id, Permission.merge(selected.info.permissions, session.permissions ?? []))
          .effect,
      ).not.toBe("deny")

      const snapshot = yield* SessionSkill.snapshot({ session }).pipe(Effect.provide(locationServices))
      expect(snapshot.skills.has(info.id)).toBe(true)
      const prepared = yield* SessionPrompt.prepare({
        session,
        messageID: SessionMessage.ID.make("msg_skill_prepare"),
        input: {
          text: "Apply @effect",
          skills: [{ id: info.id, mention: { start: 6, end: 13, text: "@effect" } }],
        },
        skillSnapshot: snapshot,
      }).pipe(Effect.provideService(FSUtil.Service, fs), Effect.provide(locationServices))
      expect(prepared).toMatchObject({
        payload: { skills: [expect.objectContaining({ id: "effect", name: "Effect" })] },
      })

      yield* sessions.prompt({
        id,
        sessionID: session.id,
        text: "Apply @effect and @effect",
        skills: [
          { id: Skill.ID.make("effect"), mention: { start: 6, end: 13, text: "@effect" } },
          { id: Skill.ID.make("effect"), mention: { start: 18, end: 25, text: "@effect" } },
        ],
        resume: false,
      })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")

      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([
        expect.objectContaining({
          id,
          type: "user",
          text: "Apply @effect and @effect",
          skills: [
            {
              id: "effect",
              name: "Effect",
              text: Skill.toModelOutput(info, []),
              mention: { start: 6, end: 13, text: "@effect" },
            },
            {
              id: "effect",
              name: "Effect",
              mention: { start: 18, end: 25, text: "@effect" },
            },
          ],
        }),
      ])
    }),
  )

  it.effect("excludes mentioned skills when forking before their prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location })
      const initial = SessionMessage.ID.make("msg_before_skill_attachment")
      const selected = SessionMessage.ID.make("msg_fork_skill_attachment")

      yield* sessions.prompt({ id: initial, sessionID: session.id, text: "Before the skill", resume: false })
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")
      yield* sessions.prompt({
        id: selected,
        sessionID: session.id,
        text: "Apply @effect",
        skills: [{ id: info.id, mention: { start: 6, end: 13, text: "@effect" } }],
        resume: false,
      })
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")
      const forked = yield* sessions.fork({ sessionID: session.id, before: selected })

      expect(yield* sessions.messages({ sessionID: forked.id })).toEqual([
        expect.objectContaining({ type: "user", text: "Before the skill" }),
      ])
    }),
  )

  it.effect("publishes raw standalone content under the caller-supplied ID without inbox admission", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location })
      const id = SessionMessage.ID.make("msg_caller_skill")
      const locations = yield* LocationServiceMap.Service
      yield* Skill.Service.use((skills) => skills.list()).pipe(Effect.provide(locations.get(session.location)))
      const events: Event.Payload[] = []
      yield* bus.listen((event) =>
        Effect.sync(() => {
          events.push(event)
        }),
      )

      yield* sessions.skill({ messageID: id, sessionID: session.id, skill: Skill.ID.make("effect"), resume: false })

      expect(events).toEqual([
        expect.objectContaining({
          id: "evt_caller_skill",
          type: SessionEvent.Skill.Activated.type,
          data: { sessionID: session.id, id: info.id, name: info.name, text: info.content },
        }),
      ])
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([
        expect.objectContaining({ id, type: "skill", skill: "effect", name: "Effect", text: info.content }),
      ])
      expect(yield* sessions.inbox(session.id)).toEqual([])
    }),
  )
})
