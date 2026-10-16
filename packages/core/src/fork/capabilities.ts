export * as ForkCapabilities from "./capabilities/service.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { Session } from "@opencode/schema/session"
import { Effect, Layer } from "effect"
import { Agent } from "../agent.js"
import { Command } from "../command.js"
import { ConfigSkillReload } from "../config/skill-reload.js"
import { Permission } from "../permission.js"
import { Plugin } from "../plugin.js"
import { Skill } from "../skill.js"
import { SkillNotFoundError } from "../session/error.js"
import { ForkCapabilities } from "./capabilities/service.js"

const layer = Layer.effect(
  ForkCapabilities.Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const skills = yield* Skill.Service
    const plugins = yield* Plugin.Service
    const commands = yield* Command.Service
    const reload = yield* ConfigSkillReload.Service
    const snapshot = Effect.fn("ForkCapabilities.snapshot")(function* (input: { readonly session: Session.Info }) {
      yield* plugins.awaitActivation
      return yield* deriveSnapshot(input.session)
    })
    const deriveSnapshot = Effect.fn("ForkCapabilities.deriveSnapshot")(function* (session: Session.Info) {
      const selected = yield* agents.select(session.agent)
      if (!selected.info) return { skills: new Map() }
      const available = Skill.available(
        yield* skills.list(),
        Permission.merge(selected.info.permissions, session.permissions ?? []),
      )
      return { skills: new Map(available.map((skill) => [skill.id, { ...skill }])) }
    })
    return ForkCapabilities.Service.of({
      snapshot,
      get: Effect.fn("ForkCapabilities.get")(function* (input) {
        const skill = (yield* snapshot({ session: input.session })).skills.get(input.skill)
        if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
        return skill
      }),
      catalogue: Effect.fn("ForkCapabilities.catalogue")(function* (input) {
        yield* plugins.awaitActivation
        const explicit = yield* commands.list()
        const snapshot = yield* deriveSnapshot(input.session)
        const names = new Set(explicit.map((command) => command.name))
        const projected = Array.from(snapshot.skills.values())
          .filter((skill) => !names.has(skill.id))
          .toSorted((a, b) => a.id.localeCompare(b.id))
          .map((skill) => Command.Info.make({ name: skill.id, description: skill.description }))
        return [...explicit, ...projected]
      }),
      resolve: Effect.fn("ForkCapabilities.resolve")(function* (input) {
        yield* plugins.awaitActivation
        const explicit = yield* commands.list()
        const command = explicit.find((candidate) => candidate.name === input.command)
        if (command)
          return {
            type: "command" as const,
            definition: {
              name: command.name,
              description: command.description,
              execute: (invocation) => commands.execute({ name: command.name, invocation }),
            },
          }
        const snapshot = yield* deriveSnapshot(input.session)
        const skill = snapshot.skills.get(Skill.ID.make(input.command))
        if (skill) return { type: "skill" as const, skill, snapshot }
        return yield* new Command.NotFoundError({ command: input.command, message: `Command not found: ${input.command}` })
      }),
      reload: reload.reload,
    })
  }),
)

export const node = makeLocationNode({
  service: ForkCapabilities.Service,
  layer,
  deps: [Agent.node, Skill.node, Plugin.node, Command.node, ConfigSkillReload.node],
})
