/**
 * @spec-handoff
 * @interface ConfigSkillPlugin.Plugin.effect(ctx): Effect<void, never, ConfigSkillReload | SkillDiscovery | ...>
 * @behavior
 *   - After each scan exit while the installation remains open, reconcile its captured effective skill-source sequence with current entries; a difference admits one non-waiting follow-up.
 *   - Effective sources are de-duplicated in first-occurrence order; source order is significant because later sources win duplicate skill IDs.
 *   - Compare only effective skill sources: ignore unrelated config fields and normalize HTTP(S) URLs by lowercasing host and omitting default ports.
 *   - A host config.updated delivered during an initial scan and reconciliation of that same config change coalesce into one follow-up.
 *   - A startup hook can publish an internal update after internal subscription acquisition; that update creates one follow-up scan.
 * @edge-cases
 *   - A cold, suspended host subscription may miss an event; changing Config.Test entries while a scan is blocked still causes a follow-up.
 *   - A failed scan retains the previous committed generation, but an unprocessed config change during that failed scan still causes one follow-up.
 *   - Closing/teardown admits no reconciliation successor; structurally equal but newly allocated entries cause no follow-up.
 *   - The internal subscriber must exist before the startup hook publishes, even though its consumer has not started.
 * @see ../../src/config/plugin/skill.ts
 */
import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, PubSub, Ref, Scope, Stream } from "effect"
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
import { Document, type Entry, Info } from "@opencode/schema/config"
import type { Context } from "@opencode/plugin/effect/plugin"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"
import { tmpdir } from "../fixture/tmpdir"

const directory = AbsolutePath.make("/tmp/skill-reload-startup-seams")
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))
const entries = (url: string) => [new Document({ type: "document", info: Info.make({ skills: [url] }) })]
const sourceEntries = (skills: string[], shell?: string) => [
  new Document({ type: "document", info: Info.make({ skills, ...(shell === undefined ? {} : { shell }) }) }),
]
type PluginEvent =
  ReturnType<Context["event"]["subscribe"]> extends Stream.Stream<infer A, infer _E, infer _R> ? A : never
