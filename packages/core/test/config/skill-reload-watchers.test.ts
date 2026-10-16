/**
 * @spec-handoff
 * @interface ConfigSkillPlugin.Plugin.effect(ctx): Effect<void, never, ConfigSkillReload | Watcher | ...>
 * @behavior
 *   - Candidate watcher streams are released when discovery fails, is interrupted, or plugin teardown interrupts it.
 *   - Commit transfers candidate streams to the plugin, retires the old streams after notification, and teardown releases all streams.
 *   - Notification defects and interrupts release retiring streams without releasing the committed generation.
 * @edge-cases
 *   - Teardown fails active and pending callers with ReloadTeardown without starting a successor.
 * @see ../../src/config/plugin/skill.ts
 */
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Config } from "@opencode/core/config"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { Bus } from "@opencode/core/bus"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Document, type Entry, Info } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { location } from "../fixture/location"
import { host } from "../plugin/host"
import { testEffect } from "../lib/effect"

const decode = Info.make
const watcher = activeWatcher()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Skill.node, Bus.node, FSUtil.node, ConfigSkillReload.node, SkillDiscovery.node, Watcher.node]),
    [Watcher.node.replace(watcher.layer)],
  ),
)

function activeWatcher() {
  const active = new Map<string, number>()
  const waiters = new Set<() => void>()
  const notify = () => waiters.forEach((resolve) => resolve())
  const native = Watcher.Native.of({
    subscribe: (input) =>
      Effect.sync(() => {
          const key = path.resolve(input.target)
          active.set(key, (active.get(key) ?? 0) + 1)
          notify()
          return {
            unsubscribe: async () => {
            const count = active.get(key)! - 1
            if (count === 0) active.delete(key)
            else active.set(key, count)
            notify()
            },
          }
        }),
  })
  return {
    layer: Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native))),
    count: (target?: string) => (target ? active.get(path.resolve(target)) ?? 0 : [...active.values()].reduce((a, b) => a + b, 0)),
    reset: () => active.clear(),
    waitFor: (target: string, count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if ((active.get(path.resolve(target)) ?? 0) !== count) return
          waiters.delete(check)
          resolve()
        }
        waiters.add(check)
        check()
      }),
  }
}

