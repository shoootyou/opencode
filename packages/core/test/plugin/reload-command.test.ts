/**
 * @spec-handoff
 * @interface /reload: Command.Invocation -> Effect<void, Command.ExecutionError>
 * @behavior
 *   - Appears in the session command catalogue as “Reload available skills from disk without restarting”.
 *   - Calls the location-scoped ConfigSkillReload service exactly once and records its count as a non-resuming synthetic result.
 *   - Does not admit a model prompt when it executes.
 * @edge-cases
 *   - ReloadFailed becomes the same safe reload-failure message as reload_skills.
 *   - A later user-defined reload command replaces this built-in command.
 * @see ../../src/fork/plugin/reload-command.ts
 * @mutation-targets executor-time capability lookup; double reload; resume flag; interruption catch
 */
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { ConfigSkillReload } from "@opencode/core/config/skill-reload"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { ReloadCommand } from "@opencode/core/fork/plugin/reload-command"
import { ForkCapabilities } from "@opencode/core/fork/capabilities/service"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime } from "effect"
import { emptyMcpLayer } from "../fixture/mcp"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const directory = AbsolutePath.make("/repo/packages/app")
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Command.node, Mcp.node, Bus.node, ConfigSkillReload.node]), [
    Mcp.node.replace(emptyMcpLayer),
    Location.node.replace(locationLayer),
  ]),
)

const invocation = {
  sessionID: Session.ID.make("ses_reload_command"),
  prompt: { text: "" },
  delivery: "steer" as const,
}

const capturedCapabilities = (reload: ForkCapabilities.Interface["reload"]) =>
  ForkCapabilities.Service.of({
    snapshot: () => Effect.die("not used by reload command"),
    get: () => Effect.die("not used by reload command"),
    catalogue: () => Effect.die("not used by reload command"),
    resolve: () => Effect.die("not used by reload command"),
    reload,
  })

