/**
 * @spec-handoff
 * @interface ConfigSkillReload.reload(): Effect<{ count: number }, ReloadUnavailable | ReloadFailed | ReloadTeardown>
 * @behavior
 *   - All public and background skill-reload entry points share one serialized generation gate.
 *   - Requests admitted while a scan runs resolve from its one follow-up generation.
 *   - A burst during that follow-up schedules exactly one further scan.
 *   - A required-source failure preserves the committed catalogue and reports ReloadFailed.
 * @edge-cases
 *   - Watcher and config events admit work without waiting for the active scan.
 * @see ../../src/config/plugin/skill.ts
 */
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, PubSub, Schema, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { ForkCapabilities } from "@opencode/core/fork/capabilities/service"
import { ReloadCommand } from "@opencode/core/fork/plugin/reload-command"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { SkillTool } from "@opencode/core/tool/plugin/skill"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Document, Info } from "@opencode/schema/config"
import { Session } from "@opencode/schema/session"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { host } from "../plugin/host"

const decode = Schema.decodeUnknownSync(Info)
type PluginEvent = ReturnType<Context["event"]["subscribe"]> extends Stream.Stream<infer A, infer _E, infer _R> ? A : never
const directory = AbsolutePath.make("/tmp/skill-reload-burst")
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))
const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Skill.node, Bus.node, FSUtil.node, Command.node, ConfigSkillReload.node, SkillDiscovery.node]), [
      Location.node.replace(locationLayer),
      Watcher.node.replace(Watcher.testLayer),
    ]),
    Watcher.testLayer,
  ),
)

function write(directory: string, description: string) {
  return fs.mkdir(path.join(directory, "remote"), { recursive: true }).then(() =>
    fs.writeFile(path.join(directory, "remote", "SKILL.md"), `---\nname: remote\ndescription: ${description}\n---\n# remote`),
  )
}

const capabilities = (reload: ConfigSkillReload.Interface["reload"]) =>
  ForkCapabilities.Service.of({
    snapshot: () => Effect.die("unused snapshot"),
    get: () => Effect.die("unused get"),
    catalogue: () => Effect.die("unused catalogue"),
    resolve: () => Effect.die("unused resolve"),
    reload,
  })