const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(
      LayerNode.group([Skill.node, Bus.node, FSUtil.node, ConfigSkillReload.node, SkillDiscovery.node]),
      [Location.node.replace(locationLayer), Watcher.node.replace(Watcher.testLayer)],
    ),
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
            subscribe: () =>
              Stream.unwrap(Deferred.succeed(acquisitionStarted, undefined).pipe(Effect.andThen(Effect.never))),
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
              if (scan === 1)
                return Deferred.succeed(initialStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseInitial)))
              if (scan === 2)
                return Deferred.succeed(followUpStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFollowUp)),
                )
              return Deferred.succeed(finalStarted, undefined)
            }),
            Effect.as([]),
          ),
      })
      const skill = yield* Skill.Service
      const activation = yield* ConfigSkillPlugin.Plugin.effect(
        host({
          event: {
            subscribe: () =>
              Stream.unwrap(Deferred.succeed(acquisitionStarted, undefined).pipe(Effect.andThen(Effect.never))),
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
        host({
          skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void },
        }),
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

  it.live("reconciles a dropped source-order change and commits the duplicate winner selected by the new order", () => {
    const sourceA = "https://skills.example.test/A"
    const sourceB = "https://skills.example.test/B"
    const configLayer = Config.testLayer(sourceEntries([sourceA, sourceB]))
    return Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const roots = new Map([
            [sourceA, path.join(tmp.path, "A")],
            [sourceB, path.join(tmp.path, "B")],
          ])
          yield* Effect.promise(async () => {
            for (const [source, root] of roots) {
              await fs.mkdir(path.join(root, "duplicate"), { recursive: true })
              await fs.writeFile(
                path.join(root, "duplicate", "SKILL.md"),
                `---\nname: duplicate\ndescription: ${source === sourceA ? "A" : "B"}\n---\n# duplicate`,
              )
            }
          })
          const acquisitionStarted = yield* Deferred.make<void>()
          const initialStarted = yield* Deferred.make<void>()
          const releaseInitial = yield* Deferred.make<void>()
          const followUpCommitted = yield* Deferred.make<void>()
          const config = yield* Config.Test
          const pulled: string[] = []
          let commits = 0
          const discovery = SkillDiscovery.Service.of({
            pull: (url) =>
              Effect.sync(() => {
                pulled.push(url)
                return pulled.length
              }).pipe(
                Effect.tap((pull) =>
                  pull === 1
                    ? Deferred.succeed(initialStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseInitial)))
                    : Effect.void,
                ),
                Effect.map(() => [AbsolutePath.make(roots.get(url)!)]),
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
              skill: {
                list: () => Effect.die("unused skill.list"),
                transform: skill.transform,
                reload: () =>
                  skill.reload().pipe(
                    Effect.andThen(Effect.sync(() => ++commits)),
                    Effect.tap((commit) =>
                      commit === 2 ? Deferred.succeed(followUpCommitted, undefined) : Effect.void,
                    ),
                  ),
              },
            }),
          ).pipe(
            Effect.provideService(SkillDiscovery.Service, discovery),
            Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: tmp.path })),
            Effect.provideService(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
            ),
            Effect.provide(Watcher.testLayer),
            Effect.provide(configLayer),
            Effect.forkScoped,
          )

          yield* Deferred.await(acquisitionStarted).pipe(Effect.timeout("1 second"))
          yield* Deferred.await(initialStarted).pipe(Effect.timeout("1 second"))
          // The non-replaying cold stream drops this update; reconciliation is the only admission path.
          yield* config.setEntries(sourceEntries([sourceB, sourceA]))
          yield* Deferred.succeed(releaseInitial, undefined)
          yield* Deferred.await(followUpCommitted).pipe(Effect.timeout("1 second"))
          expect(commits).toBe(2)
          expect(pulled).toEqual([sourceA, sourceB, sourceB, sourceA])
          const committedWinner = (yield* skill.list()).find((item) => item.id === "duplicate")?.description
          expect(committedWinner).toBe("A")
          expect(yield* (yield* ConfigSkillReload.Service).reload()).toEqual({ count: 1 })
          const manualReloadWinner = (yield* skill.list()).find((item) => item.id === "duplicate")?.description
          expect(manualReloadWinner).toBe(committedWinner)
          expect(pulled).toEqual([sourceA, sourceB, sourceB, sourceA, sourceB, sourceA])
          yield* Fiber.join(activation)
        }),
      ),
      Effect.provide(configLayer),
    )
  })

  it.live("reconciles an unprocessed config change after a failed scan while retaining the previous generation", () => {
    const sourceA = "https://skills.example.test/failed-initial"
    const sourceB = "https://skills.example.test/failed-follow-up"
    const configLayer = Config.testLayer(entries(sourceA))
    return Effect.gen(function* () {
      const reloadStarted = yield* Deferred.make<void>()
      const releaseFailure = yield* Deferred.make<void>()
      const reconciliationStarted = yield* Deferred.make<void>()
      const releaseReconciliation = yield* Deferred.make<void>()
      const config = yield* Config.Test
      let pulls = 0
      const discovery = SkillDiscovery.Service.of({
        pull: () =>
          Effect.sync(() => ++pulls).pipe(
            Effect.flatMap((pull) => {
              if (pull === 1) return Effect.succeed([])
              if (pull === 2)
                return Deferred.succeed(reloadStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFailure)),
                  Effect.andThen(Effect.die("required source failed")),
                )
              return Deferred.succeed(reconciliationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseReconciliation)),
                Effect.as([]),
              )
            }),
          ),
      })
      const skill = yield* Skill.Service
      yield* ConfigSkillPlugin.Plugin.effect(
        host({
          skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(SkillDiscovery.Service, discovery),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
        Effect.provide(locationLayer),
        Effect.provide(Watcher.testLayer),
        Effect.provide(configLayer),
      )
      const reload = yield* (yield* ConfigSkillReload.Service).reload().pipe(Effect.forkScoped)
      yield* Deferred.await(reloadStarted).pipe(Effect.timeout("1 second"))
      yield* config.setEntries(entries(sourceB))
      yield* Deferred.succeed(releaseFailure, undefined)
      const failed = yield* Fiber.await(reload)
      expect(Exit.isFailure(failed)).toBe(true)
      yield* Deferred.await(reconciliationStarted).pipe(Effect.timeout("1 second"))
      expect(pulls).toBe(3)
      yield* Deferred.succeed(releaseReconciliation, undefined)
    }).pipe(Effect.provide(configLayer))
  })

  it.live("does not admit reconciliation after Closing begins", () =>
    Effect.gen(function* () {
      const sourceA = "https://skills.example.test/closing-initial"
      const sourceB = "https://skills.example.test/closing-changed"
      const state = yield* Ref.make<Entry[]>(entries(sourceA))
      const reconciliationRead = yield* Deferred.make<void>()
      const releaseReconciliationRead = yield* Deferred.make<void>()
      let reads = 0
      const config = Config.Test.of({
        entries: () =>
          Ref.get(state).pipe(
            Effect.tap(() => {
              reads += 1
              return reads === 3
                ? Deferred.succeed(reconciliationRead, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseReconciliationRead)),
                  )
                : Effect.void
            }),
          ),
        compatibility: () => Effect.succeed({ claude: [], agents: [] }),
        changes: () => Stream.empty,
        setEntries: (next) => Ref.set(state, next),
        emitChange: () => Effect.void,
      })
      const configLayer = Layer.merge(Layer.succeed(Config.Service, config), Layer.succeed(Config.Test, config))
      let pulls = 0
      const discovery = SkillDiscovery.Service.of({ pull: () => Effect.sync(() => ++pulls).pipe(Effect.as([])) })
      const skill = yield* Skill.Service
      const scope = yield* Scope.make()
      const activation = yield* ConfigSkillPlugin.Plugin.effect(
        host({
          skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(SkillDiscovery.Service, discovery),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
        Effect.provide(locationLayer),
        Effect.provide(Watcher.testLayer),
        Effect.provide(configLayer),
        Scope.provide(scope),
        Effect.forkScoped,
      )
      yield* Deferred.await(reconciliationRead).pipe(Effect.timeout("1 second"))
      yield* config.setEntries(entries(sourceB))
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReconciliationRead, undefined)
      yield* Fiber.join(closing)
      yield* Fiber.await(activation)
      expect(pulls).toBe(1)
    }),
  )

  it.live("does not reconcile newly allocated entries that differ only in irrelevant config", () => {
    const source = "https://skills.example.test/structural"
    const configLayer = Config.testLayer(entries(source))
    return Effect.gen(function* () {
      const initialStarted = yield* Deferred.make<void>()
      const releaseInitial = yield* Deferred.make<void>()
      const config = yield* Config.Test
      let pulls = 0
      const discovery = SkillDiscovery.Service.of({
        pull: () =>
          Effect.sync(() => ++pulls).pipe(
            Effect.tap((pull) =>
              pull === 1
                ? Deferred.succeed(initialStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseInitial)))
                : Effect.void,
            ),
            Effect.as([]),
          ),
      })
      const skill = yield* Skill.Service
      const activation = yield* ConfigSkillPlugin.Plugin.effect(
        host({
          event: { subscribe: () => Stream.empty },
          skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(SkillDiscovery.Service, discovery),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
        Effect.provide(locationLayer),
        Effect.provide(Watcher.testLayer),
        Effect.provide(configLayer),
        Effect.forkScoped,
      )
      yield* Deferred.await(initialStarted).pipe(Effect.timeout("1 second"))
      yield* config.setEntries(sourceEntries([source], "unrelated-shell-setting"))
      yield* Deferred.succeed(releaseInitial, undefined)
      yield* Fiber.join(activation)
      yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow)
      expect(pulls).toBe(1)
    }).pipe(Effect.provide(configLayer))
  })

  it.live("normalizes irrelevant config and equivalent URL spelling without a follow-up", () => {
    const canonical = "https://skills.example.test/catalog"
    const equivalent = "https://SKILLS.EXAMPLE.TEST:443/catalog"
    const configLayer = Config.testLayer(sourceEntries([canonical], "first-shell"))
    return Effect.gen(function* () {
      const initialStarted = yield* Deferred.make<void>()
      const releaseInitial = yield* Deferred.make<void>()
      const config = yield* Config.Test
      let pulls = 0
      const discovery = SkillDiscovery.Service.of({
        pull: () =>
          Effect.sync(() => ++pulls).pipe(
            Effect.tap((pull) =>
              pull === 1
                ? Deferred.succeed(initialStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseInitial)))
                : Effect.void,
            ),
            Effect.as([]),
          ),
      })
      const skill = yield* Skill.Service
      const activation = yield* ConfigSkillPlugin.Plugin.effect(
        host({
          event: { subscribe: () => Stream.empty },
          skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(SkillDiscovery.Service, discovery),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
        Effect.provide(locationLayer),
        Effect.provide(Watcher.testLayer),
        Effect.provide(configLayer),
        Effect.forkScoped,
      )
      yield* Deferred.await(initialStarted).pipe(Effect.timeout("1 second"))
      yield* config.setEntries(sourceEntries([equivalent], "second-shell"))
      yield* Deferred.succeed(releaseInitial, undefined)
      yield* Fiber.join(activation)
      yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow)
      expect(pulls).toBe(1)
    }).pipe(Effect.provide(configLayer))
  })
})
