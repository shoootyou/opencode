/**
 * @spec-handoff
 * @interface /reload: Command.Invocation -> Effect<void, Command.ExecutionError>
 * @behavior
 *   - Publishes one marked, described safe failure notice before returning each typed reload failure.
 *   - Preserves interruptions and defects without publishing a reload notice.
 *   - Captures Bus and reload capability while the plugin is constructed; later user reload commands win.
 * @edge-cases
 *   - ReloadUnavailable, ReloadFailed, and ReloadTeardown never expose an internal cause.
 *   - Execution has no ambient Bus or capability requirement after plugin construction.
 * @see ../../src/fork/plugin/reload-command.ts
 */
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ForkCapabilities } from "@opencode/core/fork/capabilities/service"
import { ReloadCommand } from "@opencode/core/fork/plugin/reload-command"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionEvent } from "@opencode/schema/session-event"
import { Session } from "@opencode/schema/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { emptyMcpLayer } from "../fixture/mcp"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const directory = AbsolutePath.make("/repo/packages/app")
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Command.node, Mcp.node, Bus.node, ConfigSkillReload.node]), [
    Mcp.node.replace(emptyMcpLayer),
    Location.node.replace(locationLayer),
  ]),
)

const invocation = {
  sessionID: Session.ID.make("ses_reload_feedback_errors"),
  prompt: { text: "" },
  delivery: "steer" as const,
}

const capabilities = (reload: ForkCapabilities.Interface["reload"]) =>
  ForkCapabilities.Service.of({
    snapshot: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    catalogue: () => Effect.die("unused"),
    resolve: () => Effect.die("unused"),
    reload,
  })

describe("/reload immediate feedback failures", () => {
  it.effect("publishes exactly one safe display-only notice for every typed reload failure without exposing its cause", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const bus = yield* Bus.Service
      const notices: unknown[] = []
      yield* bus.project(SessionEvent.Synthetic, (event) =>
        Effect.sync(() => {
          if (event.data.metadata?.["opencode.fork.displayOnly"] === true) notices.push(event)
        }),
      )

      const sentinel = "internal-reload-cause-must-not-reach-the-user"
      const cases = [
        [new ConfigSkillReload.ReloadUnavailable(), "Skill reload is unavailable for this location."],
        [new ConfigSkillReload.ReloadFailed({ cause: new Error(sentinel) }), "Unable to reload skills for this location."],
        [new ConfigSkillReload.ReloadTeardown(), "Skill reload was interrupted because this location closed."],
      ] as const

      for (const [failure, message] of cases) {
        yield* ReloadCommand.Plugin.effect(
          host({
            command: {
              list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
              transform: command.transform,
              reload: command.reload,
            },
            session: { synthetic: () => Effect.die("feedback must use direct SessionEvent.Synthetic publication") },
          }),
        ).pipe(
          Effect.provideService(ForkCapabilities.Service, capabilities(() => Effect.fail(failure))),
          Effect.provide(locationLayer),
        )

        const error = yield* command.execute({ name: "reload", invocation }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "Command.ExecutionError", message })
        expect(JSON.stringify(error)).not.toContain(sentinel)
        expect(notices).toHaveLength(1)
        expect(notices[0]).toMatchObject({
          data: {
            sessionID: invocation.sessionID,
            text: message,
            description: message,
            metadata: {
              "opencode.fork.displayOnly": true,
              source: "command",
              command: "reload",
              outcome: "error",
            },
          },
        })
        expect(JSON.stringify(notices[0])).not.toContain(sentinel)
        notices.length = 0
      }
    }),
  )

  it.effect("propagates interruption and defects without a notice, then receives a positive sentinel event", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const bus = yield* Bus.Service
      const feedback: unknown[] = []
      const synthetic: string[] = []
      yield* bus.project(SessionEvent.Synthetic, (event) =>
        Effect.sync(() => {
          synthetic.push(event.data.text)
          if (event.data.metadata?.["opencode.fork.displayOnly"] === true) feedback.push(event)
        }),
      )
      const install = (reload: ForkCapabilities.Interface["reload"]) =>
        ReloadCommand.Plugin.effect(
          host({
            command: {
              list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
              transform: command.transform,
              reload: command.reload,
            },
          }),
        ).pipe(Effect.provideService(ForkCapabilities.Service, capabilities(reload)), Effect.provide(locationLayer))

      yield* install(() => Effect.never)
      const interrupted = yield* command.execute({ name: "reload", invocation }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(interrupted)
      const interruptedExit = yield* Fiber.await(interrupted)
      expect(Exit.isFailure(interruptedExit) && Cause.hasInterruptsOnly(interruptedExit.cause)).toBe(true)

      const defect = new Error("reload implementation defect")
      yield* install(() => Effect.die(defect))
      const defectExit = yield* command.execute({ name: "reload", invocation }).pipe(Effect.exit)
      expect(Exit.isFailure(defectExit) && Cause.hasDies(defectExit.cause)).toBe(true)

      yield* bus.publish(SessionEvent.Synthetic, { sessionID: invocation.sessionID, text: "positive sentinel" })
      expect(synthetic).toContain("positive sentinel")
      expect(feedback).toEqual([])
    }),
  )

  it.effect("lets a later user-defined reload override the built-in without fork feedback", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const bus = yield* Bus.Service
      const feedback: unknown[] = []
      let userCalls = 0
      yield* bus.project(SessionEvent.Synthetic, (event) =>
        Effect.sync(() => {
          if (event.data.metadata?.["opencode.fork.displayOnly"] === true) feedback.push(event)
        }),
      )
      yield* ReloadCommand.Plugin.effect(
        host({
          command: {
            list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
            transform: command.transform,
            reload: command.reload,
          },
        }),
      ).pipe(
        Effect.provideService(ForkCapabilities.Service, capabilities(() => Effect.die("built-in must be overridden"))),
        Effect.provide(locationLayer),
      )
      yield* command.transform((editor) =>
        editor.add({ name: "reload", description: "user reload", execute: () => Effect.sync(() => void userCalls++) }),
      )

      yield* command.execute({ name: "reload", invocation })
      expect(userCalls).toBe(1)
      expect(feedback).toEqual([])
    }),
  )

  it.effect("executes with dependencies captured during construction and no executor environment", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const bus = yield* Bus.Service
      const messages: string[] = []
      yield* bus.project(SessionEvent.Synthetic, (event) => Effect.sync(() => messages.push(event.data.text)))
      yield* ReloadCommand.Plugin.effect(
        host({
          command: {
            list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
            transform: command.transform,
            reload: command.reload,
          },
        }),
      ).pipe(
        Effect.provideService(ForkCapabilities.Service, capabilities(() => Effect.succeed({ count: 1 }))),
        Effect.provide(locationLayer),
      )

      const execute: Effect.Effect<void, Command.NotFoundError | Command.ExecutionError, never> = command.execute({
        name: "reload",
        invocation,
      })
      yield* execute
      expect(messages).toEqual(["Reloaded 1 skill."])
    }),
  )
})
