/**
 * @spec-handoff
 * @interface ConfigSkillReload.reload(): Effect<{ count: number }, ReloadUnavailable | ReloadFailed | ReloadTeardown>
 * @behavior
 *   - A reload worker is dispatched with the scheduler captured during installation, never the scheduler of its admitting caller.
 *   - A pending generation promoted after the active generation completes uses that same installation scheduler.
 * @edge-cases
 *   - The initiating caller may provide a scheduler that queues work indefinitely.
 *   - Caller-local ticket waiting remains independent from shared-worker dispatch.
 * @see ../../src/config/skill-reload.ts
 */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Scheduler } from "effect"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([ConfigSkillReload.node])))

describe("ConfigSkillReload worker scheduler ownership", () => {
  it.live("dispatches active and pending workers without the initiating caller scheduler", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const firstStarted = yield* Deferred.make<void>()
      const firstRelease = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const callerTasks: Array<() => void> = []
      const installationTasks: Array<() => void> = []
      let callerDispatches = 0
      let installationDispatches = 0
      const callerScheduler: Scheduler.Scheduler = {
        executionMode: "async",
        shouldYield: () => false,
        makeDispatcher: () => ({
          scheduleTask: (task) => {
            callerDispatches += 1
            callerTasks.push(task)
          },
          flush: () => {
            while (callerTasks.length > 0) callerTasks.shift()!()
          },
        }),
      }
      const installationScheduler: Scheduler.Scheduler = {
        executionMode: "async",
        shouldYield: () => false,
        makeDispatcher: () => ({
          scheduleTask: (task) => {
            installationDispatches += 1
            installationTasks.push(task)
          },
          flush: () => {
            while (installationTasks.length > 0) installationTasks.shift()!()
          },
        }),
      }
      const drainInstallation = () => {
        while (installationTasks.length > 0) installationTasks.shift()!()
      }
      let scans = 0
      yield* reload
        .install(() =>
          Effect.sync(() => ++scans).pipe(
            Effect.tap((scan) =>
              scan === 1 ? Deferred.succeed(firstStarted, undefined) : Deferred.succeed(secondStarted, undefined),
            ),
            Effect.andThen((scan) => (scan === 1 ? Deferred.await(firstRelease) : Effect.void)),
            Effect.andThen(Effect.sync(() => ({ count: scans }))),
          ),
        )
        .pipe(Effect.provideService(Scheduler.Scheduler, installationScheduler))

      const active = yield* reload
        .reload()
        .pipe(Effect.provideService(Scheduler.Scheduler, callerScheduler), Effect.forkScoped)
      yield* Effect.yieldNow
      const activeDispatches = callerDispatches
      const activeInstallationDispatches = installationDispatches
      drainInstallation()
      yield* Deferred.await(firstStarted).pipe(Effect.timeout("1 second"))
      const pending = yield* reload.reload().pipe(Effect.forkScoped)
      yield* Deferred.succeed(firstRelease, undefined)
      yield* Effect.yieldNow
      drainInstallation()
      yield* Deferred.await(secondStarted).pipe(Effect.timeout("1 second"))
      expect({ activeDispatches, callerDispatches }).toEqual({ activeDispatches: 0, callerDispatches: 0 })
      expect(activeInstallationDispatches).toBeGreaterThan(0)
      expect(installationDispatches).toBeGreaterThan(activeInstallationDispatches)
      expect(yield* Fiber.join(active)).toEqual({ count: 1 })
      expect(yield* Fiber.join(pending)).toEqual({ count: 2 })
    }),
  )
})