async function skill(directory: string, name: string) {
  await fs.mkdir(path.join(directory, name), { recursive: true })
  await fs.writeFile(path.join(directory, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}`)
}

function entries(urls: string[]): Entry[] {
  return [new Document({ type: "document", info: decode({ skills: urls }) })]
}

/** Starts the production plugin in a closeable scope; no test-only refresh implementation is used. */
const install = Effect.fnUntraced(function* (
  source: SkillDiscovery.Interface,
  configured: Entry[],
  notification: () => Effect.Effect<void>,
) {
  const scope = yield* Scope.make()
  const skills = yield* Skill.Service
  yield* ConfigSkillPlugin.Plugin.effect(
    host({
      skill: { list: () => Effect.die("unused skill.list"), transform: skills.transform, reload: notification },
    }),
  ).pipe(
    Effect.provide(Config.testLayer(configured)),
    Effect.provideService(SkillDiscovery.Service, source),
    Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/tmp" })),
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/tmp") }))),
    Scope.provide(scope),
  )
  return scope
})

describe("ConfigSkillPlugin watcher ownership", () => {
  it.live("releases an acquired candidate stream when discovery fails or is externally interrupted", () =>
    Effect.promise(() => fs.mkdtemp("/tmp/opencode-watcher-")).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp, "first")
          const candidate = path.join(tmp, "candidate")
          yield* Effect.promise(() => Promise.all([skill(first, "first"), skill(candidate, "candidate")]))
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let phase: "initial" | "fail" | "block" = "initial"
          watcher.reset()
          const source = SkillDiscovery.Service.of({
            pull: (url) => {
              if (phase === "initial") return Effect.succeed([AbsolutePath.make(first)])
              if (url.endsWith("one")) return Effect.succeed([AbsolutePath.make(candidate)])
              if (phase === "fail") return Effect.die("required source failed")
              return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as([AbsolutePath.make(first)]))
            },
          })
          const scope = yield* install(source, entries(["https://test/one", "https://test/two"]), () => Effect.void)
          yield* Effect.promise(() => watcher.waitFor(first, 1)).pipe(Effect.timeout("1 second"))
          phase = "fail"
          const reload = yield* (yield* ConfigSkillReload.Service).reload().pipe(Effect.flip)
          expect(reload._tag).toBe("ConfigSkillReload.ReloadFailed")
          expect(watcher.count(candidate)).toBe(0)

          phase = "block"
          const interrupted = yield* (yield* ConfigSkillReload.Service).reload().pipe(Effect.forkScoped)
          yield* Deferred.await(entered).pipe(Effect.timeout("1 second"))
          yield* Effect.promise(() => watcher.waitFor(candidate, 1)).pipe(Effect.timeout("1 second"))
          expect(watcher.count(candidate)).toBe(1)
          // Caller cancellation cannot own the installation worker; closing the plugin then interrupts that worker.
          yield* Fiber.interrupt(interrupted)
          const interruptedExit = yield* Fiber.await(interrupted)
          expect(Exit.isFailure(interruptedExit) && Cause.hasInterrupts(interruptedExit.cause)).toBe(true)
          yield* Scope.close(scope, Exit.void)
          expect(watcher.count(candidate)).toBe(0)
        }),
      ),
    ),
  )

  it.live("transfers committed streams, retires the previous generation after notification, and releases all on teardown", () =>
    Effect.promise(() => fs.mkdtemp("/tmp/opencode-watcher-")).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const old = path.join(tmp, "old")
          const next = path.join(tmp, "next")
          yield* Effect.promise(() => Promise.all([skill(old, "old"), skill(next, "next")]))
          let root = old
          watcher.reset()
          const scope = yield* install(
            SkillDiscovery.Service.of({ pull: () => Effect.sync(() => [AbsolutePath.make(root)]) }),
            entries(["https://test/catalog"]),
            () => Effect.void,
          )
          yield* Effect.promise(() => watcher.waitFor(old, 1)).pipe(Effect.timeout("1 second"))
          expect(watcher.count(old)).toBe(1)
          root = next
          expect(yield* (yield* ConfigSkillReload.Service).reload()).toEqual({ count: 1 })
          // Removing acquireRelease leaks `next` on failure/interruption; removing ensuring leaks `old` on notification exit.
          expect(watcher.count(old)).toBe(0)
          expect(watcher.count(next)).toBe(1)
          yield* Scope.close(scope, Exit.void)
          expect(watcher.count()).toBe(0)
        }),
      ),
    ),
  )

  for (const mode of ["defect", "self-interruption", "external interruption"] as const) {
    it.live(`releases retiring streams after notification ${mode} while retaining the committed stream`, () =>
      Effect.promise(() => fs.mkdtemp("/tmp/opencode-watcher-")).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const old = path.join(tmp, "old")
            const next = path.join(tmp, "next")
            yield* Effect.promise(() => Promise.all([skill(old, "old"), skill(next, "next")]))
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            let root = old
            watcher.reset()
            let notifications = 0
            const notification = () => {
              notifications++
              if (notifications === 1) return Effect.void
              if (mode === "defect") return Effect.die("notification defect")
              if (mode === "self-interruption") return Effect.interrupt
              return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.interrupt))
            }
            const scope = yield* install(
              SkillDiscovery.Service.of({ pull: () => Effect.sync(() => [AbsolutePath.make(root)]) }),
              entries(["https://test/catalog"]),
              notification,
            )
            yield* Effect.promise(() => watcher.waitFor(old, 1)).pipe(Effect.timeout("1 second"))
            root = next
            const reload = yield* (yield* ConfigSkillReload.Service).reload().pipe(Effect.forkScoped)
            if (mode === "external interruption") {
              yield* Deferred.await(entered).pipe(Effect.timeout("1 second"))
              yield* Deferred.succeed(release, undefined)
            }
            const exit = yield* Fiber.await(reload)
            expect(Exit.isFailure(exit)).toBe(true)
            expect(watcher.count(old)).toBe(0)
            expect(watcher.count(next)).toBe(1)
            yield* Scope.close(scope, Exit.void)
            expect(watcher.count()).toBe(0)
          }),
        ),
      ),
    )
  }

  it.live("teardown fails waiters with ReloadTeardown, starts no successor, and releases a blocked candidate", () =>
    Effect.promise(() => fs.mkdtemp("/tmp/opencode-watcher-")).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const old = path.join(tmp, "old")
          const candidate = path.join(tmp, "candidate")
          yield* Effect.promise(() => Promise.all([skill(old, "old"), skill(candidate, "candidate")]))
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let root = old
          let calls = 0
          watcher.reset()
          const scope = yield* install(
            SkillDiscovery.Service.of({
              pull: (url) =>
                Effect.sync(() => ++calls).pipe(
                  Effect.flatMap(() =>
                    root === candidate && url.endsWith("blocker")
                      ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                      : Effect.void,
                  ),
                  Effect.as([AbsolutePath.make(root)]),
                ),
            }),
            entries(["https://test/catalog", "https://test/blocker"]),
            () => Effect.void,
          )
          yield* Effect.promise(() => watcher.waitFor(old, 1)).pipe(Effect.timeout("1 second"))
          root = candidate
          const reload = yield* ConfigSkillReload.Service.pipe(Effect.flatMap((service) => service.reload()), Effect.forkScoped)
          yield* Deferred.await(entered).pipe(Effect.timeout("1 second"))
          const callsBeforeClose = calls
          const pending = yield* ConfigSkillReload.Service.pipe(Effect.flatMap((service) => service.reload()), Effect.forkScoped)
          // Let the fork execute admission before the teardown linearization point.
          yield* Effect.yieldNow
          yield* Effect.promise(() => watcher.waitFor(candidate, 1)).pipe(Effect.timeout("1 second"))
          expect(watcher.count(candidate)).toBe(1)
          yield* Scope.close(scope, Exit.void)
          for (const fiber of [reload, pending]) {
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("ConfigSkillReload.ReloadTeardown")
          }
          expect(calls).toBe(callsBeforeClose)
          expect(watcher.count()).toBe(0)
        }),
      ),
    ),
  )
})
