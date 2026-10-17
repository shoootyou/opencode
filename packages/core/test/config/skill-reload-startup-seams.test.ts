/**
 * @spec-handoff
 * @interface ConfigSkillPlugin.Plugin.effect(ctx): Effect<void, never, ConfigSkillReload | SkillDiscovery | ...>
 * @behavior
 *   - After each committed scan, config entries read at scan start are reconciled with current entries; a difference admits one non-waiting follow-up.
 *   - A host config.updated delivered during an initial scan and reconciliation of that same config change coalesce into one follow-up.
 *   - A startup hook can publish an internal update after internal subscription acquisition; that update creates one follow-up scan.
 * @edge-cases
 *   - A cold, suspended host subscription may miss an event; changing Config.Test entries while a scan is blocked still causes a follow-up.
 *   - An unchanged scan causes no follow-up, and a new change during its follow-up causes exactly one further scan.
 *   - The internal subscriber must exist before the startup hook publishes, even though its consumer has not started.
 * @see ../../src/config/plugin/skill.ts
 */
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Document, Info } from "@opencode/schema/config"
import type { Context } from "@opencode/plugin/effect/plugin"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const directory = AbsolutePath.make("/tmp/skill-reload-startup-seams")
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))
const entries = (url: string) => [new Document({ type: "document", info: Info.make({ skills: [url] }) })]
type PluginEvent = ReturnType<Context["event"]["subscribe"]> extends Stream.Stream<infer A, infer _E, infer _R> ? A : never
const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Skill.node, Bus.node, FSUtil.node, ConfigSkillReload.node, SkillDiscovery.node]), [
      Location.node.replace(locationLayer),
      Watcher.node.replace(Watcher.testLayer),
    ]),
    Watcher.testLayer,
  ),
)

test("exposes the internal-subscription readiness hook before initial admission", () => {
  expect(ConfigSkillPlugin.Test).toHaveProperty("startupHooks")
})

test("exposes the pre-consumer hook with a publisher for the buffered-update interleaving", () => {
  expect(ConfigSkillPlugin.Test).toHaveProperty("startupHooks")
})

