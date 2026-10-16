/**
 * @spec-handoff
 * @interface ForkCapabilities.Service: { snapshot, get, catalogue, resolve, reload }
 * @behavior
 *   - Capability reads wait for location plugin activation before reading producer services.
 *   - Snapshots own immutable copies of producer skill records.
 *   - reload delegates to the captured ConfigSkillReload operation exactly once.
 * @edge-cases
 *   - Missing agents produce an empty snapshot and SkillNotFoundError.
 *   - Reads await activation; reload does not.
 * @see ../src/fork/capabilities.ts
 * @mutation-targets record copy; activation wait; reload capture
 */
import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { node as ForkCapabilitiesNode } from "@opencode/core/fork/capabilities"
import { ForkCapabilities } from "@opencode/core/fork/capabilities/service"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Plugin } from "@opencode/core/plugin"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Project } from "@opencode/schema/project"
import { Location } from "@opencode/schema/location"
import { testEffect } from "./lib/effect"

type Environment<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type CapabilityEnvironmentContracts = [
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["snapshot"]>>, never>>,
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["get"]>>, never>>,
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["catalogue"]>>, never>>,
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["resolve"]>>, never>>,
  Expect<Equal<Environment<ReturnType<ForkCapabilities.Interface["reload"]>>, never>>,
]
void (0 as unknown as CapabilityEnvironmentContracts)

const session = Session.Info.make({
  id: Session.ID.make("ses_fork_capabilities"),
  projectID: Project.ID.global,
  agent: Agent.ID.make("build"),
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/capabilities") }),
})

const producer = () =>
  Skill.Info.make({
    id: Skill.ID.make("guide"),
    name: Skill.Name.make("Guide"),
    description: "Original guidance",
    path: AbsolutePath.make("/skills/guide/SKILL.md"),
    content: "# Guide",
  })

const capabilityLayer = (input: {
  readonly activation: Effect.Effect<void>
  readonly skills: () => Effect.Effect<Skill.Info[]>
  readonly reload: () => Effect.Effect<{ readonly count: number }>
}) =>
  AppNodeBuilder.build(LayerNode.group([ForkCapabilitiesNode]), [
    Agent.node.replace(
      Layer.mock(Agent.Service, { select: () => Effect.succeed({ id: Agent.ID.make("build"), info: Agent.Info.default(Agent.ID.make("build")) }) }),
    ),
    Skill.node.replace(Layer.mock(Skill.Service, { list: input.skills })),
    Command.node.replace(Layer.mock(Command.Service, { list: () => Effect.succeed([]) })),
    Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: input.activation })),
    ConfigSkillReload.node.replace(Layer.mock(ConfigSkillReload.Service, { reload: input.reload })),
  ])

const it = testEffect(Layer.empty)

describe("ForkCapabilities", () => {
  it.effect("waits for plugin activation before reading skills", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      let skillReads = 0
      const layer = capabilityLayer({
        activation: Deferred.await(ready),
        skills: () => Effect.sync(() => {
          skillReads++
          return [producer()]
        }),
        reload: () => Effect.succeed({ count: 1 }),
      })
      const pending = yield* Effect.gen(function* () {
        const capabilities = yield* ForkCapabilities.Service
        return yield* capabilities.snapshot({ session })
      }).pipe(Effect.provide(layer), Effect.forkScoped)
      yield* Effect.yieldNow
      expect(skillReads).toBe(0)
      yield* Deferred.succeed(ready, undefined)
      yield* Effect.yieldNow
      expect((yield* Fiber.join(pending)).skills.get(Skill.ID.make("guide"))?.description).toBe("Original guidance")
    }),
  )

  it.effect("copies producer records so post-snapshot mutation cannot change the snapshot", () =>
    Effect.gen(function* () {
      const original = producer()
      const layer = capabilityLayer({ activation: Effect.void, skills: () => Effect.succeed([original]), reload: () => Effect.succeed({ count: 1 }) })
      const snapshot = yield* Effect.gen(function* () {
        const capabilities = yield* ForkCapabilities.Service
        return yield* capabilities.snapshot({ session })
      }).pipe(Effect.provide(layer))
      ;(original as { description?: string }).description = "Mutated producer record"
      expect(snapshot.skills.get(Skill.ID.make("guide"))?.description).toBe("Original guidance")
    }),
  )

  it.effect("delegates capability reload exactly once", () =>
    Effect.gen(function* () {
      let calls = 0
      const layer = capabilityLayer({
        activation: Effect.void,
        skills: () => Effect.succeed([producer()]),
        reload: () => Effect.sync(() => ({ count: ++calls })),
      })
      expect(
        yield* Effect.gen(function* () {
          return yield* (yield* ForkCapabilities.Service).reload()
        }).pipe(Effect.provide(layer)),
      ).toEqual({ count: 1 })
      expect(calls).toBe(1)
    }),
  )
})
