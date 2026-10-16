export * as ConfigSkillReload from "./skill-reload.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Cause, Context, Effect, Layer, Option, Ref, Schema, Scope, Semaphore } from "effect"

export class ReloadUnavailable extends Schema.TaggedError<ReloadUnavailable>()("ConfigSkillReload.ReloadUnavailable", {}) {}

export class ReloadFailed extends Schema.TaggedError<ReloadFailed>()("ConfigSkillReload.ReloadFailed", {
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly reload: () => Effect.Effect<{ readonly count: number }, ReloadUnavailable | ReloadFailed>
}

type Internal = Interface & {
  readonly install: (
    reload: () => Effect.Effect<{ readonly count: number }, unknown, Scope.Scope>,
  ) => Effect.Effect<void, never, Scope.Scope>
}

const make = Effect.gen(function* () {
  const installed = yield* Ref.make<
    Option.Option<{ readonly reload: () => Effect.Effect<{ readonly count: number }, unknown, never>; readonly token: symbol }>
  >(
    Option.none(),
  )
  const gate = Semaphore.makeUnsafe(1)
  const install = (reload: () => Effect.Effect<{ readonly count: number }, unknown, Scope.Scope>) =>
    gate.withPermit(
      Effect.gen(function* () {
        const token = Symbol("ConfigSkillReload")
        const scope = yield* Scope.Scope
        yield* Ref.modify(installed, (current) =>
          Option.isSome(current)
            ? [Effect.die("ConfigSkillReload is already installed"), current]
            : [Effect.void, Option.some({ reload: () => reload().pipe(Effect.provideService(Scope.Scope, scope)), token })],
        ).pipe(Effect.flatten)
        yield* Effect.addFinalizer(() =>
          gate.withPermit(
            Ref.update(installed, (current) =>
              Option.filter(current, (owner) => owner.token !== token),
            ),
          ),
        )
      }),
    )
  return {
    reload: (): Effect.Effect<{ readonly count: number }, ReloadUnavailable | ReloadFailed> =>
      gate.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(installed)
          if (Option.isNone(current)) return yield* new ReloadUnavailable()
          return yield* current.value.reload().pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause) && Cause.hasFails(cause),
              (cause) => Effect.fail(new ReloadFailed({ cause })),
            ),
          )
        }),
      ).pipe(
        Effect.mapError((error): ReloadUnavailable | ReloadFailed =>
          error instanceof ReloadUnavailable || error instanceof ReloadFailed ? error : new ReloadFailed({ cause: error }),
        ),
      ),
    install,
  } satisfies Internal
})

export class Service extends Context.Service<Service, Internal>()("@opencode/ConfigSkillReload") {}

const layer = Layer.effect(Service, make)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