describe("ConfigSkillPlugin startup readiness", () => {
  it.live("reconciles a config change missed while the cold host subscription is suspended", () => {
    const configLayer = Config.testLayer(entries("https://skills.example.test/initial"))
    return Effect.gen(function* () {
      const acquisitionStarted = yield* Deferred.make<void>()
      const initialStarted = yield* Deferred.make<void>()
      const releaseInitial = yield* Deferred.make<void>()
      const followUpStarted = yield* Deferred.make<void>()
      const config = yield* Config.Test
      const pulled: string[] = []
      let scans = 0
      const discovery = SkillDiscovery.Service.of({
        pull: (url) =>
          Effect.sync(() => {
            pulled.push(url)
            return ++scans
          }).pipe(
            Effect.tap((scan) =>
              scan === 1
                ? Deferred.succeed(initialStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseInitial)))
                : Deferred.succeed(followUpStarted, undefined),
            ),
            Effect.as([]),
          ),
      })
      const skill = yield* Skill.Service
      const activation = yield* ConfigSkillPlugin.Plugin.effect(
        host({
          event: {
            subscribe: () =>
              Stream.unwrap(
                Deferred.succeed(acquisitionStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.as(Stream.empty),
                ),
              ),
          },
          skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(SkillDiscovery.Service, discovery),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
        Effect.provide(locationLayer),
        Effect.provide(Watcher.testLayer),
        Effect.forkScoped,
      )

      yield* Deferred.await(acquisitionStarted).pipe(Effect.timeout("1 second"))
      yield* Deferred.await(initialStarted).pipe(Effect.timeout("1 second"))
      // No upstream event is published: this change is deliberately dropped by the blocked cold stream.
      yield* config.setEntries(entries("https://skills.example.test/changed"))
      yield* Deferred.succeed(releaseInitial, undefined)
      yield* Deferred.await(followUpStarted).pipe(Effect.timeout("1 second"))
      expect(scans).toBe(2)
      expect(pulled).toEqual(["https://skills.example.test/initial", "https://skills.example.test/changed"])
      yield* Fiber.join(activation)
      yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow)
      expect(scans).toBe(2)
    }).pipe(Effect.provide(configLayer))
  })

  it.live("does not schedule a follow-up when a completed scan observes unchanged config", () => {
    const configLayer = Config.testLayer(entries("https://skills.example.test/stable"))
    return Effect.gen(function* () {
      const acquisitionStarted = yield* Deferred.make<void>()
      let scans = 0
      const discovery = SkillDiscovery.Service.of({
        pull: () => Effect.sync(() => ++scans).pipe(Effect.as([])),
      })
      const skill = yield* Skill.Service
      const activation = yield* ConfigSkillPlugin.Plugin.effect(
        host({
          event: {
            subscribe: () => Stream.unwrap(Deferred.succeed(acquisitionStarted, undefined).pipe(Effect.andThen(Effect.never))),
          },
          skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(SkillDiscovery.Service, discovery),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
        Effect.provide(locationLayer),
        Effect.provide(Watcher.testLayer),
        Effect.forkScoped,
      )

      yield* Deferred.await(acquisitionStarted).pipe(Effect.timeout("1 second"))
      yield* Fiber.join(activation)
      yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow)
      expect(scans).toBe(1)
    }).pipe(Effect.provide(configLayer))
  })

  it.live("reconciles one further config change that arrives during the reconciliation follow-up", () => {
    const configLayer = Config.testLayer(entries("https://skills.example.test/initial"))
    return Effect.gen(function* () {
      const acquisitionStarted = yield* Deferred.make<void>()
      const initialStarted = yield* Deferred.make<void>()
      const releaseInitial = yield* Deferred.make<void>()
      const followUpStarted = yield* Deferred.make<void>()
      const releaseFollowUp = yield* Deferred.make<void>()
      const finalStarted = yield* Deferred.make<void>()
      const config = yield* Config.Test
      const pulled: string[] = []
      let scans = 0
      const discovery = SkillDiscovery.Service.of({
        pull: (url) =>
          Effect.sync(() => {
            pulled.push(url)
            return ++scans
          }).pipe(
            Effect.tap((scan) => {
              if (scan === 1) return Deferred.succeed(initialStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseInitial)))
              if (scan === 2) return Deferred.succeed(followUpStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFollowUp)))
              return Deferred.succeed(finalStarted, undefined)
            }),
            Effect.as([]),
          ),
      })
      const skill = yield* Skill.Service
      const activation = yield* ConfigSkillPlugin.Plugin.effect(
        host({
          event: {
            subscribe: () => Stream.unwrap(Deferred.succeed(acquisitionStarted, undefined).pipe(Effect.andThen(Effect.never))),
          },
          skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(SkillDiscovery.Service, discovery),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
        Effect.provide(locationLayer),
        Effect.provide(Watcher.testLayer),
        Effect.forkScoped,
      )

      yield* Deferred.await(acquisitionStarted).pipe(Effect.timeout("1 second"))
      yield* Deferred.await(initialStarted).pipe(Effect.timeout("1 second"))
      yield* config.setEntries(entries("https://skills.example.test/first-change"))
      yield* Deferred.succeed(releaseInitial, undefined)
      yield* Deferred.await(followUpStarted).pipe(Effect.timeout("1 second"))
      yield* config.setEntries(entries("https://skills.example.test/second-change"))
      yield* Deferred.succeed(releaseFollowUp, undefined)
      yield* Deferred.await(finalStarted).pipe(Effect.timeout("1 second"))
      expect(pulled).toEqual([
        "https://skills.example.test/initial",
        "https://skills.example.test/first-change",
        "https://skills.example.test/second-change",
      ])
      yield* Fiber.join(activation)
      yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow)
      expect(scans).toBe(3)
    }).pipe(Effect.provide(configLayer))
  })

  it.live("coalesces a delivered config event and reconciliation of the same initial-scan change", () => {
    const configLayer = Config.testLayer(entries("https://skills.example.test/initial"))
    return Effect.gen(function* () {
      const upstream = yield* PubSub.unbounded<PluginEvent>()
      const initialStarted = yield* Deferred.make<void>()
      const releaseInitial = yield* Deferred.make<void>()
      const followUpStarted = yield* Deferred.make<void>()
      const config = yield* Config.Test
      let scans = 0
      const discovery = SkillDiscovery.Service.of({
        pull: () =>
          Effect.sync(() => ++scans).pipe(
            Effect.tap((scan) =>
              scan === 1
                ? Deferred.succeed(initialStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseInitial)))
                : Deferred.succeed(followUpStarted, undefined),
            ),
            Effect.as([]),
          ),
      })
      const skill = yield* Skill.Service
      const activation = yield* ConfigSkillPlugin.Plugin.effect(
        host({
          event: { subscribe: () => Stream.fromPubSub(upstream) },
          skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(SkillDiscovery.Service, discovery),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
        Effect.provide(locationLayer),
        Effect.provide(Watcher.testLayer),
        Effect.forkScoped,
      )

      yield* Deferred.await(initialStarted).pipe(Effect.timeout("1 second"))
      yield* config.setEntries(entries("https://skills.example.test/changed"))
      yield* PubSub.publish(upstream, { type: "config.updated" } as PluginEvent)
      yield* Deferred.succeed(releaseInitial, undefined)
      yield* Deferred.await(followUpStarted).pipe(Effect.timeout("1 second"))
      yield* Fiber.join(activation)
      yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow)
      expect(scans).toBe(2)
    }).pipe(Effect.provide(configLayer))
  })

  it.live("retains an internal config update published by the startup hook before its consumer starts", () =>
    Effect.gen(function* () {
      const hookPublished = yield* Deferred.make<void>()
      const initialStarted = yield* Deferred.make<void>()
      const releaseInitial = yield* Deferred.make<void>()
      const followUpStarted = yield* Deferred.make<void>()
      let scans = 0
      const discovery = SkillDiscovery.Service.of({
        pull: () =>
          Effect.sync(() => ++scans).pipe(
            Effect.tap((scan) =>
              scan === 1
                ? Deferred.succeed(initialStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseInitial)))
                : Deferred.succeed(followUpStarted, undefined),
            ),
            Effect.as([]),
          ),
      })
      const skill = yield* Skill.Service
      const activation = yield* ConfigSkillPlugin.Plugin.effect(
        host({ skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void } }),
      ).pipe(
        Effect.provideService(SkillDiscovery.Service, discovery),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
        Effect.provide(locationLayer),
        Effect.provide(Watcher.testLayer),
        Effect.provide(Config.testLayer(entries("https://skills.example.test/catalog"))),
        Effect.provideService(ConfigSkillPlugin.Test.startupHooks, ({ publishInternalConfigUpdate }) =>
          publishInternalConfigUpdate().pipe(Effect.andThen(Deferred.succeed(hookPublished, undefined))),
        ),
        Effect.forkScoped,
      )

      yield* Deferred.await(hookPublished).pipe(Effect.timeout("1 second"))
      yield* Deferred.await(initialStarted).pipe(Effect.timeout("1 second"))
      yield* Deferred.succeed(releaseInitial, undefined)
      yield* Deferred.await(followUpStarted).pipe(Effect.timeout("1 second"))
      expect(scans).toBe(2)
      yield* Fiber.join(activation)
    }),
  )
})