describe("ReloadCommand.Plugin /reload", () => {
  it.effect("formats zero and many reload counts without a model prompt", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const synthetic: string[] = []
      for (const count of [0, 3]) {
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
                  synthetic.push(input.text)
                  return SessionInbox.Synthetic.make({
                    id: SessionMessage.ID.create(),
                    sessionID: input.sessionID,
                    time: { created: DateTime.makeUnsafe(0) },
                    type: "synthetic",
                    payload: { text: input.text },
                    delivery: "steer",
                  })
                }),
            },
          }),
        ).pipe(
          Effect.provideService(ForkCapabilities.Service, capturedCapabilities(() => Effect.succeed({ count }))),
          Effect.provide(locationLayer),
        )
        yield* command.execute({ name: "reload", invocation })
      }
      expect(synthetic).toEqual(["Reloaded 0 skills.", "Reloaded 3 skills."])
    }),
  )

  it.effect("maps unavailable but propagates interruption and defects without synthetic admission", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const synthetic: string[] = []
      const run = (reload: ForkCapabilities.Interface["reload"]) =>
        ReloadCommand.Plugin.effect(
          host({
            command: {
              list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
              transform: command.transform,
              reload: command.reload,
            },
            session: {
              synthetic: (input) =>
                Effect.sync(() => {
                  synthetic.push(input.text)
                  return SessionInbox.Synthetic.make({
                    id: SessionMessage.ID.create(),
                    sessionID: input.sessionID,
                    time: { created: DateTime.makeUnsafe(0) },
                    type: "synthetic",
                    payload: { text: input.text },
                    delivery: "steer",
                  })
                }),
            },
          }),
        ).pipe(Effect.provideService(ForkCapabilities.Service, capturedCapabilities(reload)), Effect.provide(locationLayer))

      yield* run(() => Effect.fail(new ConfigSkillReload.ReloadUnavailable()))
      expect(yield* command.execute({ name: "reload", invocation }).pipe(Effect.flip)).toMatchObject({
        message: "Skill reload is unavailable for this location.",
      })

      yield* run(() => Effect.never)
      const interrupted = yield* command.execute({ name: "reload", invocation }).pipe(Effect.interruptible, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(interrupted)
      const interruptedExit = yield* Fiber.await(interrupted)
      expect(Exit.isFailure(interruptedExit) && Cause.hasInterruptsOnly(interruptedExit.cause)).toBe(true)
      const defect = new Error("reload defect")
      yield* run(() => Effect.die(defect))
      const exit = yield* command.execute({ name: "reload", invocation }).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(synthetic).toEqual([])
    }),
  )
  it.effect("lists reload and records its reload count without sending a model prompt", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const reload = yield* ConfigSkillReload.Service
      const synthetic: { text: string; resume?: boolean }[] = []
      let prompts = 0
      let calls = 0
      yield* reload.install(() => Effect.sync(() => ({ count: ++calls })))
      yield* ReloadCommand.Plugin.effect(
        host({
          command: {
            list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            prompt: () =>
              Effect.sync(() => {
                prompts += 1
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_reload_prompt"),
                  sessionID: invocation.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: "unexpected prompt" },
                  delivery: "steer",
                })
              }),
            synthetic: (input) =>
              Effect.sync(() => {
                synthetic.push({ text: input.text, resume: input.resume })
                return SessionInbox.Synthetic.make({
                  id: SessionMessage.ID.make("msg_reload_result"),
                  sessionID: input.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "synthetic",
                  payload: { text: input.text },
                  delivery: "steer",
                })
              }),
          },
        }),
      ).pipe(
        Effect.provideService(ForkCapabilities.Service, capturedCapabilities(reload.reload)),
        Effect.provide(locationLayer),
      )

      expect(yield* command.list()).toContainEqual(
        Command.Info.make({ name: "reload", description: "Reload available skills from disk without restarting" }),
      )
      yield* command.execute({ name: "reload", invocation })
      expect(calls).toBe(1)
      expect(prompts).toBe(0)
      expect(synthetic).toEqual([{ text: "Reloaded 1 skill.", resume: false }])
    }),
  )

  it.effect("returns the safe reload failure without admitting a model prompt", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const reload = yield* ConfigSkillReload.Service
      let prompts = 0
      yield* reload.install(() => Effect.fail(new Error("sentinel reload cause")))
      yield* ReloadCommand.Plugin.effect(
        host({
          command: {
            list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            prompt: () =>
              Effect.sync(() => {
                prompts += 1
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_reload_failure_prompt"),
                  sessionID: invocation.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: "unexpected prompt" },
                  delivery: "steer",
                })
              }),
          },
        }),
      ).pipe(
        Effect.provideService(ForkCapabilities.Service, capturedCapabilities(reload.reload)),
        Effect.provide(locationLayer),
      )

      const failure = yield* command.execute({ name: "reload", invocation }).pipe(Effect.flip)
      expect(failure).toMatchObject({
        _tag: "Command.ExecutionError",
        message: "Unable to reload skills for this location.",
      })
      expect(prompts).toBe(0)
    }),
  )

  it.effect("allows a later user-defined reload command to replace the built-in", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const reload = yield* ConfigSkillReload.Service
      yield* ReloadCommand.Plugin.effect(
        host({
          command: {
            list: () => command.list().pipe(Effect.map((data) => ({ location: { directory }, data }))),
            transform: command.transform,
            reload: command.reload,
          },
        }),
      ).pipe(
        Effect.provideService(ForkCapabilities.Service, capturedCapabilities(reload.reload)),
        Effect.provide(locationLayer),
      )
      yield* command.transform((editor) => editor.add({ name: "reload", description: "User reload", execute: () => Effect.void }))

      expect(yield* command.get("reload")).toEqual(Command.Info.make({ name: "reload", description: "User reload" }))
    }),
  )
})
