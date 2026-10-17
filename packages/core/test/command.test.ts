/**
 * @spec-handoff
 * @interface SessionCommand.catalogue(input: { session: Session.Info }): Effect<Command.Info[]>
 * @interface SessionCommand.resolve(input: { session: Session.Info; command: string }): Effect<Command.Definition | Skill.Info, Command.NotFoundError>
 * @behavior
 *   - Resolves Location, Agent, Skill, and Instance services from the session; callers cannot supply skills.
 *   - Projects only allowed skills and selects an explicit exact-ID command over a projected skill.
 *   - Captures one immutable skill snapshot for every catalogue or resolve operation.
 * @edge-cases
 *   - A reload during an operation cannot mix snapshot generations.
 *   - The command adapter requires Instance placement routing and exposes no unknown environment.
 * @see ../src/fork/capabilities/service.ts
 * @mutation-targets optional Instance routing; unknown-environment execute signature
 */
import { describe, expect } from "bun:test"
import { Command } from "@opencode/core/command"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { SessionCommand } from "@opencode/core/session/command"
import { Instance } from "@opencode/core/instance/service"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Command.node))

const assertSessionCommandContracts = (session: Session.Info) => {
  SessionCommand.catalogue({ session }).pipe(Effect.satisfiesServicesType<Instance.Service>())
  SessionCommand.resolve({ session, command: "missing" }).pipe(
    Effect.satisfiesServicesType<Instance.Service>(),
  )
  SessionCommand.executeWithPrompt({
    session,
    command: "missing",
    text: "",
    prompt: () => Effect.void,
  }).pipe(Effect.satisfiesServicesType<Instance.Service>())
}
void assertSessionCommandContracts

describe("Command", () => {
  it.effect("registers and executes callback commands", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const calls: Command.Invocation[] = []
      yield* command.transform((editor) => {
        editor.add({
          name: "goal",
          description: "Manage the session goal",
          execute: (input) => Effect.sync(() => calls.push(input)),
        })
      })

      expect(yield* command.get("goal")).toEqual(
        Command.Info.make({ name: "goal", description: "Manage the session goal" }),
      )
      const invocation = {
        sessionID: Session.ID.make("ses_test"),
        prompt: { text: "ship it", files: [{ uri: "file:///tmp/plan.md" }] },
        delivery: "steer" as const,
      }
      yield* command.execute({ name: "goal", invocation })
      expect(calls).toEqual([invocation])
    }),
  )

  it.effect("replaces commands with later definitions", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.transform((editor) => {
        editor.add({ name: "goal", description: "First", execute: () => Effect.void })
        editor.add({ name: "goal", description: "Second", execute: () => Effect.void })
      })

      expect(yield* command.list()).toEqual([Command.Info.make({ name: "goal", description: "Second" })])
    }),
  )

  it.effect("returns callback error messages without stack traces", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.transform((editor) => {
        editor.add({
          name: "fail",
          execute: () => Effect.fail(new Error("command failed")),
        })
      })

      const error = yield* command
        .execute({
          name: "fail",
          invocation: {
            sessionID: Session.ID.make("ses_test"),
            prompt: { text: "" },
            delivery: "steer",
          },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "Command.ExecutionError", message: "command failed" })
    }),
  )
})
