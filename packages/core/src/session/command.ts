export * as SessionCommand from "./command.js"

import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { Effect } from "effect"
import { Command } from "../command.js"
import { ForkCapabilities } from "../fork/capabilities/service.js"
import type { Error as InstanceError } from "../instance.js"
import { Instance } from "../instance/service.js"

export const catalogue = Effect.fn("SessionCommand.catalogue")(function* (input: { session: Session.Info }) {
  const instances = yield* Instance.Service
  return yield* ForkCapabilities.Service.use((capability) => capability.catalogue(input)).pipe(instances.provide(input.session))
})

export const resolve = Effect.fn("SessionCommand.resolve")(function* (input: { session: Session.Info; command: string }) {
  const instances = yield* Instance.Service
  return yield* ForkCapabilities.Service.use((capability) => capability.resolve(input)).pipe(instances.provide(input.session))
})

export type ExecuteInput = {
  session: Session.Info
  command: string
  text: string
  files?: PromptInput.Prompt["files"]
  agents?: PromptInput.Prompt["agents"]
  skills?: PromptInput.Prompt["skills"]
  delivery?: SessionInbox.Delivery
}

export const execute = Effect.fn("SessionCommand.execute")(function* (input: ExecuteInput) {
  const resolved = yield* resolve({ session: input.session, command: input.command })
  if (resolved.type === "skill")
    return yield* new Command.NotFoundError({ command: input.command, message: `Command not found: ${input.command}` })
  yield* resolved.definition.execute({
    sessionID: input.session.id,
    prompt: { text: input.text, files: input.files, agents: input.agents, skills: input.skills },
    delivery: input.delivery ?? "steer",
  }).pipe(Effect.mapError((error) => new Command.ExecutionError({ command: input.command, message: errorMessage(error) })))
})

export const executeWithPrompt = <E, R>(
  input: ExecuteInput & {
    readonly prompt: (input: {
      readonly skills: PromptInput.Prompt["skills"]
      readonly snapshot: ForkCapabilities.Snapshot
    }) => Effect.Effect<void, E, R>
  },
): Effect.Effect<void, InstanceError | Command.NotFoundError | Command.ExecutionError | E, Instance.Service | R> =>
  Effect.gen(function* () {
    const resolved = yield* resolve({ session: input.session, command: input.command })
    if (resolved.type === "skill") {
      const skills = input.skills?.some((attachment) => attachment.id === resolved.skill.id)
        ? input.skills
        : [...(input.skills ?? []), { id: resolved.skill.id }]
      return yield* input.prompt({ skills, snapshot: resolved.snapshot })
    }
    yield* resolved.definition.execute({
      sessionID: input.session.id,
      prompt: { text: input.text, files: input.files, agents: input.agents, skills: input.skills },
      delivery: input.delivery ?? "steer",
    }).pipe(Effect.mapError((error) => new Command.ExecutionError({ command: input.command, message: errorMessage(error) })))
  })

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return "Command execution failed"
}