describe("ConfigSkillPlugin reload burst", () => {
  it.live("funnels public, command, tool, watcher, and config bursts through one follow-up generation", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
           const started = [yield* Deferred.make<void>(), yield* Deferred.make<void>(), yield* Deferred.make<void>()]
           const release = [yield* Deferred.make<void>(), yield* Deferred.make<void>(), yield* Deferred.make<void>()]
           const events = yield* PubSub.unbounded<PluginEvent>()
           const secondConfigEventConsumed = yield* Deferred.make<void>()
           let configEventsConsumed = 0
          let scans = 0
          let active = 0
          let maxActive = 0
          yield* Effect.promise(async () => {
            await write(tmp.path, "initial")
            await fs.mkdir(path.join(tmp.path, "remote-next", "one"), { recursive: true })
            await fs.mkdir(path.join(tmp.path, "remote-next", "two"), { recursive: true })
            await fs.writeFile(path.join(tmp.path, "remote-next", "one", "SKILL.md"), "# one")
            await fs.writeFile(path.join(tmp.path, "remote-next", "two", "SKILL.md"), "# two")
          })
          const discovery = SkillDiscovery.Service.of({
            pull: () =>
              Effect.sync(() => {
                scans += 1
                active += 1
                maxActive = Math.max(maxActive, active)
                return scans
              }).pipe(
                Effect.tap((scan) => (scan === 1 ? Effect.void : Deferred.succeed(started[scan - 2]!, undefined))),
                Effect.flatMap((scan) =>
                  (scan === 1 ? Effect.void : Deferred.await(release[scan - 2]!)).pipe(Effect.as(scan)),
                ),
                Effect.ensuring(Effect.sync(() => active--)),
                Effect.map((scan) => [AbsolutePath.make(path.join(tmp.path, scan >= 3 ? "remote-next" : "remote"))]),
              ),
          })
          const entries = [new Document({ type: "document", info: decode({ skills: ["https://skills.example.test/catalog"] }) })]
          const skill = yield* ConfigSkillPlugin.Plugin.effect(
            host({
              event: {
                subscribe: () =>
                  Stream.fromPubSub(events).pipe(
                    Stream.tap(() =>
                      Effect.sync(() => ++configEventsConsumed).pipe(
                        Effect.flatMap((count) =>
                          count === 2 ? Deferred.succeed(secondConfigEventConsumed, undefined).pipe(Effect.asVoid) : Effect.void,
                        ),
                      ),
                    ),
                  ),
              },
              skill: {
                list: () => Effect.die("unused skill.list"),
                transform: (yield* Skill.Service).transform,
                reload: (yield* Skill.Service).reload,
              },
            }),
          ).pipe(
            Effect.provideService(SkillDiscovery.Service, discovery),
            Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: tmp.path })),
            Effect.provide(locationLayer),
            Effect.provide(Watcher.testLayer),
            Effect.provide(Config.testLayer(entries)),
          )
          void skill
          const reload = yield* ConfigSkillReload.Service
          const publicWaiter = yield* reload.reload().pipe(Effect.forkScoped)
          yield* Deferred.await(started[0]).pipe(Effect.timeout("1 second"))

          const command = yield* Command.Service
          const commandResults: string[] = []
          yield* ReloadCommand.Plugin.effect(
            host({
              command: {
                list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
                transform: command.transform,
                reload: command.reload,
              },
              session: {
                synthetic: (input) =>
                  Effect.sync(() => {
                    commandResults.push(input.text)
                  }) as never,
              },
            }),
          ).pipe(Effect.provideService(ForkCapabilities.Service, capabilities(reload.reload)))
          let toolReload: (() => Effect.Effect<unknown, unknown>) | undefined
          yield* SkillTool.Plugin.effect(
            host({
              tool: {
                transform: (callback) =>
                  Effect.sync(() => {
                    callback({
                      add: (definition) => {
                        if (definition.name === "reload_skills") {
                          const execute = definition.execute as (input: {}, context: {}) => Effect.Effect<unknown, unknown>
                          toolReload = () => execute({}, {})
                        }
                      },
                    } as ToolEditor)
                    return { dispose: Effect.void }
                  }),
                reload: () => Effect.die("unused tool.reload"),
                list: () => Effect.die("unused tool.list"),
                hook: () => Effect.die("unused tool.hook"),
              },
            }),
          ).pipe(Effect.provide(permissionLayer()))

          const commandWaiter = yield* command.execute({ name: "reload", invocation: { sessionID: Session.ID.make("ses_burst"), prompt: { text: "" }, delivery: "steer" } }).pipe(Effect.forkScoped)
          const toolWaiter = yield* toolReload!().pipe(Effect.forkScoped)
          const watcher = yield* Watcher.Test
           const watcherEvent = yield* watcher.emit({ type: "update", path: path.join(tmp.path, "remote", "SKILL.md") }).pipe(Effect.forkScoped)
           const configEvent = yield* PubSub.publish(events, { type: "config.updated" } as PluginEvent).pipe(Effect.forkScoped)
          // A direct refresh bypass would start scan 2 before G is released, making maxActive 2;
          // waiting here would leave either event fiber unresolved while G is blocked.
            expect(Exit.isSuccess(yield* Fiber.join(watcherEvent).pipe(Effect.timeout("100 millis"), Effect.exit))).toBe(true)
            expect(Exit.isSuccess(yield* Fiber.join(configEvent).pipe(Effect.timeout("100 millis"), Effect.exit))).toBe(true)
           const secondConfigEvent = yield* PubSub.publish(events, { type: "config.updated" } as PluginEvent).pipe(Effect.forkScoped)
           yield* Deferred.await(secondConfigEventConsumed).pipe(Effect.timeout("1 second"))
           expect(Exit.isSuccess(yield* Fiber.join(secondConfigEvent).pipe(Effect.timeout("100 millis"), Effect.exit))).toBe(true)
           // After the debounce boundary, a watcher must still admit through the gate: a direct
           // refresh would begin scan 3 and resolve this handshake before the blocked G is released.
           expect(
             Exit.isFailure(yield* Deferred.await(started[1]).pipe(Effect.timeout("150 millis"), Effect.exit)),
           ).toBe(true)
           expect(maxActive).toBe(1)

          yield* Deferred.succeed(release[0], undefined)
          yield* Deferred.await(started[1]).pipe(Effect.timeout("1 second"))
          expect(scans).toBe(3)
          expect(maxActive).toBe(1)
          // A new admission during the follow-up must create one more pending generation, rather
          // than treating the original two-scan bound as a permanent lifetime cap.
          const newerBurst = yield* reload.reload().pipe(Effect.forkScoped)
          yield* Deferred.succeed(release[1], undefined)
          yield* Deferred.await(started[2]).pipe(Effect.timeout("1 second"))
          yield* Deferred.succeed(release[2], undefined)
          expect(yield* Fiber.join(publicWaiter)).toEqual({ count: 1 })
          yield* Fiber.join(commandWaiter)
          expect(yield* Fiber.join(toolWaiter)).toMatchObject({ output: { count: 2 } })
          expect(commandResults).toEqual(["Reloaded 2 skills."])
          expect(yield* Fiber.join(newerBurst)).toEqual({ count: 2 })
          expect(scans).toBe(4)
        }),
      ),
    ),
  )

  it.live("retains the committed catalogue and emits no update when a required reload source fails", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<PluginEvent>()
          let fail = false
          yield* Effect.promise(() => write(tmp.path, "committed"))
          const discovery = SkillDiscovery.Service.of({
            pull: () =>
              fail
                ? Effect.die(new Error("required source failed"))
                : Effect.succeed([AbsolutePath.make(path.join(tmp.path, "remote"))]),
          })
          const skill = yield* Skill.Service
          const entries = [new Document({ type: "document", info: decode({ skills: ["https://skills.example.test/catalog"] }) })]
          yield* ConfigSkillPlugin.Plugin.effect(
            host({
              event: { subscribe: () => Stream.fromPubSub(events) },
              skill: {
                list: () => skill.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
                transform: skill.transform,
                reload: skill.reload,
              },
            }),
          ).pipe(
            Effect.provideService(SkillDiscovery.Service, discovery),
            Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: tmp.path })),
            Effect.provide(locationLayer),
            Effect.provide(Watcher.testLayer),
            Effect.provide(Config.testLayer(entries)),
          )
          const committed = yield* skill.list()
          const bus = yield* Bus.Service
          const published = yield* Deferred.make<void>()
          yield* bus.subscribe(Skill.Event.Updated).pipe(
            Stream.runForEach(() => Deferred.succeed(published, undefined).pipe(Effect.asVoid)),
            Effect.forkScoped,
          )
          fail = true
          const failure = yield* (yield* ConfigSkillReload.Service).reload().pipe(Effect.flip)
          expect(failure._tag).toBe("ConfigSkillReload.ReloadFailed")
          expect(yield* skill.list()).toEqual(committed)
          expect(Exit.isFailure(yield* Deferred.await(published).pipe(Effect.timeout("100 millis"), Effect.exit))).toBe(true)

          fail = false
          expect(yield* (yield* ConfigSkillReload.Service).reload()).toEqual({ count: committed.length })
        }),
      ),
    ),
  )

  it.live("admits a watcher-only invalidation without waiting for its blocked scan", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let scans = 0
          yield* Effect.promise(() => write(tmp.path, "before watcher"))
          const discovery = SkillDiscovery.Service.of({
            pull: () =>
              Effect.sync(() => ++scans).pipe(
                Effect.flatMap((scan) =>
                  (scan === 1 ? Effect.void : Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(
                    Effect.as([AbsolutePath.make(path.join(tmp.path, "remote"))]),
                  ),
                ),
              ),
          })
          const skill = yield* Skill.Service
          const entries = [new Document({ type: "document", info: decode({ skills: ["https://skills.example.test/catalog"] }) })]
          yield* ConfigSkillPlugin.Plugin.effect(
            host({
              skill: {
                list: () => skill.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
                transform: skill.transform,
                reload: skill.reload,
              },
            }),
          ).pipe(
            Effect.provideService(SkillDiscovery.Service, discovery),
            Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: tmp.path })),
            Effect.provide(locationLayer),
            Effect.provide(Watcher.testLayer),
            Effect.provide(Config.testLayer(entries)),
          )
          const watcher = yield* Watcher.Test
          const watched = path.join(tmp.path, "remote")
          expect(yield* watcher.subscriptions()).toContainEqual({ path: watched, type: "directory" })
          const updated = yield* Deferred.make<void>()
          yield* (yield* Bus.Service)
            .subscribe(Skill.Event.Updated)
            .pipe(Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)), Effect.forkScoped)
          yield* Effect.promise(() => write(tmp.path, "after watcher"))
          const emitted = yield* watcher.emit({ type: "update", path: path.join(watched, "SKILL.md") }).pipe(Effect.forkScoped)
          // Ignoring the watcher leaves `started` unresolved; direct refresh or awaiting registration
          // makes this emitter wait for `release` instead of returning immediately.
          expect(Exit.isSuccess(yield* Fiber.join(emitted).pipe(Effect.timeout("100 millis"), Effect.exit))).toBe(true)
          yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
          expect(scans).toBe(2)
          yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(updated).pipe(Effect.timeout("1 second"))
          expect((yield* skill.list()).map((item) => item.description)).toEqual(["after watcher"])
        }),
      ),
    ),
  )

  it.live("admits a config-only invalidation without waiting for its blocked scan", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
           const started = yield* Deferred.make<void>()
           const release = yield* Deferred.make<void>()
          const events = yield* PubSub.unbounded<PluginEvent>()
          let scans = 0
          yield* Effect.promise(() => write(tmp.path, "config"))
          const discovery = SkillDiscovery.Service.of({
            pull: () =>
              Effect.sync(() => ++scans).pipe(
                Effect.flatMap((scan) =>
                  (scan === 1 ? Effect.void : Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(
                    Effect.as([AbsolutePath.make(path.join(tmp.path, "remote"))]),
                  ),
                ),
              ),
          })
          const skill = yield* Skill.Service
          const entries = [new Document({ type: "document", info: decode({ skills: ["https://skills.example.test/catalog"] }) })]
          yield* ConfigSkillPlugin.Plugin.effect(
            host({
              event: { subscribe: () => Stream.fromPubSub(events) },
              skill: {
                list: () => skill.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
                transform: skill.transform,
                reload: skill.reload,
              },
            }),
          ).pipe(
            Effect.provideService(SkillDiscovery.Service, discovery),
            Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: tmp.path })),
            Effect.provide(locationLayer),
            Effect.provide(Watcher.testLayer),
            Effect.provide(Config.testLayer(entries)),
          )
          yield* Effect.yieldNow
          const published = yield* PubSub.publish(events, { type: "config.updated" } as PluginEvent).pipe(Effect.forkScoped)
          // Ignoring config events leaves `started` unresolved; a direct refresh/await path holds
          // this publisher until `release`, whereas gated background admission returns now.
           expect(Exit.isSuccess(yield* Fiber.join(published).pipe(Effect.timeout("100 millis"), Effect.exit))).toBe(true)
           yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
           expect(scans).toBe(2)
           yield* Deferred.succeed(release, undefined)
        }),
      ),
    ),
  )

  it.live("creates no pending batch without background events and one shared follow-up when watcher and config events arrive", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const idleStarted = yield* Deferred.make<void>()
          const idleRelease = yield* Deferred.make<void>()
           const burstStarted = yield* Deferred.make<void>()
           const burstRelease = yield* Deferred.make<void>()
           const followUpStarted = yield* Deferred.make<void>()
          const events = yield* PubSub.unbounded<PluginEvent>()
          let scans = 0
          let active = 0
          let maxActive = 0
          yield* Effect.promise(() => write(tmp.path, "burst"))
          const discovery = SkillDiscovery.Service.of({
            pull: () =>
              Effect.sync(() => {
                scans += 1
                active += 1
                maxActive = Math.max(maxActive, active)
                return scans
              }).pipe(
                Effect.flatMap((scan) => {
                  if (scan === 2) return Deferred.succeed(idleStarted, undefined).pipe(Effect.andThen(Deferred.await(idleRelease)))
                   if (scan === 3) return Deferred.succeed(burstStarted, undefined).pipe(Effect.andThen(Deferred.await(burstRelease)))
                   if (scan === 4) return Deferred.succeed(followUpStarted, undefined)
                  return Effect.void
                }),
                Effect.ensuring(Effect.sync(() => active--)),
                Effect.as([AbsolutePath.make(path.join(tmp.path, "remote"))]),
              ),
          })
          const skill = yield* Skill.Service
          const entries = [new Document({ type: "document", info: decode({ skills: ["https://skills.example.test/catalog"] }) })]
          yield* ConfigSkillPlugin.Plugin.effect(
            host({
              event: { subscribe: () => Stream.fromPubSub(events) },
              skill: {
                list: () => skill.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
                transform: skill.transform,
                reload: skill.reload,
              },
            }),
          ).pipe(
            Effect.provideService(SkillDiscovery.Service, discovery),
            Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: tmp.path })),
            Effect.provide(locationLayer),
            Effect.provide(Watcher.testLayer),
            Effect.provide(Config.testLayer(entries)),
          )
          const reload = yield* ConfigSkillReload.Service
          const withoutEvents = yield* reload.reload().pipe(Effect.forkScoped)
          yield* Deferred.await(idleStarted).pipe(Effect.timeout("1 second"))
          yield* Deferred.succeed(idleRelease, undefined)
          expect(yield* Fiber.join(withoutEvents)).toEqual({ count: 1 })
          expect(scans).toBe(2)

          const running = yield* reload.reload().pipe(Effect.forkScoped)
          yield* Deferred.await(burstStarted).pipe(Effect.timeout("1 second"))
          const watcher = yield* Watcher.Test
           yield* watcher.emit({ type: "update", path: path.join(tmp.path, "remote", "SKILL.md") })
           yield* PubSub.publish(events, { type: "config.updated" } as PluginEvent)
          // With no events, the prior cycle proved no follow-up. Here both must reach the gate:
          // ignoring either event loses its isolated test, while direct refresh bypasses make
          // maxActive exceed one before G is released instead of sharing one pending ticket.
          yield* Deferred.succeed(burstRelease, undefined)
          expect(yield* Fiber.join(running)).toEqual({ count: 1 })
           yield* Deferred.await(followUpStarted).pipe(Effect.timeout("1 second"))
           expect(scans).toBe(4)
           expect(maxActive).toBe(1)
        }),
      ),
    ),
  )
})
