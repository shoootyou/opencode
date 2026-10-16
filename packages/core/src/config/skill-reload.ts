export * as ConfigSkillReload from "./skill-reload.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Cause, Context, Deferred, Effect, Exit, Layer, Ref, Schema, Scope, Semaphore } from "effect"

export class ReloadUnavailable extends Schema.TaggedError<ReloadUnavailable>()("ConfigSkillReload.ReloadUnavailable", {}) {}

export class ReloadFailed extends Schema.TaggedError<ReloadFailed>()("ConfigSkillReload.ReloadFailed", {
  cause: Schema.Defect(),
}) {}

export class ReloadTeardown extends Schema.TaggedError<ReloadTeardown>()("ConfigSkillReload.ReloadTeardown", {}) {}

type Result = { readonly count: number }
type Batch = { readonly id: symbol; readonly done: Deferred.Deferred<Result, unknown>; readonly mode: "initial" | "reload" }
type State =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Idle"; readonly token: symbol; readonly scope: Scope.Closeable }
  | { readonly _tag: "Scheduled"; readonly token: symbol; readonly scope: Scope.Closeable; readonly batch: Batch }
  | { readonly _tag: "Running"; readonly token: symbol; readonly scope: Scope.Closeable; readonly batch: Batch; readonly pending?: Batch }
  | { readonly _tag: "Closing"; readonly token: symbol }

export interface Interface {
  readonly reload: () => Effect.Effect<Result, ReloadUnavailable | ReloadFailed | ReloadTeardown>
}

type Scanner = (mode: "initial" | "reload") => Effect.Effect<Result, unknown>
type Registration = {
  readonly initial: Effect.Effect<Result, ReloadUnavailable | ReloadFailed | ReloadTeardown>
  readonly invalidate: () => Effect.Effect<void>
}
type Internal = Interface & {
  readonly install: (scanner: Scanner, options?: { readonly initial?: boolean }) => Effect.Effect<Registration, never, Scope.Scope>
}

