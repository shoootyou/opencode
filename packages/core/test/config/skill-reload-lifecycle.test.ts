/**
 * @spec-handoff
 * @interface ConfigSkillReload.reload(): Effect<{ count: number }, ReloadUnavailable | ReloadFailed | ReloadTeardown, never>
 * @behavior
 *   - A caller admitted while a scan is running receives a distinct pending-generation ticket.
 *   - Cancelling an initiating or pending-ticket caller interrupts only that caller, never shared installation-owned work.
 *   - A finite burst has one running scan and exactly one follow-up; a burst during that follow-up gets one further scan.
 *   - Closing an installation settles active and pending tickets with ReloadTeardown and starts no successor.
 *   - Shared scanner work always runs with the execution context captured at installation, not a triggering caller's overrides.
 *   - Installation rejects duplicates and Closing blocks reinstall until teardown completes.
 *   - Background invalidations return after admission and never await the shared scan.
 * @edge-cases
 *   - Scanner interruption settles waiters with interruption and a later reload can run.
 *   - Replacing invalidate's fork with asVoid is equivalent today because admit returns a Deferred without awaiting it; non-waiting behavior is instead proven through production event handshakes.
 * @mutation-targets running Deferred reuse; pending promotion; caller-owned worker; catchCause finalizer; teardown ticket completion; installation token check
 * @see ../../src/config/skill-reload.ts
 */
import { describe, expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([ConfigSkillReload.node])))

test("fences stale worker settlement by installation token and batch identity", async () => {
  const source = await Bun.file(new URL("../../src/config/skill-reload.ts", import.meta.url)).text()
  expect(source).toContain('current._tag !== "Running" || current.token !== token || current.batch.id !== batch.id')
})

describe("ConfigSkillReload lifecycle", () => {
  it.live(
    "keeps a scan alive after its initiating caller is cancelled and settles joined pending callers from one follow-up",
    () =>
      Effect.gen(function* () {
        const reload = yield* ConfigSkillReload.Service
        const firstStarted = yield* Deferred.make<void>()
        const firstRelease = yield* Deferred.make<void>()
        const followUpStarted = yield* Deferred.make<void>()
        const followUpRelease = yield* Deferred.make<void>()
        let scans = 0
        yield* reload.install(() =>
          Effect.sync(() => ++scans).pipe(
            Effect.tap((scan) =>
              scan === 1 ? Deferred.succeed(firstStarted, undefined) : Deferred.succeed(followUpStarted, undefined),
            ),
            Effect.andThen((scan) => (scan === 1 ? Deferred.await(firstRelease) : Deferred.await(followUpRelease))),
            Effect.andThen(Effect.sync(() => ({ count: scans }))),
          ),
        )

        const initiator = yield* reload.reload().pipe(Effect.forkScoped)
        yield* Deferred.await(firstStarted).pipe(Effect.timeout("1 second"))
        const joinedPending = yield* reload.reload().pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        const anotherPending = yield* reload.reload().pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(initiator)
        const initiatorExit = yield* Fiber.await(initiator)
        expect(Exit.isFailure(initiatorExit) && Cause.hasInterruptsOnly(initiatorExit.cause)).toBe(true)

        yield* Deferred.succeed(firstRelease, undefined)
        // This is a watchdog around a state-machine handshake, not ordering by time.
        yield* Deferred.await(followUpStarted).pipe(Effect.timeout("1 second"))
        yield* Deferred.succeed(followUpRelease, undefined)
        expect(yield* Fiber.join(joinedPending)).toEqual({ count: 2 })
        expect(yield* Fiber.join(anotherPending)).toEqual({ count: 2 })
        expect(scans).toBe(2)
        expect(yield* reload.reload()).toEqual({ count: 3 })
      }),
  )

  it.live("creates a new pending ticket for a burst admitted after the follow-up has started", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const started = [yield* Deferred.make<void>(), yield* Deferred.make<void>(), yield* Deferred.make<void>()]
      const release = [yield* Deferred.make<void>(), yield* Deferred.make<void>(), yield* Deferred.make<void>()]
      let scans = 0
      yield* reload.install(() =>
        Effect.sync(() => ++scans).pipe(
          Effect.tap((scan) => Deferred.succeed(started[scan - 1]!, undefined)),
          Effect.andThen((scan) => Deferred.await(release[scan - 1]!)),
          Effect.andThen(Effect.sync(() => ({ count: scans }))),
        ),
      )

      const first = yield* reload.reload().pipe(Effect.forkScoped)
      yield* Deferred.await(started[0]).pipe(Effect.timeout("1 second"))
      const firstFollowUp = yield* reload.reload().pipe(Effect.forkScoped)
      yield* Deferred.succeed(release[0], undefined)
      yield* Deferred.await(started[1]).pipe(Effect.timeout("1 second"))
      const secondFollowUp = yield* reload.reload().pipe(Effect.forkScoped)
      yield* Deferred.succeed(release[1], undefined)
      yield* Deferred.await(started[2]).pipe(Effect.timeout("1 second"))
      yield* Deferred.succeed(release[2], undefined)

      expect(yield* Fiber.join(first)).toEqual({ count: 1 })
      expect(yield* Fiber.join(firstFollowUp)).toEqual({ count: 2 })
      expect(yield* Fiber.join(secondFollowUp)).toEqual({ count: 3 })
      expect(scans).toBe(3)
    }),
  )

  it.live("runs the active and pending shared scans with the installation context rather than either caller context", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const ExecutionOwner = Context.Reference("test/config-skill-reload/execution-owner", {
        defaultValue: () => "missing",
      })
      const owner = yield* Scope.make()
      const firstStarted = yield* Deferred.make<void>()
      const firstRelease = yield* Deferred.make<void>()
      const observed: string[] = []
      let scans = 0
      yield* reload
        .install(() =>
          Effect.gen(function* () {
            scans += 1
            observed.push(yield* ExecutionOwner)
            if (scans === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(firstRelease)
            }
            return { count: scans }
          }),
        )
        .pipe(Scope.provide(owner), Effect.provideService(ExecutionOwner, "installation"))

      const active = yield* reload.reload().pipe(Effect.provideService(ExecutionOwner, "active-caller"), Effect.forkScoped)
      yield* Deferred.await(firstStarted).pipe(Effect.timeout("1 second"))
      const pending = yield* reload.reload().pipe(Effect.provideService(ExecutionOwner, "pending-caller"), Effect.forkScoped)
      yield* Deferred.succeed(firstRelease, undefined)
      expect(yield* Fiber.join(active)).toEqual({ count: 1 })
      expect(yield* Fiber.join(pending)).toEqual({ count: 2 })
      expect(observed).toEqual(["installation", "installation"])
      yield* Scope.close(owner, Exit.void)
    }),
  )

  it.live("returns background invalidation after admission without awaiting its blocked shared scan", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const registration = yield* reload.install(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ count: 1 }),
        ),
      )
      const invalidation = yield* registration.invalidate().pipe(Effect.forkScoped)
      yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
      expect(Exit.isSuccess(yield* Fiber.join(invalidation).pipe(Effect.timeout("100 millis"), Effect.exit))).toBe(true)
      yield* Deferred.succeed(release, undefined)
    }),
  )

  it.live("gives a request admitted during a scan a later generation that rereads changed discovery state", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const firstStarted = yield* Deferred.make<void>()
      const firstRelease = yield* Deferred.make<void>()
      const observedRoots: string[] = []
      let root = "before"
      let scans = 0
      yield* reload.install(() =>
        Effect.sync(() => ++scans).pipe(
          Effect.tap((scan) =>
            Effect.sync(() => observedRoots.push(root)).pipe(
              Effect.andThen(scan === 1 ? Deferred.succeed(firstStarted, undefined) : Effect.void),
            ),
          ),
          Effect.andThen((scan) => (scan === 1 ? Deferred.await(firstRelease) : Effect.void)),
          Effect.andThen(Effect.sync(() => ({ count: scans }))),
        ),
      )
      const earlier = yield* reload.reload().pipe(Effect.forkScoped)
      yield* Deferred.await(firstStarted).pipe(Effect.timeout("1 second"))
      root = "after"
      const later = yield* reload.reload().pipe(Effect.forkScoped)
      yield* Deferred.succeed(firstRelease, undefined)
      expect(yield* Fiber.join(earlier)).toEqual({ count: 1 })
      expect(yield* Fiber.join(later)).toEqual({ count: 2 })
      expect(observedRoots).toEqual(["before", "after"])
    }),
  )

  it.live("releases interrupted scanner resources before settling waiters and permits a later reload", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let activeResources = 0
      let scans = 0
      yield* reload.install(() =>
        Effect.sync(() => ++scans).pipe(
          Effect.flatMap((scan) => {
            if (scan > 1) return Effect.succeed({ count: scan })
            return Effect.scoped(
              Effect.acquireRelease(
                Effect.sync(() => ++activeResources).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
                () => Effect.sync(() => --activeResources),
              ).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.interrupt)),
            )
          }),
        ),
      )
      const waiting = yield* reload.reload().pipe(Effect.forkScoped)
      yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
      expect(activeResources).toBe(1)
      yield* Deferred.succeed(release, undefined)
      const interrupted = yield* Fiber.await(waiting)
      expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
      expect(activeResources).toBe(0)
      expect(yield* reload.reload()).toEqual({ count: 2 })
    }),
  )

  it.live("admits initial activation through the same gate and defers a concurrent strict reload", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const scope = yield* Scope.make()
      const initialStarted = yield* Deferred.make<void>()
      const initialRelease = yield* Deferred.make<void>()
      const modes: string[] = []
      let scans = 0
      const registration = yield* reload
        .install(
          (mode) =>
            Effect.sync(() => ++scans).pipe(
              Effect.tap(() => Effect.sync(() => modes.push(mode))),
              Effect.andThen((scan) =>
                scan === 1
                  ? Deferred.succeed(initialStarted, undefined).pipe(Effect.andThen(Deferred.await(initialRelease)))
                  : Effect.void,
              ),
              Effect.andThen(Effect.sync(() => ({ count: scans }))),
            ),
          { initial: true },
        )
        .pipe(Scope.provide(scope))
      const initial = yield* registration.initial.pipe(Effect.forkScoped)
      yield* Deferred.await(initialStarted).pipe(Effect.timeout("1 second"))
      const strictReload = yield* reload.reload().pipe(Effect.forkScoped)
      yield* Deferred.succeed(initialRelease, undefined)
      expect(yield* Fiber.join(initial)).toEqual({ count: 1 })
      expect(yield* Fiber.join(strictReload)).toEqual({ count: 2 })
      expect(modes).toEqual(["initial", "reload"])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live(
    "settles active and pending tickets with ReloadTeardown during scope closure and permits only completed teardown to reinstall",
    () =>
      Effect.gen(function* () {
        const reload = yield* ConfigSkillReload.Service
        const owner = yield* Scope.make()
        const started = yield* Deferred.make<void>()
        const finalizerStarted = yield* Deferred.make<void>()
        const releaseFinalizer = yield* Deferred.make<void>()
        yield* reload
          .install(() =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onExit(() =>
                Deferred.succeed(finalizerStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFinalizer))),
              ),
            ),
          )
          .pipe(Scope.provide(owner))
        const active = yield* reload.reload().pipe(Effect.forkScoped)
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
        const pending = yield* reload.reload().pipe(Effect.forkScoped)
        const closing = yield* Scope.close(owner, Exit.void).pipe(Effect.forkScoped)

        const activeExit = yield* Fiber.await(active)
        const pendingExit = yield* Fiber.await(pending)
        for (const exit of [activeExit, pendingExit]) {
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ConfigSkillReload.ReloadTeardown")
        }
        // Ticket settlement is the teardown handshake: it happens after Closing is linearized and
        // before scope closure is allowed to interrupt the scanner.
        const duplicateWhileClosing = yield* reload.install(() => Effect.succeed({ count: 2 })).pipe(Effect.exit)
        expect(Exit.isFailure(duplicateWhileClosing)).toBe(true)
        yield* Deferred.await(finalizerStarted).pipe(Effect.timeout("1 second"))
        yield* Deferred.succeed(releaseFinalizer, undefined)
        yield* Fiber.join(closing)
        const replacement = yield* Scope.make()
        yield* reload.install(() => Effect.succeed({ count: 2 })).pipe(Scope.provide(replacement))
        expect(yield* reload.reload()).toEqual({ count: 2 })
        yield* Scope.close(replacement, Exit.void)
      }),
  )

  it.live("rejects duplicate installation and leaves a replacement intact when an old scope finalizes again", () =>
    Effect.gen(function* () {
      const reload = yield* ConfigSkillReload.Service
      const first = yield* Scope.make()
      yield* reload.install(() => Effect.succeed({ count: 1 })).pipe(Scope.provide(first))
      const duplicate = yield* reload.install(() => Effect.succeed({ count: 2 })).pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)
      yield* Scope.close(first, Exit.void)

      const replacement = yield* Scope.make()
      yield* reload.install(() => Effect.succeed({ count: 2 })).pipe(Scope.provide(replacement))
      yield* Scope.close(first, Exit.void)
      expect(yield* reload.reload()).toEqual({ count: 2 })
      yield* Scope.close(replacement, Exit.void)
    }),
  )
})