const make = Effect.gen(function* () {
  const state = yield* Ref.make<State>({ _tag: "Unavailable" })
  const gate = Semaphore.makeUnsafe(1)

  const makeBatch = (mode: Batch["mode"]) =>
    Deferred.make<Result, unknown>().pipe(
      Effect.map((done) => ({ id: Symbol("ConfigSkillReload.batch"), done, mode })),
    )

  const asReloadFailure = (exit: Exit.Exit<Result, unknown>) => {
    if (Exit.isSuccess(exit)) return exit
    if (Cause.hasInterrupts(exit.cause) || !Cause.hasFails(exit.cause)) return exit
    const failure = Cause.squash(exit.cause)
    if (failure instanceof ReloadUnavailable || failure instanceof ReloadFailed || failure instanceof ReloadTeardown)
      return Exit.fail(failure)
    return Exit.fail(new ReloadFailed({ cause: exit.cause }))
  }

  const awaitBatch = (done: Deferred.Deferred<Result, unknown>): Effect.Effect<Result, ReloadUnavailable | ReloadFailed | ReloadTeardown> =>
    Deferred.await(done).pipe(
      Effect.catch((error) => {
        if (
          error instanceof ReloadUnavailable ||
          error instanceof ReloadFailed ||
          error instanceof ReloadTeardown
        )
          return Effect.fail(error)
        return Effect.fail(new ReloadFailed({ cause: error }))
      }),
    )

  const settle = (token: symbol, batch: Batch, exit: Exit.Exit<Result, unknown>): Effect.Effect<void> =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          if (current._tag !== "Running" || current.token !== token || current.batch.id !== batch.id) return
          const result = asReloadFailure(exit)
          yield* Deferred.done(batch.done, result)
          if (!current.pending) {
            yield* Ref.set(state, { _tag: "Idle", token, scope: current.scope })
            return
          }
          yield* Ref.set(state, { _tag: "Scheduled", token, scope: current.scope, batch: current.pending })
          yield* start(token, current.scope, current.pending)
        }),
      ),
    )

  const start = (token: symbol, workerScope: Scope.Closeable, batch: Batch): Effect.Effect<void> =>
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current._tag !== "Scheduled" || current.token !== token || current.batch.id !== batch.id) return
        yield* Ref.set(state, { _tag: "Running", token, scope: workerScope, batch })
        const work = Effect.suspend(() => scannerFor(token)(batch.mode)).pipe(Effect.onExit((exit) => settle(token, batch, exit)))
        yield* Effect.forkIn(work, workerScope)
      }),
    )

  // The scanner is captured per installation, rather than per caller. This Ref is only read by a
  // worker after its token has made it current under the gate.
  const scanners = yield* Ref.make(new Map<symbol, Scanner>())
  const scannerFor = (token: symbol) => (mode: Batch["mode"]) =>
    Effect.flatMap(Ref.get(scanners), (all) => all.get(token)?.(mode) ?? Effect.fail(new ReloadUnavailable()))

  const admit = (mode: Batch["mode"]) =>
    gate.withPermit(
      Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          if (current._tag === "Unavailable" || current._tag === "Closing") return yield* new ReloadUnavailable()
          if (current._tag === "Idle") {
            const batch = yield* makeBatch(mode)
            yield* Ref.set(state, { _tag: "Scheduled", token: current.token, scope: current.scope, batch })
            yield* start(current.token, current.scope, batch)
            return batch.done
          }
          if (current._tag === "Scheduled") return current.batch.done
          if (current.pending) return current.pending.done
          const pending = yield* makeBatch("reload")
          yield* Ref.set(state, { ...current, pending })
          return pending.done
        }),
      ),
    )

  const teardown = (token: symbol, workerScope: Scope.Closeable): Effect.Effect<void> =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          if (current._tag === "Unavailable" || current.token !== token) return
          if (current._tag === "Closing") return
          yield* Ref.set(state, { _tag: "Closing", token })
          const batches = current._tag === "Idle" ? [] : current._tag === "Scheduled" ? [current.batch] : [current.batch, ...(current.pending ? [current.pending] : [])]
          yield* Effect.forEach(batches, (batch) => Deferred.fail(batch.done, new ReloadTeardown()))
        }),
      ),
    ).pipe(
      Effect.andThen(Scope.close(workerScope, Exit.void)),
      Effect.andThen(
        gate.withPermit(
          Ref.update<State>(state, (current) => (current._tag === "Closing" && current.token === token ? { _tag: "Unavailable" } : current)),
        ),
      ),
      Effect.andThen(Ref.update(scanners, (all) => (all.delete(token), all))),
    )

  const install: Internal["install"] = (scanner, options) =>
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const token = Symbol("ConfigSkillReload")
        const workerScope = yield* Scope.make()
        yield* gate.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state)
            if (current._tag !== "Unavailable") return yield* Effect.die("ConfigSkillReload is already installed")
            yield* Ref.update(scanners, (all) => (all.set(token, scanner), all))
            yield* Ref.set(state, { _tag: "Idle", token, scope: workerScope })
          }),
        )
        yield* Effect.addFinalizer(() => teardown(token, workerScope))
        const initial = options?.initial ? yield* admit("initial").pipe(Effect.orDie) : undefined
        return {
          initial: initial ? awaitBatch(initial) : Effect.fail(new ReloadUnavailable()),
          invalidate: () =>
            admit("reload").pipe(
              Effect.catch((error) => Effect.logWarning("failed to admit skill reload", { error })),
              Effect.asVoid,
              Effect.forkIn(workerScope),
              Effect.asVoid,
            ),
        }
      }),
    )

  return {
    reload: () => Effect.flatMap(admit("reload"), awaitBatch),
    install,
  } satisfies Internal
})

export class Service extends Context.Service<Service, Internal>()("@opencode/ConfigSkillReload") {}

const layer = Layer.effect(Service, make)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
